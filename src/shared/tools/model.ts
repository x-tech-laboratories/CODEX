// The shapes the tool plugins feature hands the page and other programs: each tool plugin with its marks and its tools,
// each tool with whether it is offered and its level. The page imports only these.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PolicyLevel } from "../policy/model.ts";

// ── Names ────────────────────────────────────────────────────────────────────

// The synced setting holding each tool plugin's marks and which of its tools are offered, by the plugin's key.
export const tool_plugins_setting = "tool_plugins";

// What separates a tool plugin's namespace from its tool's own name; CODEX's own calls never hold it.
export const namespace_mark = "__";

// A plugin tool's name as an engine sees it, such as web__web_fetch.
export function is_plugin_tool_name(name: string): boolean {
  return name.includes(namespace_mark);
}

// A tool plugin's results count as a source the run read, under this prefix and the plugin's key.
export const tool_source_prefix = "tool:";

export function tool_source_of(key: string): string {
  return `${tool_source_prefix}${key}`;
}

export function is_tool_source(source: string): boolean {
  return source.startsWith(tool_source_prefix);
}

// ── Marks ────────────────────────────────────────────────────────────────────

// What the user allows of one tool plugin; both off until turned on.
export interface ToolMarks {
  // What its tools give back is the user's own and carries no one else's instructions, so it does not make the run's
  // changes wait; it is fenced as data either way.
  trusted: boolean;
  // Its tools that send their arguments outside this machine may still be used once the run has read a source not
  // marked "May be sent to a hosted engine".
  after_private: boolean;
}

export type ToolMarkName = keyof ToolMarks;

export const tool_mark_names: ToolMarkName[] = ["trusted", "after_private"];

// How one tool is offered: on unless turned off, and left out of the small models' core set unless asked for.
export interface ToolOffer {
  off?: boolean;
  small?: boolean;
}

export type ToolOfferName = "enabled" | "small";

// One tool plugin's record in the setting.
export interface ToolPluginRecord extends Partial<ToolMarks> {
  tools?: Record<string, ToolOffer>;
}

// ── Listing ──────────────────────────────────────────────────────────────────

export interface PluginToolEntry {
  // The name an engine sees, the plugin's namespace and the tool's own name.
  name: string;
  // The tool's own name within its plugin.
  tool: string;
  description: string;
  changes: boolean;
  sends_outside: boolean;
  enabled: boolean;
  // Also offered to a model with a small context, in the core set.
  small: boolean;
  // Its level under the action policy; a tool that only reads runs at once and has none.
  level: PolicyLevel | null;
}

export interface ToolPluginEntry extends ToolMarks {
  // The plugin's id and the id it provides its tools under, such as codex.web/web.
  key: string;
  plugin_id: string;
  label: string;
  tools: PluginToolEntry[];
  // Why its tools could not be listed, in plain words; empty when they were.
  problem: string;
}
