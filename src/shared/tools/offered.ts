// The tool plugins running now, each tool under its plugin's namespace with the user's marks and choices, read from
// the plugin host where the store runs; a plugin's tools never run in the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";
import type { PluginHost } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host, type ContextPluginApi } from "../collectors/host.ts";
import { settings_feature } from "../settings.ts";
import { namespace_mark, tool_plugins_setting, type ToolMarks, type ToolPluginRecord } from "./model.ts";
import type { PluginTool, ToolPlugin } from "./tool.ts";

// ── Records ──────────────────────────────────────────────────────────────────

export function stored_tool_plugins(database: SqlDatabase): Record<string, ToolPluginRecord> {
  const saved = settings_feature.methods.get_settings(database)[tool_plugins_setting];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return saved as Record<string, ToolPluginRecord>;
}

// Whether a plugin's results may go to a hosted engine before the user says: only when it has tools and every one
// sends what it is given outside this computer, as the Web plugin's do, so what they read is outside already.
export function sends_all_outside(tools: Pick<PluginTool, "sends_outside">[]): boolean {
  return tools.length > 0 && tools.every((tool) => tool.sends_outside);
}

// The marks the user set, and send_to_hosted from the plugin's tools where the user has not set it.
export function marks_of(record: ToolPluginRecord | undefined, tools: Pick<PluginTool, "sends_outside">[] = []): ToolMarks {
  return {
    send_to_hosted: typeof record?.send_to_hosted === "boolean" ? record.send_to_hosted : sends_all_outside(tools),
    trusted: record?.trusted === true,
    after_private: record?.after_private === true,
  };
}

// ── Names ────────────────────────────────────────────────────────────────────

// The longest tool name the hosted model APIs take.
export const longest_tool_name = 64;

function hash_of(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

// A provider's id as a namespace: letters, digits, _ and -, never the mark between namespace and tool.
export function namespace_of(provider_id: string): string {
  const plain = provider_id.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  return plain || "tools";
}

// The name an engine sees: the namespace, the mark and the tool's own name made safe, cut with a hash when too long.
export function tool_name_of(namespace: string, tool: string): string {
  const own = tool.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  const name = `${namespace}${namespace_mark}${own}`;
  if (name.length <= longest_tool_name && own === tool) return name;
  const hash = hash_of(tool);
  return name.length <= longest_tool_name - 9 ? `${name}_${hash}` : `${name.slice(0, longest_tool_name - 9)}_${hash}`;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export interface OpenedTool {
  // The name an engine sees.
  name: string;
  // The plugin's key, such as codex.web/web, and its label.
  key: string;
  label: string;
  tool: PluginTool;
  own_words: boolean;
  enabled: boolean;
  small: boolean;
  marks: ToolMarks;
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface OpenedPlugin {
  key: string;
  plugin_id: string;
  label: string;
  marks: ToolMarks;
  tools: OpenedTool[];
  problem: string;
}

// How long a plugin may take to say which tools it has.
export const listing_timeout_ms = 15_000;

function within<Value>(work: Promise<Value>, ms: number, what: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds.`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// A tool as the plugin gave it, anything missing read the careful way: a tool that does not say is taken to change
// something and to send its arguments outside.
function checked_tool(value: unknown): PluginTool | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Partial<PluginTool>;
  if (typeof given.name !== "string" || !given.name.trim()) return null;
  const parameters: JsonSchema = given.parameters && typeof given.parameters === "object" && !Array.isArray(given.parameters) ? given.parameters : { type: "object", properties: {} };
  return {
    name: given.name,
    description: typeof given.description === "string" ? given.description : "",
    parameters: { ...parameters, type: "object" },
    changes: given.changes !== false,
    sends_outside: given.sends_outside !== false,
  };
}

// Every tool plugin running, each with its tools; one whose tools could not be listed says why.
export async function open_tool_plugins(database: SqlDatabase, host?: PluginHost<ContextPluginApi>): Promise<OpenedPlugin[]> {
  const opened_host = host ?? (await open_plugin_host(database));
  const stored = stored_tool_plugins(database);
  const taken = new Set<string>();
  const plugins: OpenedPlugin[] = [];
  for (const provided of opened_host.providers("tools")) {
    const value: ToolPlugin = provided.value;
    const key = `${provided.plugin_id}/${provided.id}`;
    const record = stored[key];
    const plugin: OpenedPlugin = { key, plugin_id: provided.plugin_id, label: value.label, marks: marks_of(record), tools: [], problem: "" };
    plugins.push(plugin);
    const namespace = namespace_of(provided.id);
    let listed: unknown;
    try {
      listed = await within(Promise.resolve(value.tools()), listing_timeout_ms, value.label);
    } catch (error) {
      plugin.problem = error instanceof Error ? error.message : String(error);
      continue;
    }
    const checked = (Array.isArray(listed) ? listed : []).map(checked_tool).filter((tool): tool is PluginTool => tool !== null);
    const marks = marks_of(record, checked);
    plugin.marks = marks;
    for (const tool of checked) {
      const name = tool_name_of(namespace, tool.name);
      // Two plugins under one namespace, or two tools made alike, keep the first.
      if (taken.has(name)) continue;
      taken.add(name);
      const offer = record?.tools?.[tool.name] ?? {};
      plugin.tools.push({
        name,
        key,
        label: value.label,
        tool,
        own_words: value.own_words === true,
        enabled: offer.off !== true,
        small: offer.small === true,
        marks,
        call: (args, signal) => value.call(tool.name, args, signal),
      });
    }
  }
  return plugins;
}

// Every tool of every tool plugin running, turned on or not.
export async function open_plugin_tools(database: SqlDatabase): Promise<OpenedTool[]> {
  return (await open_tool_plugins(database)).flatMap((plugin) => plugin.tools);
}

// ── Calling ──────────────────────────────────────────────────────────────────

// How long one tool call may take before CODEX gives up on it.
export const call_timeout_ms = 120_000;

// Runs one tool, stopping it when the signal aborts or it takes too long, whatever the plugin does; a plugin that
// throws or answers with something not text gives a plain error.
export async function run_tool(tool: OpenedTool, args: Record<string, unknown>, signal: AbortSignal, timeout_ms = call_timeout_ms): Promise<string> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error(`${tool.label} did not answer within ${timeout_ms / 1000} seconds.`)), timeout_ms);
  const on_abort = () => stop.abort(new Error("Stopped."));
  if (signal.aborted) on_abort();
  else signal.addEventListener("abort", on_abort, { once: true });
  const stopped = new Promise<never>((_, reject) => {
    if (stop.signal.aborted) reject(stop.signal.reason as Error);
    else stop.signal.addEventListener("abort", () => reject(stop.signal.reason as Error), { once: true });
  });
  try {
    const answer = await Promise.race([tool.call(args, stop.signal), stopped]);
    return typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", on_abort);
    stopped.catch(() => undefined);
  }
}

// One tool by the name an engine sees, when it is running and turned on.
export async function find_plugin_tool(database: SqlDatabase, name: string): Promise<OpenedTool | null> {
  return (await open_plugin_tools(database)).find((tool) => tool.name === name && tool.enabled) ?? null;
}
