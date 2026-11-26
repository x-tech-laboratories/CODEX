// A run: the engine the settings name answers the user's message, with CODEX's own calls as its tools under the
// action policy, streaming to open pages as it goes and kept as a message once it ends. One run at a time per
// conversation, held in memory where the store runs.

// ── Imports ──────────────────────────────────────────────────────────────────

import { input_schema, positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { engine_setting, is_hosted, type Engine, type EngineEvent, type EngineTools, type EngineTurn, type ToolOutcome } from "../engines/engine.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { eq } from "@x-tech-laboratories/x-libs/drizzle";

import { contexts } from "../contexts/schema.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { is_read_only } from "../page_api.ts";
import { brings_outside_content, decide, is_offered, level_of, offered_api, type Presence } from "../policy/policy.ts";
import { add_proposal } from "../policy/proposals.ts";
import { summarize_call } from "../policy/summaries.ts";
import { screen_result } from "../privacy/results.ts";
import { counts_of, local_screen, open_screen, taints, withheld_line, type Screen } from "../privacy/screen.ts";
import { record_hosted_send } from "../privacy/store.ts";
import { settings_feature } from "../settings.ts";
import { assistant_host, type AssistantHost } from "./host.ts";
import { screened_instructions } from "./instructions.ts";
import { add_message, list_messages } from "./messages.ts";
import { conversation_id_of, general_conversation, type AssistantStatus, type EngineSummary, type RunState, type ToolCallRecord } from "./model.ts";

// ── Engines ──────────────────────────────────────────────────────────────────

// The engine the settings name, or why there is none.
export async function find_engine(database: SqlDatabase): Promise<AssistantStatus & { running: Engine | null }> {
  const chosen = String(settings_feature.methods.get_settings(database)[engine_setting] ?? "");
  const provided = (await open_plugin_host(database)).providers("engine");
  const engines: EngineSummary[] = provided.map(({ id, plugin_id, value }) => ({ id, plugin_id, label: value.label, model: value.model(), is_local: !is_hosted(value) }));
  const found = provided.find((each) => each.id === chosen);
  if (found) return { engine: engines.find((each) => each.id === chosen)!, problem: "", engines, running: found.value };
  const problem = chosen ? `The ${chosen} engine is not running; turn its plugin on under Settings → Plugins.` : "No engine is set up; choose one under Settings → Engine.";
  return { engine: null, problem, engines, running: null };
}

// ── Tools ────────────────────────────────────────────────────────────────────

// The longest tool result an engine is given, so one large search cannot crowd out the conversation.
export const max_result_chars = 12_000;

const cut_marker = "\n[Cut short to fit.]";

function as_text(value: unknown): string {
  const text = value === undefined ? "Done." : typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max_result_chars ? text.slice(0, max_result_chars - cut_marker.length) + cut_marker : text;
}

// What a run's tools need: where the store is, who is present, and what the run has read so far.
export interface ToolContext {
  database: () => SqlDatabase;
  call: AssistantHost["call"];
  conversation_id: string;
  presence: Presence;
  // Set once the run read text from a source not marked trusted; from then on every change asks first.
  has_outside_content: boolean;
  // What the engine may be sent of each source, and what it was; left out, a local engine with no source marked.
  screen?: Screen;
  // Hears what the policy made of each call, in order, so it can be kept with the call.
  on_decided?: (name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id">) => void;
}

// CODEX's offered calls as tools, each call through the policy: reads run, changes run, wait or are refused by level.
export function engine_tools(context: ToolContext): EngineTools {
  const definitions = Object.entries(offered_api).map(([name, spec]) => ({ name, description: spec.description, parameters: input_schema(spec) }));
  const decided = (name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id">, outcome: ToolOutcome): ToolOutcome => {
    context.on_decided?.(name, record);
    return outcome;
  };
  const screen = (context.screen ??= local_screen());
  // Other apps' text is screened by source: a hosted engine is not sent what it may not see, and only a source not
  // marked trusted makes the run's later changes wait; what is left is fenced either way.
  const run = async (name: string, args: unknown[]): Promise<string> => {
    const value = await context.call(name, args);
    if (!brings_outside_content(name)) return as_text(value);
    const screened = screen_result(context.database(), screen, name, args, value);
    if (taints(screen, screened.sources)) context.has_outside_content = true;
    const text = as_text(screened.value);
    const shown = screened.sources.size > 0 ? untrusted_block(text) : text;
    const withheld = withheld_line(screen, screened.withheld);
    return withheld ? `${shown}\n${withheld}` : shown;
  };
  return {
    definitions,
    call: async (name, given) => {
      if (!is_offered(name)) return decided(name, { outcome: "refused" }, { result: `There is no tool named ${name}.`, is_error: true });
      let args: unknown[];
      try {
        args = positional_args(offered_api[name]!, given);
      } catch (error) {
        return decided(name, { outcome: "failed" }, { result: `Tool error: ${(error as Error).message}.`, is_error: true });
      }
      try {
        if (is_read_only(name)) return decided(name, { outcome: "ran" }, { result: await run(name, args), is_error: false });
        const database = context.database();
        const decision = decide(level_of(database, name), context.presence, context.has_outside_content);
        if (decision.action === "refuse") return decided(name, { outcome: "refused" }, { result: `The user does not permit ${name}, so it was not run.`, is_error: true });
        if (decision.action === "propose") {
          const proposal = add_proposal(database, { conversation_id: context.conversation_id, method: name, arguments: given, summary: summarize_call(database, name, given), reason: decision.reason });
          const why = decision.reason === "outside content" ? " because this conversation has read text from other apps" : "";
          return decided(
            name,
            { outcome: "proposed", proposal_id: proposal.id },
            { result: `Not done yet: this change waits for the user's approval${why}. Tell the user what you proposed; it is proposal ${proposal.id}.`, is_error: false },
          );
        }
        return decided(name, { outcome: "ran", applied_by: "engine_auto" }, { result: await run(name, args), is_error: false });
      } catch (error) {
        return decided(name, { outcome: "failed" }, { result: `Tool error: ${(error as Error).message}`, is_error: true });
      }
    },
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

interface Run {
  conversation_id: string;
  // What the engine may be sent of each source, and what it was so far.
  screen: Screen;
  abort: AbortController;
  state: RunState;
  done: Promise<void>;
}

const runs = new Map<string, Run>();

export function run_state(conversation_id: string): RunState | null {
  const run = runs.get(conversation_id);
  return run ? structuredClone(run.state) : null;
}

export function is_running(conversation_id: string): boolean {
  return runs.has(conversation_id);
}

// Settles once every run going now has ended, for tests and for stopping cleanly.
export async function wait_for_runs(): Promise<void> {
  await Promise.all([...runs.values()].map((run) => run.done));
}

export function stop_run_of(conversation_id: string): boolean {
  const run = runs.get(conversation_id);
  run?.abort.abort();
  return run !== undefined;
}

export function stop_all_runs(): void {
  for (const run of runs.values()) run.abort.abort();
}

// The conversation so far as the engine reads it: the user's messages and the answers, with what became of its
// proposals told at the start of the user's next message, and without failures.
export function turns_of(database: SqlDatabase, conversation_id: string): EngineTurn[] {
  const turns: EngineTurn[] = [];
  let events: string[] = [];
  for (const message of list_messages(database, conversation_id)) {
    if (message.role === "event") events.push(message.text);
    else if (message.text.trim()) {
      const text = message.role === "user" && events.length > 0 ? `(Since your last answer: ${events.join(" ")})\n\n${message.text}` : message.text;
      if (message.role === "user") events = [];
      turns.push({ role: message.role, text });
    }
  }
  return turns;
}

// Keeps the user's message and starts the engine on it; answers at once, while the reply streams to open pages.
export async function start_run(database: SqlDatabase, context_id: string | null, text: string): Promise<{ run_id: string }> {
  const host = assistant_host();
  const conversation_id = conversation_id_of(context_id);
  if (!text.trim()) throw new Error("Write a message first.");
  if (runs.has(conversation_id)) throw new Error("A reply is still being written here; stop it or wait for it first.");
  // Fails on a context that does not exist, before anything is kept.
  screened_instructions(database, context_id || null, "", local_screen());
  const found = await find_engine(database);
  if (!found.running || !found.engine) throw new Error(found.problem);
  const screen = await open_screen(database, is_hosted(found.running));
  const instructions = screened_instructions(database, context_id || null, new Date().toISOString().slice(0, 10), screen);
  if (runs.has(conversation_id)) throw new Error("A reply is still being written here; stop it or wait for it first.");
  add_message(database, { conversation_id, role: "user", text: text.trim() });
  const state: RunState = { run_id: new_id(), engine: found.engine.label, model: found.engine.model, started_at: new Date().toISOString(), text: "", tool_calls: [] };
  const run: Run = { conversation_id, screen, abort: new AbortController(), state, done: Promise.resolve() };
  runs.set(conversation_id, run);
  const tools = engine_tools({
    database: host.database,
    call: host.call,
    conversation_id,
    presence: "conversation",
    has_outside_content: taints(screen, instructions.sources),
    screen,
    on_decided: (name, record) => note_decision(run, name, record),
  });
  const request = { instructions: instructions.value, conversation: turns_of(database, conversation_id), tools };
  run.done = drive(run, found.running.run(request, run.abort.signal), host);
  host.emit({ conversation_id, run_id: state.run_id, type: "started", engine: state.engine, model: state.model });
  return { run_id: state.run_id };
}

// What the policy made of a call, kept with the call the engine announced under that name and not yet decided.
function note_decision(run: Run, name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id">): void {
  const call = run.state.tool_calls.find((each) => each.name === name && each.outcome === "pending");
  if (call) Object.assign(call, record);
  else run.state.tool_calls.push({ id: `codex_${run.state.tool_calls.length + 1}`, name, arguments: {}, result: "", is_error: false, ...record });
}

async function drive(run: Run, events: AsyncIterable<EngineEvent>, host: AssistantHost): Promise<void> {
  const { conversation_id, state } = run;
  const base = { conversation_id, run_id: state.run_id };
  let final_text: string | null = null;
  let error = "";
  let input_tokens = 0;
  let output_tokens = 0;
  try {
    for await (const event of events) {
      if (run.abort.signal.aborted) break;
      if (event.type === "text") {
        state.text += event.text;
        host.emit({ ...base, type: "text", text: event.text });
      } else if (event.type === "tool_call") {
        const call: ToolCallRecord = { id: event.id, name: event.name, arguments: event.arguments, result: "", is_error: false, outcome: "pending" };
        state.tool_calls.push(call);
        host.emit({ ...base, type: "tool_call", call: { ...call } });
      } else if (event.type === "tool_result") {
        const call = state.tool_calls.find((each) => each.id === event.id);
        if (!call) continue;
        Object.assign(call, { result: event.result, is_error: event.is_error });
        if (call.outcome === "pending") call.outcome = event.is_error ? "failed" : "ran";
        host.emit({ ...base, type: "tool_result", call: { ...call } });
      } else if (event.type === "usage") {
        input_tokens += event.input_tokens;
        output_tokens += event.output_tokens;
      } else if (event.type === "done") {
        final_text = event.text;
        break;
      } else {
        error = event.message;
        break;
      }
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (run.abort.signal.aborted) error = "Stopped.";
  else if (final_text === null && !error) error = "The engine stopped without an answer.";
  for (const call of state.tool_calls) if (call.outcome === "pending") call.outcome = "failed";
  // Gone before the pages hear of the end, so a page loading the conversation then finds the message and no run.
  runs.delete(conversation_id);
  if (run.screen.is_hosted) {
    try {
      const { screen } = run;
      record_hosted_send(host.database(), { run_id: state.run_id, conversation_id, engine: state.engine, model: state.model, included: counts_of(screen, screen.included), withheld: counts_of(screen, screen.withheld) });
    } catch (thrown) {
      console.warn("hosted log:", thrown);
    }
  }
  try {
    // A context removed while its reply was written keeps no conversation.
    if (conversation_id !== general_conversation && !drizzle_of(host.database()).select({ id: contexts.id }).from(contexts).where(eq(contexts.id, conversation_id)).get()) return;
    add_message(host.database(), {
      conversation_id,
      role: "assistant",
      text: (final_text ?? state.text).trim(),
      engine: state.engine,
      model: state.model,
      tool_calls: state.tool_calls,
      error,
      input_tokens,
      output_tokens,
    });
  } finally {
    host.emit({ ...base, type: "finished", error });
    host.announce();
  }
}
