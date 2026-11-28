// The tools a run hands its engine: CODEX's own calls under the action policy, the plugins' tools, the specialists
// that stand for groups of them, and the task list, each use screened and recorded.

// ── Imports ──────────────────────────────────────────────────────────────────

import { input_schema, positional_args, type JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { stored_guidance } from "../guidance/store.ts";
import { type EngineTools, type ToolOutcome } from "../engines/engine.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { is_read_only } from "../page_api.ts";
import { approval_only_calls, brings_outside_content, core_tools, decide, engine_page_sizes, is_offered, level_of, offered_api, proposing_calls, type Decision, type Presence } from "../policy/policy.ts";
import { clip_excerpt } from "../graph/writing.ts";
import { engine_set_mood, set_mood_brief, set_mood_tool } from "../mood/mood.ts";
import type { ProposalRead } from "../policy/model.ts";
import { add_proposal } from "../policy/proposals.ts";
import { mark_before_change, undo_of_change } from "../policy/undo.ts";
import { sources_named, summarize_call } from "../policy/summaries.ts";
import { screen_result } from "../privacy/results.ts";
import { has_read_private, is_trusted, local_screen, may_send, note_source, open_screen, taints, withheld_line, type Screen } from "../privacy/screen.ts";
import { record_tool_send } from "../privacy/store.ts";
import { default_hits } from "../search/search.ts";
import { namespace_mark, tool_source_of } from "../tools/model.ts";
import { run_tool, type OpenedTool } from "../tools/offered.ts";
import { type AssistantHost } from "./host.ts";
import { own_collectors, work_line } from "./instructions.ts";
import { declarations } from "../declared/current.ts";
import { mcp_key_of } from "../mcp/model.ts";
import { type ToolCallRecord } from "./model.ts";
import { ask_definition, collector_groups, collector_read_calls, guidance_part, linked_keys, note_nested, own_groups, run_specialist, specialist_groups, specialist_limits, specialist_request, type CollectorSource, type Nest, type SpecialistGroup, type SpecialistHost } from "./specialists.ts";
import { fill, prompts } from "../prompts/prompts.ts";
import { read_kept, read_result_name, read_result_tool, result_id, shown_result, type KeptResult, type KeptResults } from "./results.ts";
import { calls_before_nudge, engine_set_answer, no_list_reminder, read_task_list, set_task_list_brief, set_task_list_tool, task_list_part, task_list_reminder, type TaskStep } from "./task_list.ts";

// ── Tools ────────────────────────────────────────────────────────────────────


function as_text(value: unknown): string {
  return value === undefined ? "Done." : typeof value === "string" ? value : JSON.stringify(value);
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
  // The sources whose items its instructions listed, which a proposal names as what it came from.
  instruction_sources?: string[];
  // The only calls this run is offered, for a task that needs few; every offered call when left out.
  only?: ReadonlySet<string>;
  // The tool plugins' tools turned on, each run through the same wrapper as CODEX's own calls.
  plugin_tools?: OpenedTool[];
  // Stops a plugin tool's call when the run is stopped.
  signal?: AbortSignal;
  // The engine's label, which the hosted log names beside each use of a tool that sends outside.
  engine_label?: string;
  // Tools of the run's own, handled by the task that started it rather than as CODEX's calls, such as a research run's
  // saving of a finding; each changes nothing of the user's, so it runs at once.
  own_tools?: RunTool[];
  // Set for a run built to hold no private data, so its tools that send outside are never refused for what it read.
  reads_nothing_private?: boolean;
  // The most calls to the tool plugins' tools in this run, its specialists' included; left out, no limit.
  max_plugin_calls?: number;
  // The tool plugin calls made so far, shared with the run's specialists so the limit counts them all.
  used?: { plugin_calls: number };
  // The most plugin tool calls in this run alone, for a specialist's; left out, no limit beyond max_plugin_calls.
  max_calls_here?: number;
  // Set for a run whose tool plugins may each go to a specialist: what asking one needs. A specialist's own tools
  // leave it out, so a specialist never asks another.
  specialists?: SpecialistHost;
  // The source apps the run may read, each of which may go to a specialist of its own beside the tool plugins'.
  collectors?: CollectorSource[];
  // Set for a source app's specialist: the collector every read call it makes reads, whatever it names.
  bound_collector?: string;
  // Hears what the policy made of each call, in order, so it can be kept with the call; gives back the call's id.
  on_decided?: (name: string, record: Pick<ToolCallRecord, "outcome" | "applied_by" | "proposal_id" | "undo">) => string | void;
  // Each call's whole result by call id, for read_tool_result; a specialist's context has its own.
  results?: KeptResults;
  // Set once a specialist's call was refused for its limit of tool calls.
  hit_call_limit?: boolean;
  // Set for a run that keeps the conversation's task list, offered set_task_list and reminded of the list
  // after each call; a specialist's leaves it out.
  task_list?: boolean;
}

// A tool of a run's own: what the engine is shown, and what it does, answering in words.
export interface RunTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  call(given: Record<string, unknown>, run: { run_id: string; conversation_id: string }): { text: string; is_error: boolean };
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

// A call's schema without the collector it reads, for a source app's specialist, whose collector is bound.
function without_collector(schema: JsonSchema): JsonSchema {
  const properties = { ...(schema.properties as Record<string, JsonSchema> | undefined) };
  delete properties.collector;
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((name) => name !== "collector") : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

// The longest description a plugin tool is shown with, and in the core set.
export const longest_tool_description = 1000;
const longest_brief_description = 120;

function clipped(text: string, most: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
}

// A plugin tool as the engine is shown it: its plugin's description, fenced as outside data unless the plugin's author
// wrote it, then what it does that the user cares about.
function plugin_description(tool: OpenedTool, most: number): string {
  const said = clipped(tool.tool.description, most) || "No description.";
  const described = tool.own_words ? said : `${tool.label} describes it, in its own words:\n${untrusted_block(said)}`;
  const facts = [tool.tool.changes ? "It changes something, so it may wait for the user's approval." : "", tool.tool.sends_outside ? "It sends its arguments outside this computer." : ""].filter(Boolean);
  return [`From the ${tool.label} plugin. ${described}`, ...facts].join(" ");
}

// A plugin tool's call in plain words for the user deciding on it, such as: Use the Web plugin's web_fetch with url “…”.
export function plugin_tool_summary(tool: Pick<OpenedTool, "label" | "tool">, given: Record<string, unknown>): string {
  const parts = Object.entries(given).map(([key, value]) => `${key} ${typeof value === "string" ? `“${clipped(value, 160)}”` : clipped(JSON.stringify(value) ?? "", 160)}`);
  return `Use the ${tool.label} plugin's ${tool.tool.name}${parts.length > 0 ? ` with ${parts.join(", ")}` : ""}.`;
}

// The plugin tools offered, as a line for the instructions: what they are, and what never to send through them.
export function plugin_tools_part(tools: OpenedTool[], asks = false): string {
  if (tools.length === 0) return "";
  const lines = [prompts.plugins.fenced];
  if (asks) lines.push(prompts.plugins.asks);
  const outside = tools.filter((tool) => tool.tool.sends_outside);
  if (outside.length > 0) lines.push(fill(prompts.plugins.sends_outside, { names: outside.map((tool) => tool.name).join(", ") }));
  return lines.join("\n");
}

// CODEX's offered calls as tools, each call through the policy: reads run, changes run, wait or are refused by level.
// The core set is the same calls, fewer and briefly described, for a model with a small context. The tool plugins'
// tools turned on come after, through the same wrapper; the core set takes only those the user offers small models.
export function engine_tools(context: ToolContext): EngineTools {
  const { only } = context;
  const offered = (name: string) => is_offered(name) && (!only || only.has(name));
  const screen = (context.screen ??= local_screen());
  // A hosted engine is not offered a plugin's tools when what they give back would be withheld from it.
  const plugin_tools = new Map(
    (context.plugin_tools ?? []).filter((tool) => tool.enabled && (!only || only.has(tool.name)) && may_send(screen, tool_source_of(tool.key))).map((tool) => [tool.name, tool]),
  );
  const bound = context.bound_collector;
  const definitions = [
    ...Object.entries(offered_api)
      .filter(([name]) => !only || only.has(name))
      .map(([name, spec]) => ({ name, description: spec.description, parameters: bound !== undefined && collector_read_calls.has(name) ? without_collector(input_schema(spec)) : input_schema(spec) })),
    ...(!only || only.has(set_mood_tool.name) ? [{ name: set_mood_tool.name, description: set_mood_tool.description, parameters: set_mood_tool.parameters as JsonSchema }] : []),
    ...(context.own_tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    ...[...plugin_tools.values()].map((tool) => ({ name: tool.name, description: plugin_description(tool, longest_tool_description), parameters: tool.tool.parameters })),
    ...(context.task_list ? [{ name: set_task_list_tool.name, description: set_task_list_tool.description, parameters: set_task_list_tool.parameters as JsonSchema }] : []),
    read_result_tool,
  ];
  // Each part of CODEX's own calls behind one ask_ tool, each plugin's tools behind another and each source app's read
  // calls, with the tools of the MCP server linked to it, behind a third kind, which the engine offers in their place
  // when its Specialists setting says; a hosted engine gets none for a source it may not be sent. A run offered few
  // calls keeps CODEX's own as they are.
  const taken = new Set<string>();
  const sendable = (context.collectors ?? []).filter((source) => may_send(screen, source.id));
  const linked = linked_keys(sendable);
  const plugin_groups = context.specialists ? specialist_groups([...plugin_tools.values()].filter((tool) => !linked.has(tool.key)), taken) : [];
  const source_groups = context.specialists ? collector_groups(sendable, offered, taken, [...plugin_tools.values()]) : [];
  const codex_groups = context.specialists && !only ? own_groups(offered, source_groups.length > 0 ? collector_read_calls : new Set()) : [];
  const groups = [...codex_groups, ...plugin_groups, ...source_groups];
  const asks = new Map(groups.map((group) => [group.name, group]));
  const own_moved = new Set(codex_groups.flatMap((group) => group.own!.calls));
  // What the ask_ tools stand for: CODEX's own calls, the plugin tools, and the collector read calls once any source app
  // has a specialist.
  const moved = (name: string) => own_moved.has(name) || plugin_tools.has(name) || (source_groups.length > 0 && collector_read_calls.has(name));
  // A run offered few calls gets them fully described, which the core set would not shorten much.
  const core = only
    ? undefined
    : [
        ...Object.entries(core_tools)
          .filter(([name]) => is_offered(name))
          .map(([name, description]) => ({ name, description, parameters: brief_schema(input_schema(offered_api[name]!)) })),
        { name: set_mood_tool.name, description: set_mood_brief, parameters: brief_schema(set_mood_tool.parameters as JsonSchema) },
        ...(context.task_list ? [{ name: set_task_list_tool.name, description: set_task_list_brief, parameters: brief_schema(set_task_list_tool.parameters as JsonSchema) }] : []),
        read_result_tool,
        ...[...plugin_tools.values()]
          .filter((tool) => tool.small)
          .map((tool) => ({ name: tool.name, description: plugin_description(tool, longest_brief_description), parameters: brief_schema(tool.tool.parameters) })),
      ];
  // A source app's ask says to have what it finds added by the contexts' specialist when that has add_item.
  const adder = codex_groups.find((group) => group.own!.calls.includes("add_item"))?.name ?? "";
  const ask_definitions = groups.map((group) => ask_definition(group, adder));
  const specialists =
    groups.length > 0
      ? {
          definitions: [...definitions.filter((definition) => !moved(definition.name)), ...ask_definitions],
          ...(core ? { core: [...core.filter((definition) => !moved(definition.name)), ...ask_definitions] } : {}),
          delegated: definitions.filter((definition) => moved(definition.name)),
        }
      : undefined;
  const reads = (context.reads ??= []);
  const results = (context.results ??= new Map());
  // Keeps a result whole under its call id and gives what the engine is shown of it.
  const keep = (id: string, kept: KeptResult): string => {
    results.set(id, kept);
    return shown_result(id, kept);
  };
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
  // Other apps' text is screened by source: a hosted engine is not sent what it may not see, and only a source not
  // marked trusted makes the run's later changes wait; what is left is fenced either way.
  const run = async (id: string, name: string, args: unknown[]): Promise<{ text: string; sources: Set<string>; plain: string }> => {
    // A search leaves out this conversation's own messages, the user's question among them.
    const sent = name === "search_index" ? [args[0], args[1] ?? null, args[2] ?? default_hits, context.conversation_id] : args;
    const value = await context.call(name, sent, "engine");
    if (!brings_outside_content(name)) return { text: keep(id, { name, text: as_text(value), fenced: false, sources: new Set(), taints: false }), sources: new Set(), plain: as_text(value) };
    const screened = screen_result(context.database(), screen, name, args, value);
    const tainted = taints(screen, screened.sources);
    if (tainted) context.has_outside_content = true;
    const text = as_text(screened.value);
    const shown = keep(id, { name, text, fenced: screened.sources.size > 0, sources: screened.sources, taints: tainted });
    const withheld = withheld_line(screen, screened.withheld, screened.withheld_kinds);
    return { text: withheld ? `${shown}\n${withheld}` : shown, sources: screened.sources, plain: text };
  };
  const used = (context.used ??= { plugin_calls: 0 });
  let uses_here = 0;
  // A plugin tool's answer is always outside data: fenced, counted as its plugin's source, and lowering the run unless
  // the plugin is marked trusted. A use of one that sends outside is kept in the hosted log, never its arguments.
  const use_plugin_tool = async (id: string, tool: OpenedTool, given: Record<string, unknown>): Promise<{ text: string; plain: string; sources: Set<string> }> => {
    if (tool.tool.sends_outside) {
      record_tool_send(context.database(), {
        run_id: context.run_id ?? "",
        conversation_id: context.conversation_id,
        engine: context.engine_label ?? context.maker?.engine ?? "",
        model: context.maker?.model ?? "",
        tool: `${tool.label}: ${tool.tool.name}`,
        args: given,
      });
    }
    const answer = await run_tool(tool, given, context.signal ?? new AbortController().signal);
    const source = tool_source_of(tool.key);
    used.plugin_calls += 1;
    uses_here += 1;
    note_source(screen.included, source, `${tool.name}#${used.plugin_calls}`);
    if (!tool.marks.trusted) context.has_outside_content = true;
    const plain = as_text(answer);
    return { text: keep(id, { name: tool.name, text: plain, fenced: true, sources: new Set([source]), taints: !tool.marks.trusted }), plain, sources: new Set([source]) };
  };
  const call_plugin_tool = async (id: string, tool: OpenedTool, given: Record<string, unknown>): Promise<ToolOutcome> => {
    const name = tool.name;
    if (!given || typeof given !== "object" || Array.isArray(given)) return decided(name, { outcome: "failed" }, { result: prompts.tool_results.not_an_object, is_error: true });
    const required = Array.isArray(tool.tool.parameters.required) ? (tool.tool.parameters.required as unknown[]).map(String) : [];
    const missing = required.filter((field) => given[field] === undefined);
    if (missing.length > 0) return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.missing_argument, { names: missing.join(", ") }), is_error: true });
    if (context.max_plugin_calls !== undefined && used.plugin_calls >= context.max_plugin_calls) {
      return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.plugin_limit, { count: context.max_plugin_calls }), is_error: true });
    }
    if (context.max_calls_here !== undefined && uses_here >= context.max_calls_here) {
      context.hit_call_limit = true;
      return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.specialist_limit, { count: context.max_calls_here }), is_error: true });
    }
    // What the run has read of a source the user keeps from hosted engines never leaves through a tool either.
    if (tool.tool.sends_outside && !tool.marks.after_private && !context.reads_nothing_private && has_read_private(screen)) {
      return decided(
        name,
        { outcome: "refused" },
        {
          result: fill(prompts.tool_results.private_then_outside, { name, label: tool.label }),
          is_error: true,
        },
      );
    }
    try {
      if (!tool.tool.changes) {
        const read = await use_plugin_tool(id, tool, given);
        await note_read(name, given, read.sources, read.plain);
        return decided(name, { outcome: "ran" }, { result: read.text, is_error: false });
      }
      const database = context.database();
      const decision = decide(level_of(database, name), context.presence, context.has_outside_content);
      if (decision.action === "refuse") return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.not_permitted, { name }), is_error: true });
      const summary = plugin_tool_summary(tool, given);
      if (decision.action === "propose") {
        const sources = read_sources(screen);
        const seen = [...new Set([...(context.instruction_sources ?? []), ...reads.flatMap((read) => read.sources)])].sort();
        const evidence = { asked_by: context.asked_by ?? "", run_id: context.run_id ?? "", reads: structuredClone(reads), seen };
        const proposal = add_proposal(database, { conversation_id: context.conversation_id, method: name, arguments: given, summary, reason: decision.reason, sources, evidence });
        const waits = decision.reason === "outside content" ? prompts.tool_results.waits_for_approval_outside : prompts.tool_results.waits_for_approval;
        return decided(
          name,
          { outcome: "proposed", proposal_id: proposal.id },
          { result: fill(waits, { id: proposal.id }), is_error: false },
        );
      }
      const mark = mark_before_change(database);
      const result = (await use_plugin_tool(id, tool, given)).text;
      return decided(name, { outcome: "ran", applied_by: "engine_auto", undo: undo_of_change(context.database(), mark, summary) }, { result, is_error: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.error_from, { label: tool.label, message: untrusted_block(message) }), is_error: true });
    }
  };
  let asked = 0;
  // A specialist runs the same engine with only its part of CODEX's calls, its plugin's tools or its source app's read
  // calls, through this same wrapper with the run's screen, reads and limits; its answer is fenced as outside data, and
  // a plugin's or app's lowers the run unless it is trusted.
  const ask_specialist = async (id: string, group: SpecialistGroup, given: Record<string, unknown>): Promise<ToolOutcome> => {
    const host = context.specialists!;
    const name = group.name;
    const request = given && typeof given === "object" && typeof given.request === "string" ? given.request.trim() : "";
    if (!request) return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.missing_argument, { names: "request" }), is_error: true });
    const nest: Nest = host.nest?.(name, group.label) ?? { calls: [], thought: () => undefined, wrote: () => undefined, changed: () => undefined };
    const child: ToolContext = {
      ...context,
      only: new Set(group.own ? group.own.calls : [...(group.collector?.calls ?? []), ...group.tools.map((tool) => tool.name)]),
      plugin_tools: group.tools,
      own_tools: [],
      collectors: [],
      max_calls_here: host.max_tool_calls ?? specialist_limits.max_tool_calls,
      on_decided: (called, record) => note_nested(nest, called, record),
      results: new Map(),
      hit_call_limit: false,
    };
    delete child.specialists;
    if (group.collector) child.bound_collector = group.collector.id;
    const tools = engine_tools(child);
    const signal = context.signal ?? new AbortController().signal;
    // A specialist doing the job keeps the conversation's task list too, told what it holds so far.
    const list_part = child.task_list ? [work_line, task_list_part(read_task_list(context.database(), context.conversation_id))].filter(Boolean).join("\n\n") : "";
    const answer = await run_specialist(host, specialist_request(group, host, request, tools, group.tools.length > 0 ? plugin_tools_part(group.tools) : "", list_part), signal, nest);
    // What the specialist read lowers this run as it lowered the specialist's, and a plugin's or app's answer counts as
    // that plugin's or app's; CODEX's own specialists' reads are already noted by their sources.
    if (child.has_outside_content) context.has_outside_content = true;
    asked += 1;
    const source = group.own ? "" : group.collector ? group.collector.id : tool_source_of(group.key);
    const untrusted_answer = source !== "" && !((!group.collector || is_trusted(screen, group.collector.id)) && group.tools.every((tool) => tool.marks.trusted));
    if (source) note_source(screen.included, source, `${name}#${asked}`);
    if (untrusted_answer) context.has_outside_content = true;
    const kept_answer = (text: string) => keep(id, { name, text, fenced: true, sources: new Set(source ? [source] : []), taints: untrusted_answer || child.has_outside_content === true });
    // A specialist that ran out of calls or rounds hands back what it did, for the run to ask again for the rest.
    const max_rounds = host.max_rounds ?? specialist_limits.max_rounds;
    const words = prompts.specialists;
    const limit = child.hit_call_limit ? fill(words.stopped_at_calls, { count: child.max_calls_here ?? 0 }) : answer.error && answer.rounds >= max_rounds ? fill(words.stopped_at_rounds, { count: max_rounds }) : "";
    if (limit) {
      const done = nest.calls.filter((call) => call.outcome === "ran" || call.outcome === "proposed").map((call) => `- ${call.name} ${clipped(JSON.stringify(call.arguments) ?? "", 200)}: ${call.outcome}`);
      const body = [done.length > 0 ? fill(words.stopped_calls, { calls: done.join("\n") }) : words.stopped_no_calls, answer.text ? fill(words.stopped_wrote, { text: answer.text }) : words.stopped_wrote_nothing].join("\n");
      const told = fill(words.stopped, { label: group.label, limit });
      return decided(name, { outcome: "ran" }, { result: `${told}\n${kept_answer(body)}`, is_error: false });
    }
    if (answer.error) {
      const partial = answer.text ? `\n${fill(words.wrote_before_stopping, { text: kept_answer(answer.text) })}` : "";
      return decided(name, { outcome: "failed" }, { result: `${fill(words.could_not_finish, { label: group.label, error: answer.error })}${partial}`, is_error: true });
    }
    return decided(name, { outcome: "ran" }, { result: kept_answer(answer.text || words.no_answer), is_error: false });
  };
  // A slice of a result this context kept, which lowers the run and counts as a read just as the call that gave it did.
  const read_result = async (given: Record<string, unknown>): Promise<ToolOutcome> => {
    const read = read_kept(results, given);
    if (read.kept) {
      if (read.kept.taints) context.has_outside_content = true;
      await note_read(read_result_name, given, new Set(read.kept.sources), read.slice ?? "");
    }
    return decided(read_result_name, { outcome: read.is_error ? "failed" : "ran" }, { result: read.text, is_error: read.is_error });
  };
  // One call by its name, its result kept under its id.
  const call_tool = async (id: string, name: string, given: Record<string, unknown>): Promise<ToolOutcome> => {
    const plugin_tool = plugin_tools.get(name);
    if (plugin_tool) return call_plugin_tool(id, plugin_tool, given);
    const group = asks.get(name);
    if (group) return ask_specialist(id, group, given);
    const own_tool = context.own_tools?.find((tool) => tool.name === name);
    if (own_tool) {
      try {
        const answer = own_tool.call(given && typeof given === "object" && !Array.isArray(given) ? given : {}, { run_id: context.run_id ?? "", conversation_id: context.conversation_id });
        return decided(name, { outcome: answer.is_error ? "failed" : "ran" }, { result: answer.text, is_error: answer.is_error });
      } catch (error) {
        return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.error, { message: (error as Error).message }), is_error: true });
      }
    }
    // The task list changes nothing of the user's, so it is kept at once, through the store so open pages show it.
    if (context.task_list && name === set_task_list_tool.name) {
      try {
        const kept = (await context.call("set_conversation_task_list", [context.conversation_id, given && typeof given === "object" ? (given as Record<string, unknown>).steps : undefined], "engine")) as TaskStep[];
        return decided(name, { outcome: "ran" }, { result: engine_set_answer(kept), is_error: false });
      } catch (error) {
        return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.error_as_said, { message: (error as Error).message }), is_error: true });
      }
    }
    // The mood changes nothing of the user's, so it is kept at once, with the call recorded in the reply.
    if (name === set_mood_tool.name && (!only || only.has(name))) {
      const set = engine_set_mood(context.database(), given && typeof given === "object" ? given : {}, { conversation_id: context.conversation_id, run_id: context.run_id ?? "", sources: read_sources(screen) }, Date.now());
      return decided(name, { outcome: set.is_error ? "failed" : "ran" }, { result: set.text, is_error: set.is_error });
    }
    if (!offered(name)) return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.no_such_tool, { name }), is_error: true });
    let args: unknown[];
    try {
      // A source app's specialist reads its own collector, whichever it named.
      const named = bound !== undefined && collector_read_calls.has(name) && given && typeof given === "object" ? { ...given, collector: bound } : given;
      args = positional_args(offered_api[name]!, named);
      // A list read a page at a time gives an engine a small page when it names no limit.
      const page = engine_page_sizes[name];
      const limit_at = page ? offered_api[name]!.params.findIndex((param) => param.name === page.param) : -1;
      if (page && limit_at >= 0 && typeof args[limit_at] !== "number") {
        while (args.length < limit_at) args.push(undefined);
        args[limit_at] = page.size;
      }
    } catch (error) {
      return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.error, { message: (error as Error).message }), is_error: true });
    }
    // A specialist's calls of CODEX's own count toward its limit as its plugin tool calls do.
    if (context.max_calls_here !== undefined) {
      if (uses_here >= context.max_calls_here) {
        context.hit_call_limit = true;
        return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.specialist_limit, { count: context.max_calls_here }), is_error: true });
      }
      uses_here += 1;
    }
    try {
      if (is_read_only(name)) {
        const read = await run(id, name, args);
        await note_read(name, given, read.sources, read.plain);
        return decided(name, { outcome: "ran" }, { result: read.text, is_error: false });
      }
      // A proposal to the graph or a blueprint waits for the user anyway, so it runs at once, carrying what the run has read.
      if (proposing_calls.has(name)) {
        const padded = [...args, ...Array.from({ length: Math.max(0, offered_api[name]!.params.length - args.length) }, () => undefined)];
        const maker = { engine: context.maker?.engine ?? "", model: context.maker?.model ?? "", sources: read_sources(screen), conversation_id: context.conversation_id, run_id: context.run_id ?? "" };
        return decided(name, { outcome: "ran" }, { result: (await run(id, name, [...padded, maker])).text, is_error: false });
      }
      const database = context.database();
      // A call only the user may make is always a proposal, whatever its level would say.
      const decision: Decision = approval_only_calls.has(name) ? { action: "propose", reason: "level" } : decide(level_of(database, name), context.presence, context.has_outside_content);
      if (decision.action === "refuse") return decided(name, { outcome: "refused" }, { result: fill(prompts.tool_results.not_permitted, { name }), is_error: true });
      if (decision.action === "propose") {
        const sources = [...new Set([...read_sources(screen), ...sources_named(database, given)])].sort();
        const seen = [...new Set([...(context.instruction_sources ?? []), ...reads.flatMap((read) => read.sources)])].sort();
        const evidence = { asked_by: context.asked_by ?? "", run_id: context.run_id ?? "", reads: structuredClone(reads), seen };
        const proposal = add_proposal(database, { conversation_id: context.conversation_id, method: name, arguments: given, summary: summarize_call(database, name, given), reason: decision.reason, sources, evidence });
        const waits = decision.reason === "outside content" ? prompts.tool_results.waits_for_approval_outside : prompts.tool_results.waits_for_approval;
        return decided(
          name,
          { outcome: "proposed", proposal_id: proposal.id },
          { result: fill(waits, { id: proposal.id }), is_error: false },
        );
      }
      // Noted as it is made, so the user can undo it from the conversation.
      const summary = summarize_call(database, name, given);
      const mark = mark_before_change(database);
      const result = (await run(id, name, args)).text;
      return decided(name, { outcome: "ran", applied_by: "engine_auto", undo: undo_of_change(context.database(), mark, summary) }, { result, is_error: false });
    } catch (error) {
      return decided(name, { outcome: "failed" }, { result: fill(prompts.tool_results.error_as_said, { message: (error as Error).message }), is_error: true });
    }
  };
  let calls_made = 0;
  // After each call, a run keeping a task list is told where it is in it, or, a few calls into a job with none, to write one.
  const with_reminder = (name: string, outcome: ToolOutcome): ToolOutcome => {
    if (!context.task_list || name === set_task_list_tool.name) return outcome;
    calls_made += 1;
    const steps = read_task_list(context.database(), context.conversation_id);
    const line = steps.length > 0 ? task_list_reminder(steps) : calls_made === calls_before_nudge ? no_list_reminder : "";
    return line ? { ...outcome, result: `${outcome.result}\n${line}` } : outcome;
  };
  return {
    definitions,
    ...(core ? { core } : {}),
    ...(specialists ? { specialists } : {}),
    call: async (name, given, engine_call_id) => {
      if (name === read_result_name) return with_reminder(name, await read_result(given && typeof given === "object" && !Array.isArray(given) ? given : {}));
      const id = result_id(results, engine_call_id);
      const outcome = await call_tool(id, name, given);
      // Every other result is kept too, as given, so a dropped one can be read again.
      if (!results.has(id)) results.set(id, { name, text: outcome.result, fenced: false, sources: new Set(), taints: false });
      return with_reminder(name, outcome);
    },
  };
}

