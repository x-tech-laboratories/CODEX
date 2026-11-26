// What a tool plugin is: prebuilt tools an engine may use beside CODEX's own calls, such as reading a web page. CODEX
// keeps control of them as of its own calls: every call goes through the run's one wrapper, under the action policy,
// fenced as outside data, and refused when it would send what the run read to somewhere outside this machine.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";

// ── Tools ────────────────────────────────────────────────────────────────────

// One tool as its plugin describes it; its name is the plugin's own, which CODEX puts behind the plugin's namespace.
export interface PluginTool {
  name: string;
  // What it does, in plain words, for the model.
  description: string;
  // The arguments as one JSON object.
  parameters: JsonSchema;
  // It changes something anywhere: in CODEX, in another app, or on the web; such a tool has a level under the action policy.
  changes: boolean;
  // It sends its arguments to somewhere outside this machine, such as a search engine.
  sends_outside: boolean;
}

export interface ToolPlugin {
  label: string;
  // True when the descriptions are the plugin author's own words; left out, they are shown to the engine fenced as
  // outside data, as a server's descriptions are.
  own_words?: boolean;
  // The tools offered now, from the plugin's settings; one with nothing set up yet is left out.
  tools(): PluginTool[] | Promise<PluginTool[]>;
  // Runs one tool by its own name and answers with text; throws a plain error when it cannot.
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}
