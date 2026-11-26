// A run: the engine the settings name answers the user's message, with CODEX's own calls as its tools under the
// action policy, streaming to open pages as it goes and kept as a message once it ends. One run at a time per
// conversation, held in memory where the store runs.

// ── Imports ──────────────────────────────────────────────────────────────────

import { input_schema, positional_args, type JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { engine_setting, is_hosted, type Engine, type EngineEvent, type EngineTools, type EngineTurn, type ToolOutcome } from "../engines/engine.ts";
import { untrusted_block } from "../engines/untrusted.ts";

import { new_id } from "../feature.ts";
import { is_read_only } from "../page_api.ts";
import { brings_outside_content, core_tools, decide, is_offered, level_of, offered_api, proposing_calls, type Presence } from "../policy/policy.ts";
import { clip_excerpt } from "../graph/writing.ts";
import type { ProposalRead } from "../policy/model.ts";
import { add_proposal } from "../policy/proposals.ts";
import { mark_before_change, undo_of_change } from "../policy/undo.ts";
import { sources_named, summarize_call } from "../policy/summaries.ts";
import { screen_result } from "../privacy/results.ts";
import { counts_of, local_screen, may_send, note_source, open_screen, taints, withheld_line, type Screen } from "../privacy/screen.ts";
import { record_hosted_send } from "../privacy/store.ts";
import { default_hits } from "../search/search.ts";
import { settings_feature } from "../settings.ts";
import { reply_ended, reply_started } from "./activity.ts";
import { assistant_host, type AssistantHost } from "./host.ts";
import { screened_instructions } from "./instructions.ts";
import { add_message, list_messages } from "./messages.ts";
import { type ConversationMessage, type AssistantStatus, type EngineSummary, type RunState, type ToolCallRecord } from "./model.ts";
import { add_conversation_record, conversation_ids_in, conversation_row, has_conversation, summaries_of } from "./records.ts";

// ── Engines ──────────────────────────────────────────────────────────────────

// The engine the settings name, or why there is none.
export async function find_engine(database: SqlDatabase): Promise<AssistantStatus & { running: Engine | null }> {
  const chosen = String(settings_feature.methods.get_settings(database)[engine_setting] ?? "");
  const provided = (await open_plugin_host(database)).providers("engine");
  const engines: EngineSummary[] = provided.map(({ id, plugin_id, value }) => ({ id, plugin_id, label: value.label, model: value.model(), is_local: !is_hosted(value) }));
  const found = provided.find((each) => each.id === chosen);
  if (found) return { engine: engines.find((each) => each.id === chosen)!, problem: "", engines, running: found.value };
  const problem = chosen ? `The ${chosen} engine is not running; turn its plugin on under Settings → Assistant → Engine.` : "No engine is set up; choose one under Settings → Assistant → Engine.";
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
  // The engine and model answering, which the graph's proposals record as their maker.
  maker?: { engine: string; model: string };
  // The user's message the run answers and the run's id, which its proposals carry as evidence.
  asked_by?: string;
  run_id?: string;
  // What the run has read so far, each read by its tool call, which a proposal carries as evidence.
  reads?: ProposalRead[];
  // Hears what the policy made of each call, in order, so it can be kept with the call; gives back the call's id.
  on_decided?: (name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id" | "undo">) => string | void;
}

// The sources whose content the run has read so far, by collector id, for what it keeps.
export function read_sources(screen: Screen): string[] {
  return [...screen.included.keys()].sort();
}

// A schema without its fields' descriptions, for the core set's brief definitions.
function brief_schema(schema: JsonSchema): JsonSchema {
  const brief: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (key === "properties" && value && typeof value === "object") brief[key] = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, field]) => [name, brief_schema(field)]));
    else if (key === "items" && value && typeof value === "object" && !Array.isArray(value)) brief[key] = brief_schema(value as JsonSchema);
    else brief[key] = value;
  }
  return brief;
}

