// A run: the engine the settings name answers the user's message, with CODEX's own calls as its tools under the
// action policy, streaming to open pages as it goes and kept as a message once it ends. One run at a time per
// conversation, held in memory where the store runs.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { contexts_feature } from "../contexts/store.ts";
import { context_or_global } from "../contexts/model.ts";
import { engine_setting, is_hosted, type Engine, type EngineEvent, type EngineTurn } from "../engines/engine.ts";
import { recall_blueprints, recalled_part } from "../blueprints/recall.ts";
import { record_uses } from "../blueprints/records.ts";
import { new_id } from "../feature.ts";
import { type Presence } from "../policy/policy.ts";
import { mood_part, set_mood_tool, settle_reply_mood } from "../mood/mood.ts";
import { counts_of, local_screen, may_send, note_source, open_screen, taints, type Screen, type Screened } from "../privacy/screen.ts";
import { record_hosted_send } from "../privacy/store.ts";
import { settings_feature } from "../settings.ts";
import { tool_source_of } from "../tools/model.ts";
import { open_plugin_tools } from "../tools/offered.ts";
import { reply_ended, reply_started } from "./activity.ts";
import { assistant_host, type AssistantHost } from "./host.ts";
import { screened_instructions, sources_part } from "./instructions.ts";
import { declarations } from "../declared/current.ts";
import { add_message, list_messages } from "./messages.ts";
import { add_thinking, keep_thinking_setting, type ConversationMessage, type AssistantStatus, type EngineSummary, type RunState, type ThinkingPiece, type ToolCallRecord } from "./model.ts";
import { specialist_limits, stream_throttle, type Nest } from "./specialists.ts";
import { fill, prompts } from "../prompts/prompts.ts";
import { add_conversation_record, conversation_ids_in, conversation_row, has_conversation, summaries_of } from "./records.ts";
import { is_open as is_open_step, read_task_list, task_list_part } from "./task_list.ts";
import { engine_tools, open_collector_sources, plugin_tools_part, read_sources, run_guidance_part, type RunTool } from "./tools.ts";

// ── Engines ──────────────────────────────────────────────────────────────────

