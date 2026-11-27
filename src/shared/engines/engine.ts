// What an engine is: a plugin that answers a conversation, given CODEX's instructions and CODEX's tools, and streams
// events back. It never reaches the store, MCP or the settings itself: every tool call goes through the `call` CODEX
// hands it, so the action policy and the record of what changed are CODEX's, for every engine.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";

// ── Request ──────────────────────────────────────────────────────────────────

// One turn of the conversation so far; tool calls stay with CODEX and are not replayed.
export interface EngineTurn {
  role: "user" | "assistant";
  text: string;
}

// A tool CODEX offers: one of its own calls, described by its api spec.
export interface ToolDefinition {
  name: string;
  description: string;
  // The arguments as one JSON object.
  parameters: JsonSchema;
}

// What a tool call gave back, as text for the model; an error is a refusal, a failure or a change left for approval.
export interface ToolOutcome {
  result: string;
  is_error: boolean;
}

export interface EngineTools {
  definitions: ToolDefinition[];
  // The smaller set for a model with a small context: the reads and the most-used changes, briefly described.
  core?: ToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  // The same tools with each tool plugin's tools behind one ask_ tool of its specialist, set when the run has plugin
  // tools; `delegated` is the plugin tools' full definitions they stand for, which the Automatic rule weighs.
  specialists?: { definitions: ToolDefinition[]; core?: ToolDefinition[]; delegated: ToolDefinition[] };
}

export interface EngineRequest {
  // Who the engine is, today's date, the open context and the rules, written by CODEX.
  instructions: string;
  // Oldest first, ending with the user's new message.
  conversation: EngineTurn[];
  tools: EngineTools;
  // Set for a background job: the most rounds of model calls the reply may take.
  limits?: { max_rounds?: number };
}

// ── Events ───────────────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: "text"; text: string }
  // What a reasoning model thinks before it answers; shown while it streams, never kept or sent back.
  | { type: "reasoning"; text: string }
  // Something the user should know about this reply, such as their message being shortened to fit the model.
  | { type: "notice"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: string; is_error: boolean }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done"; text: string }
  // A plain message saying what happened and what to do, and the raw detail behind it when there is one.
  | { type: "error"; message: string; detail?: string };

// ── Models ───────────────────────────────────────────────────────────────────

// Whether a model is in memory on its server, as a llama.cpp router says of each it holds; empty when the server does not say.
export type ModelState = "loaded" | "loading" | "unloaded" | "failed" | "";

export interface EndpointModel {
  id: string;
  state: ModelState;
}

// The models an engine's endpoint offers; an empty list with the reason when it lists none or could not be asked.
export interface ModelListing {
  models: EndpointModel[];
  problem: string;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface Engine {
  label: string;
  // The model it answers with now, from its plugin's settings, such as "claude-opus-5-5".
  model(): string;
  // True when its model answers on this machine or the user's own network, from its settings now; an engine that
  // leaves this out is hosted, and is never sent items from a source not marked for hosted engines.
  is_local?(): boolean;
  // The models its endpoint offers, asked with its own key; an engine that leaves this out lists none.
  list_models?(signal: AbortSignal): Promise<ModelListing>;
  // Ends with one done or error event; stops soon after the signal aborts.
  run(request: EngineRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
}

// Whether an engine is hosted: every engine is, unless it says it is local.
export function is_hosted(engine: Pick<Engine, "is_local">): boolean {
  return engine.is_local?.() !== true;
}

// Which tools an engine offers its model: the core set below a context size, every tool above it, or one set always.
export type ToolSet = "auto" | "core" | "all";

// Whether an engine hands each tool plugin's tools to a specialist: when they would not fit comfortably, always or never.
export type SpecialistSet = "auto" | "on" | "off";

// The setting naming the engine that answers, by the id its plugin provides it under; empty for none.
export const engine_setting = "engine";
