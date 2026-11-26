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
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface EngineRequest {
  // Who the engine is, today's date, the open context and the rules, written by CODEX.
  instructions: string;
  // Oldest first, ending with the user's new message.
  conversation: EngineTurn[];
  tools: EngineTools;
}

// ── Events ───────────────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: string; is_error: boolean }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

// ── Engine ───────────────────────────────────────────────────────────────────

export interface Engine {
  label: string;
  // The model it answers with now, from its plugin's settings, such as "claude-opus-5-5".
  model(): string;
  // True when its model answers on this machine or the user's own network, from its settings now; an engine that
  // leaves this out is hosted, and is never sent items from a source not marked for hosted engines.
  is_local?(): boolean;
  // Ends with one done or error event; stops soon after the signal aborts.
  run(request: EngineRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
}

// Whether an engine is hosted: every engine is, unless it says it is local.
export function is_hosted(engine: Pick<Engine, "is_local">): boolean {
  return engine.is_local?.() !== true;
}

// The setting naming the engine that answers, by the id its plugin provides it under; empty for none.
export const engine_setting = "engine";