// The engine the settings name, else the one this computer's configuration starts with, or why there is none.
export async function find_engine(database: SqlDatabase): Promise<AssistantStatus & { running: Engine | null }> {
  const chosen = String(settings_feature.methods.get_settings(database)[engine_setting] ?? "") || (declarations().engine ?? "");
  const provided = (await open_plugin_host(database)).providers("engine");
  const engines: EngineSummary[] = provided.map(({ id, plugin_id, value }) => ({ id, plugin_id, label: value.label, model: value.model(), is_local: !is_hosted(value) }));
  const found = provided.find((each) => each.id === chosen);
  if (found) return { engine: engines.find((each) => each.id === chosen)!, problem: "", engines, running: found.value };
  const problem = chosen ? `The ${chosen} engine is not running; turn its plugin on under Settings → Assistant → Engine.` : "No engine is set up; choose one under Settings → Assistant → Engine.";
  return { engine: null, problem, engines, running: null };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// What a background job's run, or a task such as Suggest links, is given beyond a conversation's: who is present, the
// limits it stops at, the only tools it is offered, more instructions, and a note said when it ends.
export interface RunOptions {
  presence?: Presence;
  limits?: { max_rounds: number; max_tokens?: number };
  tools?: readonly string[];
  // More instructions put after the open context's, screened like them for the engine answering.
  instructions?: (screen: Screen) => Screened<string>;
  // A plain note on what the run did, shown with its answer.
  closing_note?: (calls: ToolCallRecord[]) => string;
  // Hears how the run ended, once it has been kept.
  on_end?: (end: RunEnd) => void;
  // A run built to hold no private data: its instructions are only `instructions`' own, it is given no earlier turn of
  // its conversation, no blueprint, no context and no mood, and its outside-sending tools are never refused for what it read.
  isolated?: boolean;
  // Tools of the run's own, offered beside those `tools` names.
  own_tools?: RunTool[];
  // The most calls to the tool plugins' tools in the run.
  max_plugin_calls?: number;
}

// How a run ended, for a background job's record.
export interface RunEnd {
  run_id: string;
  conversation_id: string;
  engine: string;
  model: string;
  rounds: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: ToolCallRecord[];
  error: string;
  // Which limit stopped it, if one did; or that it gave way to a live conversation.
  stopped_by: "" | "rounds" | "tokens" | "gave_way";
}

interface Run {
  conversation_id: string;
  presence: Presence;
  options: RunOptions;
  // Set when it was stopped for a reason of CODEX's own rather than the user's Stop.
  stopped_by: RunEnd["stopped_by"];
  // The model rounds and tokens so far, its specialists' included.
  usage: { rounds: number; input_tokens: number; output_tokens: number };
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

// Whether a reply the user is waiting for is being written anywhere here.
export function has_live_runs(): boolean {
  return [...runs.values()].some((run) => run.presence === "conversation");
}

// Stops every background run, which gives way to a live conversation and runs again at its next turn.
export function give_way(): void {
  for (const run of runs.values()) {
    if (run.presence !== "background") continue;
    run.stopped_by = "gave_way";
    run.abort.abort();
  }
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
  const what = message.role === "event" ? prompts.conversation.earlier_event : prompts.conversation.earlier_answer;
  return fill(prompts.conversation.earlier_withheld, { what, sources: held_back.map((source) => screen.label_of(source)).join(", ") });
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
      const text = message.role === "user" && events.length > 0 ? fill(prompts.conversation.since_last_answer, { events: events.join(" "), message: message.text }) : message.text;
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
// used one that is not a job's, or a new one when it has none; undefined for one still to be made.
function conversation_for(database: SqlDatabase, context_id: string | null, conversation_id: string | null | undefined): string | undefined {
  if (typeof conversation_id === "string" && conversation_id) return conversation_row(database, conversation_id).id;
  if (conversation_id === null) return undefined;
  return summaries_of(database, conversation_ids_in(database, context_id)).find((summary) => summary.job === null)?.id;
}

// Keeps the user's message, in a new conversation in the open context when asked or when there is none, and starts the
// engine on it, told about the context the user has open; answers at once, while the reply streams to open pages.
export async function start_run(database: SqlDatabase, context_id: string | null, text: string, asked?: string | null, options: RunOptions = {}): Promise<{ conversation_id: string; run_id: string }> {
  const host = assistant_host();
  const presence = options.presence ?? "conversation";
  if (!text.trim()) throw new Error("Write a message first.");
  context_id = context_or_global(context_id);
  // Fails on a context or conversation that does not exist, before anything is kept.
  screened_instructions(database, context_id, null, "", local_screen());
  const chosen = conversation_for(database, context_id, asked);
  // The user writing where a background job is running stops the job's run first, since the user goes first.
  const in_the_way = chosen !== undefined && presence === "conversation" ? runs.get(chosen) : undefined;
  if (in_the_way?.presence === "background") {
    give_way();
    await in_the_way.done;
  }
  if (chosen !== undefined && runs.has(chosen)) throw new Error("A reply is still being written here; stop it or wait for it first.");
  const found = await find_engine(database);
  if (!found.running || !found.engine) throw new Error(found.problem);
  const screen = await open_screen(database, is_hosted(found.running));
  // A hosted engine is told of no plugin tool it is not offered, one whose results would be withheld from it.
  const plugin_tools = (await open_plugin_tools(database)).filter((tool) => tool.enabled && (!options.tools || options.tools.includes(tool.name)) && may_send(screen, tool_source_of(tool.key)));
  if (chosen !== undefined && (runs.has(chosen) || !has_conversation(database, chosen))) throw new Error(runs.has(chosen) ? "A reply is still being written here; stop it or wait for it first." : `There is no conversation ${chosen}.`);
  const conversation_id = chosen ?? add_conversation_record(database, context_id);
  const isolated = options.isolated === true;
  // An isolated run is told only what its task gives it: no identity, date, context, blueprint or mood.
  const instructions: Screened<string> = isolated ? { value: "", sources: new Set(), withheld: new Map() } : screened_instructions(database, context_id, conversation_id, new Date().toISOString().slice(0, 10), screen);
  const extra = options.instructions?.(screen);
  for (const source of extra?.sources ?? []) instructions.sources.add(source);
  const summaries = isolated ? [] : await contexts_feature.methods.list_collectors(database);
  // The user's own approved blueprints that match the message, put in by CODEX itself; not fenced, and tainting nothing.
  const recalled = isolated ? [] : await recall_blueprints(database, context_id, text);
  const plugin_part = plugin_tools_part(plugin_tools, true);
  // A hosted engine is told of no source app it may not be sent.
  const collectors = (await open_collector_sources(database)).filter((source) => may_send(screen, source.id));
  const guidance = run_guidance_part(plugin_tools, isolated ? [] : collectors);
  // The mood colours tone only; its reason carries the sources of the reply that set it.
  const mood = !isolated && (!options.tools || options.tools.includes(set_mood_tool.name)) ? mood_part(database, screen, Date.now()) : null;
  for (const source of mood?.sources ?? []) instructions.sources.add(source);
  // A run neither isolated nor kept to a few named tools keeps the conversation's task list, and is told what an earlier
  // reply left open in it.
  const keeps_task_list = !isolated && !options.tools;
  const open_list = keeps_task_list ? task_list_part(read_task_list(database, conversation_id)) : "";
  // With specialists the plugin tools and their guidance are theirs, so the run's instructions leave them out.
  const told = (head: string, with_specialists: boolean) =>
    [head, extra?.value ?? "", isolated ? "" : sources_part(summaries, with_specialists), recalled.length > 0 ? recalled_part(recalled) : "", with_specialists ? "" : plugin_part, with_specialists ? "" : guidance, mood?.value ?? "", open_list].filter(Boolean).join("\n\n");
  // A conversation's run, whose CODEX calls may go to specialists, has instructions for that too, which say less of them.
  const with_specialists = options.tools ? undefined : told(screened_instructions(database, context_id, conversation_id, new Date().toISOString().slice(0, 10), screen, true).value, true);
  instructions.value = told(instructions.value, false);
  if (runs.has(conversation_id)) throw new Error("A reply is still being written here; stop it or wait for it first.");
  const question = add_message(database, { conversation_id, role: "user", text: text.trim(), sources: [] });
  const notices = recalled.map(({ row }) => `Recalled the blueprint “${row.title}” for this message.`);
  const state: RunState = { run_id: new_id(), engine: found.engine.label, model: found.engine.model, started_at: new Date().toISOString(), text: "", thinking: [], tool_calls: [], notices };
  record_uses(database, recalled.map(({ row }) => row.id), conversation_id, state.run_id);
  // A live conversation always goes first: a background run writing now stops and runs again later.
  if (presence === "conversation") give_way();
  const run: Run = { conversation_id, presence, options, stopped_by: "", usage: { rounds: 0, input_tokens: 0, output_tokens: 0 }, screen, abort: new AbortController(), state, done: Promise.resolve() };
  runs.set(conversation_id, run);
  reply_started();
  // An earlier answer replayed counts as reading its sources again, so one that drew on an untrusted source taints the run.
  const replayed = isolated ? { turns: [{ role: "user" as const, text: text.trim() }], sources: new Set<string>() } : screened_turns(database, conversation_id, screen);
  const tools = engine_tools({
    database: host.database,
    call: host.call,
    conversation_id,
    presence,
    has_outside_content: taints(screen, [...instructions.sources, ...replayed.sources]),
    screen,
    instruction_sources: [...instructions.sources],
    ...(options.tools ? { only: new Set(options.tools) } : {}),
    maker: { engine: found.engine.id, model: found.engine.model },
    engine_label: found.engine.label,
    plugin_tools,
    collectors,
    signal: run.abort.signal,
    asked_by: question.id,
    run_id: state.run_id,
    ...(options.own_tools ? { own_tools: options.own_tools } : {}),
    ...(options.max_plugin_calls !== undefined ? { max_plugin_calls: options.max_plugin_calls } : {}),
    ...(isolated ? { reads_nothing_private: true } : {}),
    task_list: keeps_task_list,
    specialists: {
      engine: found.running,
      user_message: text.trim(),
      max_rounds: Math.min(specialist_limits.max_rounds, options.limits?.max_rounds ?? specialist_limits.max_rounds),
      max_tool_calls: specialist_limits.max_tool_calls,
      on_usage: (input_tokens, output_tokens) => count_usage(run, input_tokens, output_tokens),
      nest: (ask_name, label) => nest_of(run, ask_name, label, host),
    },
    on_decided: (name, record) => note_decision(run, name, record),
  });
  const request = { instructions: instructions.value, ...(with_specialists ? { instructions_with_specialists: with_specialists } : {}), conversation: replayed.turns, tools, ...(options.limits ? { limits: { max_rounds: options.limits.max_rounds } } : {}) };
  run.done = drive(run, found.running.run(request, run.abort.signal), host);
  host.emit({ conversation_id, run_id: state.run_id, type: "started", engine: state.engine, model: state.model });
  for (const notice of notices) host.emit({ conversation_id, run_id: state.run_id, type: "notice", text: notice });
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

// The ask call being made under this name, whose specialist's calls go under it and reach open pages as it changes,
// its thinking and text streamed to them a few times a second.
function nest_of(run: Run, ask_name: string, label: string, host: AssistantHost): Nest | null {
  const call = run.state.tool_calls.findLast((each) => each.name === ask_name && each.outcome === "pending");
  if (!call) return null;
  const calls = (call.calls ??= []);
  const base = { conversation_id: run.conversation_id, run_id: run.state.run_id, call_id: call.id };
  // Its thinking is kept as it is sent, so a page loading the run meanwhile and the events after agree.
  const stream = stream_throttle((piece) => {
    if (piece.kind === "reasoning") call.thinking = add_thinking(call.thinking ?? [], piece.text, 0, piece.calls_before);
    host.emit({ ...base, type: piece.kind === "reasoning" ? "specialist_reasoning" : "specialist_text", text: piece.text, calls_before: piece.calls_before });
  });
  host.emit({ ...base, type: "specialist_started", label });
  return {
    calls,
    // A specialist's text is not kept, so its thinking is placed among its calls alone.
    thought: (text) => stream.add({ kind: "reasoning", text, calls_before: calls.length }),
    wrote: (text) => stream.add({ kind: "text", text, calls_before: calls.length }),
    // What streamed so far goes first, so the call sent after it already holds that thinking.
    changed: () => {
      stream.flush();
      host.emit({ conversation_id: run.conversation_id, run_id: run.state.run_id, type: "tool_result", call: structuredClone(call) });
    },
  };
}

// Counts one model round, the run's own or a specialist's, and stops the run at a background job's limits; true once stopped.
function count_usage(run: Run, input_tokens: number, output_tokens: number): boolean {
  const { usage } = run;
  const limits = run.options.limits;
  usage.input_tokens += input_tokens;
  usage.output_tokens += output_tokens;
  usage.rounds += 1;
  if (limits?.max_tokens !== undefined && usage.input_tokens + usage.output_tokens >= limits.max_tokens) run.stopped_by = "tokens";
  // The engine is asked to stop at the round limit; one that goes past it anyway is stopped here.
  else if (limits && usage.rounds > limits.max_rounds) run.stopped_by = "rounds";
  if (!run.stopped_by) return false;
  run.abort.abort();
  return true;
}

// Each call's place in the text as kept, which loses the streamed text's leading spaces.
export function placed_in(streamed: string, kept: string, calls: ToolCallRecord[]): ToolCallRecord[] {
  const lead = streamed.length - streamed.trimStart().length;
  return calls.map((call) => (call.text_at === undefined ? call : { ...call, text_at: Math.max(0, Math.min(kept.length, call.text_at - lead)) }));
}

// Each stretch of thinking's place in the text as kept, as for the calls.
export function thinking_placed_in(streamed: string, kept: string, thinking: ThinkingPiece[]): ThinkingPiece[] {
  const lead = streamed.length - streamed.trimStart().length;
  return thinking.map((piece) => ({ ...piece, text_at: Math.max(0, Math.min(kept.length, piece.text_at - lead)) }));
}

// The calls as kept without their specialists' thinking, for when the Keep thinking setting is off.
function without_thinking(calls: ToolCallRecord[]): ToolCallRecord[] {
  return calls.map(({ thinking: _thinking, ...call }) => (call.calls ? { ...call, calls: without_thinking(call.calls) } : call));
}

// Whether a reply's thinking is kept with it; on unless the user turned it off.
export function keeps_thinking(database: SqlDatabase): boolean {
  return settings_feature.methods.get_settings(database)[keep_thinking_setting] !== false;
}

async function drive(run: Run, events: AsyncIterable<EngineEvent>, host: AssistantHost): Promise<void> {
  const { conversation_id, state } = run;
  const base = { conversation_id, run_id: state.run_id };
  let final_text: string | null = null;
  let error = "";
  let error_detail = "";
  const limits = run.options.limits;
  try {
    for await (const event of events) {
      if (run.abort.signal.aborted) break;
      if (event.type === "text") {
        state.text += event.text;
        host.emit({ ...base, type: "text", text: event.text });
      } else if (event.type === "reasoning") {
        // Placed where the reply stands now, so each stretch shows where it happened.
        state.thinking = add_thinking(state.thinking, event.text, state.text.length, state.tool_calls.length);
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
        // A background job stops at its limits, whatever the engine would do next.
        if (count_usage(run, event.input_tokens, event.output_tokens)) break;
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
  const { rounds, input_tokens, output_tokens } = run.usage;
  // The engine's own round limit, when a job set it lower, counts as the job's limit.
  if (limits && !run.stopped_by && error && rounds >= limits.max_rounds) run.stopped_by = "rounds";
  const stops: Record<RunEnd["stopped_by"], string> = {
    "": "Stopped.",
    tokens: `Stopped: it reached its limit of ${(limits?.max_tokens ?? 0).toLocaleString("en")} tokens for one run.`,
    rounds: `Stopped: it reached its limit of ${limits?.max_rounds ?? 0} rounds for one run.`,
    gave_way: "Stopped to give way to a conversation; it runs again at its next turn.",
  };
  if (run.abort.signal.aborted || run.stopped_by) [error, error_detail] = [stops[run.stopped_by], ""];
  else if (final_text === null && !error) error = "The engine stopped without an answer.";
  // A reply cut short with steps still open says how to go on from where its task list stands.
  if (error && error !== "Stopped." && run.presence === "conversation" && !run.options.isolated && has_conversation(host.database(), conversation_id) && read_task_list(host.database(), conversation_id).some(is_open_step)) {
    error = `${error} Its task list keeps where it got to: send “carry on” to go on from there.`;
  }
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
    settle_reply_mood(host.database(), conversation_id, state.run_id, read_sources(run.screen));
    const closing = run.options.closing_note?.(state.tool_calls);
    if (closing) {
      state.notices.push(closing);
      host.emit({ ...base, type: "notice", text: closing });
    }
    const text = (final_text ?? state.text).trim();
    const keep = keeps_thinking(host.database());
    const calls = placed_in(state.text, text, state.tool_calls);
    add_message(host.database(), {
      conversation_id,
      role: "assistant",
      text,
      engine: state.engine,
      model: state.model,
      tool_calls: keep ? calls : without_thinking(calls),
      thinking: keep ? thinking_placed_in(state.text, text, state.thinking) : [],
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
    run.options.on_end?.({ run_id: state.run_id, conversation_id, engine: state.engine, model: state.model, rounds, input_tokens, output_tokens, tool_calls: state.tool_calls, error, stopped_by: run.stopped_by });
  }
}