// ── Sources ──────────────────────────────────────────────────────────────────

// The source apps running that a run may read, each with its plugin's description and the guidance for its specialist;
// CODEX's own conversations, blueprints and findings are not source apps.
export async function open_collector_sources(database: SqlDatabase): Promise<CollectorSource[]> {
  const host = await open_plugin_host(database);
  const descriptions = new Map(host.list().map((status) => [status.manifest.id, status.manifest.description ?? ""]));
  const guidance = stored_guidance(database);
  // The MCP server the configuration links to each collector, by the server's collector field alone.
  const linked = new Map(declarations().mcp_servers.flatMap((server) => (server.collector ? [[server.collector, mcp_key_of(server.id)] as const] : [])));
  return host
    .providers("collector")
    .filter(({ id, value }) => !own_collectors.has(id) && (value.search || value.resolve || value.read || value.feeds))
    .map(({ id, plugin_id, value }) => ({
      id,
      label: value.label,
      // An app the item calls read shares its plugin with every other, so the plugin's description says nothing of it.
      description: value.marked_alone ? "" : (descriptions.get(plugin_id) ?? ""),
      own_words: value.own_words === true,
      can_search: value.search !== undefined,
      can_resolve: value.resolve !== undefined,
      can_read: value.read !== undefined,
      can_follow: value.feeds !== undefined,
      guidance: { own: value.guidance?.trim() ?? "", own_words: value.own_words === true, user: guidance[id] ?? "" },
      ...(linked.has(id) ? { tools_key: linked.get(id)! } : {}),
    }));
}

// The guidance of the tool plugins and source apps offered, shortened, for the run's instructions.
export function run_guidance_part(plugin_tools: OpenedTool[], sources: CollectorSource[]): string {
  const plugins = specialist_groups(plugin_tools).map((group) => ({ label: group.label, where: `tools named ${group.tools[0]!.name.split(namespace_mark)[0]}${namespace_mark}…`, guidance: group.guidance }));
  return guidance_part([...plugins, ...sources.map((source) => ({ label: source.label, where: `the source app ${source.id}`, guidance: source.guidance }))]);
}