// CODEX's offered calls as tools, each call through the policy: reads run, changes run, wait or are refused by level.
// The core set is the same calls, fewer and briefly described, for a model with a small context.
export function engine_tools(context: ToolContext): EngineTools {
  const definitions = Object.entries(offered_api).map(([name, spec]) => ({ name, description: spec.description, parameters: input_schema(spec) }));
  const core = Object.entries(core_tools)
    .filter(([name]) => is_offered(name))
    .map(([name, description]) => ({ name, description, parameters: brief_schema(input_schema(offered_api[name]!)) }));
  const reads = (context.reads ??= []);
  const decided = (name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id" | "undo">, outcome: ToolOutcome): ToolOutcome => {
    const call_id = context.on_decided?.(name, record);
    const read = reads.at(-1);
    if (call_id && read && read.name === name && !read.call_id) read.call_id = call_id;
    return outcome;
  };
  let hosted_screen: Screen | null = null;
  // A read's excerpt is kept only when every source it carried may leave this computer, as graph evidence is.
  const note_read = async (name: string, given: Record<string, unknown>, sources: Set<string>, text: string) => {
    const hosted = (hosted_screen ??= await open_screen(context.database(), true));
    const excerpt = [...sources].every((source) => may_send(hosted, source)) ? clip_excerpt(text) : "";
    reads.push({ call_id: "", name, arguments: given, sources: [...sources].sort(), excerpt });
  };
  const screen = (context.screen ??= local_screen());
  // Other apps' text is screened by source: a hosted engine is not sent what it may not see, and only a source not
  // marked trusted makes the run's later changes wait; what is left is fenced either way.
  const run = async (name: string, args: unknown[]): Promise<{ text: string; sources: Set<string>; plain: string }> => {
    // A search leaves out this conversation's own messages, the user's question among them.
    const sent = name === "search_index" ? [args[0], args[1] ?? null, args[2] ?? default_hits, context.conversation_id] : args;
    const value = await context.call(name, sent);
    if (!brings_outside_content(name)) return { text: as_text(value), sources: new Set(), plain: as_text(value) };
    const screened = screen_result(context.database(), screen, name, args, value);
    if (taints(screen, screened.sources)) context.has_outside_content = true;
    const text = as_text(screened.value);
    const shown = screened.sources.size > 0 ? untrusted_block(text) : text;
    const withheld = withheld_line(screen, screened.withheld, screened.withheld_kinds);
    return { text: withheld ? `${shown}\n${withheld}` : shown, sources: screened.sources, plain: text };
  };
  return {
    definitions,
    core,
    call: async (name, given) => {
      if (!is_offered(name)) return decided(name, { outcome: "refused" }, { result: `There is no tool named ${name}.`, is_error: true });
      let args: unknown[];
      try {
        args = positional_args(offered_api[name]!, given);
      } catch (error) {
        return decided(name, { outcome: "failed" }, { result: `Tool error: ${(error as Error).message}.`, is_error: true });
      }
      try {
        if (is_read_only(name)) {
          const read = await run(name, args);
          await note_read(name, given, read.sources, read.plain);
          return decided(name, { outcome: "ran" }, { result: read.text, is_error: false });
        }
        // A proposal to the graph waits for the user anyway, so it runs at once, carrying what the run has read.
        if (proposing_calls.has(name)) {
          const padded = [...args, ...Array.from({ length: Math.max(0, offered_api[name]!.params.length - args.length) }, () => undefined)];
          const maker = { engine: context.maker?.engine ?? "", model: context.maker?.model ?? "", sources: read_sources(screen) };
          return decided(name, { outcome: "ran" }, { result: (await run(name, [...padded, maker])).text, is_error: false });
        }
        const database = context.database();
        const decision = decide(level_of(database, name), context.presence, context.has_outside_content);
        if (decision.action === "refuse") return decided(name, { outcome: "refused" }, { result: `The user does not permit ${name}, so it was not run.`, is_error: true });
        if (decision.action === "propose") {
          const sources = [...new Set([...read_sources(screen), ...sources_named(database, given)])].sort();
          const evidence = { asked_by: context.asked_by ?? "", run_id: context.run_id ?? "", reads: structuredClone(reads) };
          const proposal = add_proposal(database, { conversation_id: context.conversation_id, method: name, arguments: given, summary: summarize_call(database, name, given), reason: decision.reason, sources, evidence });
          const why = decision.reason === "outside content" ? " because this conversation has read text from other apps" : "";
          return decided(
            name,
            { outcome: "proposed", proposal_id: proposal.id },
            { result: `Not done yet: this change waits for the user's approval${why}. Tell the user what you proposed; it is proposal ${proposal.id}.`, is_error: false },
          );
        }
        // Noted as it is made, so the user can undo it from the conversation.
        const summary = summarize_call(database, name, given);
        const mark = mark_before_change(database);
        const result = (await run(name, args)).text;
        return decided(name, { outcome: "ran", applied_by: "engine_auto", undo: undo_of_change(context.database(), mark, summary) }, { result, is_error: false });
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

// An answer or event as the engine may read it: whole when every source its run had read may reach this engine, or
// one line saying it was withheld and why; either way noted on the run's screen for its log. The user's own messages
// are theirs and always sent.
function screened_text(screen: Screen, message: ConversationMessage): string {
  if (message.role === "user") return message.text;
  const key = `message:${message.id}`;
  const held_back = message.sources.filter((source) => !may_send(screen, source));
  if (held_back.length === 0) {
    for (const source of message.sources) note_source(screen.included, source, key);
    return message.text;
  }
  for (const source of held_back) note_source(screen.withheld, source, key);
  const what = message.role === "event" ? "An earlier event" : "An earlier answer";
  const from = held_back.map((source) => screen.label_of(source)).join(", ");
  return `[${what} is withheld from this hosted engine: it drew on ${from}, which the user has not marked “May be sent to a hosted engine”.]`;
}

// The conversation so far as the engine reads it, with the sources of the earlier answers and events it is replayed,
// which count as read again: the user's messages and the answers, with what became of its proposals told at the start
// of the user's next message, and without failures.
export function screened_turns(database: SqlDatabase, conversation_id: string, screen: Screen = local_screen()): { turns: EngineTurn[]; sources: Set<string> } {
  const turns: EngineTurn[] = [];
  const sources = new Set<string>();
  let events: string[] = [];
  for (const raw of list_messages(database, conversation_id)) {
    const message = raw.text.trim() ? { ...raw, text: screened_text(screen, raw) } : raw;
    if (raw.role !== "user" && raw.text.trim() && raw.sources.every((source) => may_send(screen, source))) for (const source of raw.sources) sources.add(source);
    if (message.role === "event") events.push(message.text);
    else if (message.text.trim()) {
      const text = message.role === "user" && events.length > 0 ? `(Since your last answer: ${events.join(" ")})\n\n${message.text}` : message.text;
      if (message.role === "user") events = [];
      turns.push({ role: message.role, text });
    }
  }
  return { turns, sources };
}

export function turns_of(database: SqlDatabase, conversation_id: string, screen: Screen = local_screen()): EngineTurn[] {
  return screened_turns(database, conversation_id, screen).turns;
}

// The conversation a message goes to: the one named, a new one for null, or, left out, the context's most recently
// used one, or a new one when it has none; undefined for one still to be made.
function conversation_for(database: SqlDatabase, context_id: string | null, conversation_id: string | null | undefined): string | undefined {
  if (typeof conversation_id === "string" && conversation_id) return conversation_row(database, conversation_id).id;
  if (conversation_id === null) return undefined;
  return summaries_of(database, conversation_ids_in(database, context_id))[0]?.id;
}

// Keeps the user's message, in a new conversation in the open context when asked or when there is none, and starts the
// engine on it, told about the context the user has open; answers at once, while the reply streams to open pages.
export async function start_run(database: SqlDatabase, context_id: string | null, text: string, asked?: string | null): Promise<{ conversation_id: string; run_id: string }> {
  const host = assistant_host();
  if (!text.trim()) throw new Error("Write a message first.");
  // Fails on a context or conversation that does not exist, before anything is kept.
  screened_instructions(database, context_id, null, "", local_screen());
  const chosen = conversation_for(database, context_id, asked);
  if (chosen !== undefined && runs.has(chosen)) throw new Error("A reply is still being written here; stop it or wait for it first.");
  const found = await find_engine(database);
  if (!found.running || !found.engine) throw new Error(found.problem);
  const screen = await open_screen(database, is_hosted(found.running));
  if (chosen !== undefined && (runs.has(chosen) || !has_conversation(database, chosen))) throw new Error(runs.has(chosen) ? "A reply is still being written here; stop it or wait for it first." : `There is no conversation ${chosen}.`);
  const conversation_id = chosen ?? add_conversation_record(database, context_id);
  const instructions = screened_instructions(database, context_id, conversation_id, new Date().toISOString().slice(0, 10), screen);
  const question = add_message(database, { conversation_id, role: "user", text: text.trim(), sources: [] });
  const state: RunState = { run_id: new_id(), engine: found.engine.label, model: found.engine.model, started_at: new Date().toISOString(), text: "", reasoning: "", tool_calls: [], notices: [] };
  const run: Run = { conversation_id, screen, abort: new AbortController(), state, done: Promise.resolve() };
  runs.set(conversation_id, run);
  reply_started();
  // An earlier answer replayed counts as reading its sources again, so one that drew on an untrusted source taints the run.
  const replayed = screened_turns(database, conversation_id, screen);
  const tools = engine_tools({
    database: host.database,
    call: host.call,
    conversation_id,
    presence: "conversation",
    has_outside_content: taints(screen, [...instructions.sources, ...replayed.sources]),
    screen,
    maker: { engine: found.engine.id, model: found.engine.model },
    asked_by: question.id,
    run_id: state.run_id,
    on_decided: (name, record) => note_decision(run, name, record),
  });
  const request = { instructions: instructions.value, conversation: replayed.turns, tools };
  run.done = drive(run, found.running.run(request, run.abort.signal), host);
  host.emit({ conversation_id, run_id: state.run_id, type: "started", engine: state.engine, model: state.model });
  return { conversation_id, run_id: state.run_id };
}

// What the policy made of a call, kept with the call the engine announced under that name and not yet decided; gives
// back the call's id.
function note_decision(run: Run, name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id" | "undo">): string {
  const call = run.state.tool_calls.find((each) => each.name === name && each.outcome === "pending");
  if (call) {
    Object.assign(call, record);
    return call.id;
  }
  const id = `codex_${run.state.tool_calls.length + 1}`;
  run.state.tool_calls.push({ id, name, arguments: {}, result: "", is_error: false, text_at: run.state.text.length, ...record });
  return id;
}

// Each call's place in the text as kept, which loses the streamed text's leading spaces.
export function placed_in(streamed: string, kept: string, calls: ToolCallRecord[]): ToolCallRecord[] {
  const lead = streamed.length - streamed.trimStart().length;
  return calls.map((call) => (call.text_at === undefined ? call : { ...call, text_at: Math.max(0, Math.min(kept.length, call.text_at - lead)) }));
}

async function drive(run: Run, events: AsyncIterable<EngineEvent>, host: AssistantHost): Promise<void> {
  const { conversation_id, state } = run;
  const base = { conversation_id, run_id: state.run_id };
  let final_text: string | null = null;
  let error = "";
  let error_detail = "";
  let input_tokens = 0;
  let output_tokens = 0;
  try {
    for await (const event of events) {
      if (run.abort.signal.aborted) break;
      if (event.type === "text") {
        state.text += event.text;
        state.reasoning = "";
        host.emit({ ...base, type: "text", text: event.text });
      } else if (event.type === "reasoning") {
        // Shown to open pages while it streams, and dropped with the run.
        state.reasoning += event.text;
        host.emit({ ...base, type: "reasoning", text: event.text });
      } else if (event.type === "notice") {
        state.notices.push(event.text);
        host.emit({ ...base, type: "notice", text: event.text });
      } else if (event.type === "tool_call") {
        const call: ToolCallRecord = { id: event.id, name: event.name, arguments: event.arguments, result: "", is_error: false, outcome: "pending", text_at: state.text.length };
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
        error_detail = event.detail ?? "";
        break;
      }
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (run.abort.signal.aborted) [error, error_detail] = ["Stopped.", ""];
  else if (final_text === null && !error) error = "The engine stopped without an answer.";
  for (const call of state.tool_calls) if (call.outcome === "pending") call.outcome = "failed";
  // Gone before the pages hear of the end, so a page loading the conversation then finds the message and no run.
  runs.delete(conversation_id);
  reply_ended();
  if (run.screen.is_hosted) {
    try {
      const { screen } = run;
      record_hosted_send(host.database(), { run_id: state.run_id, conversation_id, engine: state.engine, model: state.model, included: counts_of(screen, screen.included), withheld: counts_of(screen, screen.withheld) });
    } catch (thrown) {
      console.warn("hosted log:", thrown);
    }
  }
  try {
    // A conversation deleted while its reply was written, on its own or with its last context, keeps nothing.
    if (!has_conversation(host.database(), conversation_id)) return;
    const text = (final_text ?? state.text).trim();
    add_message(host.database(), {
      conversation_id,
      role: "assistant",
      text,
      engine: state.engine,
      model: state.model,
      tool_calls: placed_in(state.text, text, state.tool_calls),
      error,
      error_detail,
      notices: state.notices,
      input_tokens,
      output_tokens,
      sources: read_sources(run.screen),
    });
  } finally {
    host.emit({ ...base, type: "finished", error, ...(error_detail ? { error_detail } : {}) });
    host.announce();
  }
}
