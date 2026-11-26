// The shapes the conversations store hands the page and other programs, and the events a run streams to open pages.
// The page imports only these types.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Proposal } from "../policy/model.ts";

// ── Messages ─────────────────────────────────────────────────────────────────

// What became of a tool call: run, left for the user's approval, refused by the policy, or failed.
export type ToolCallOutcome = "pending" | "ran" | "proposed" | "refused" | "failed";

// What made a change that was applied: the engine at the auto level, or the user approving a proposal.
export type AppliedBy = "engine_auto" | "user_approval";

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // The text the engine was given back.
  result: string;
  is_error: boolean;
  outcome: ToolCallOutcome;
  // Set on a change that was applied.
  applied_by?: AppliedBy;
  // Set on a change left for approval.
  proposal_id?: string;
}

export type MessageRole = "user" | "assistant" | "event";

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  text: string;
  engine: string;
  model: string;
  tool_calls: ToolCallRecord[];
  error: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// A reply being written, as far as it has come; it lives only where the store runs it.
export interface RunState {
  run_id: string;
  engine: string;
  model: string;
  started_at: string;
  text: string;
  tool_calls: ToolCallRecord[];
}

export interface Conversation {
  // The context's id, or "general".
  id: string;
  context_id: string | null;
  messages: ConversationMessage[];
  proposals: Proposal[];
  run: RunState | null;
}

// What a run tells open pages as it goes; the page lays them over the conversation it loaded.
export type ConversationEvent = { conversation_id: string; run_id: string } & (
  | { type: "started"; engine: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCallRecord }
  | { type: "tool_result"; call: ToolCallRecord }
  | { type: "finished"; error: string }
);

// ── Engines ──────────────────────────────────────────────────────────────────

export interface EngineSummary {
  // The id its plugin provides it under, which the engine setting names.
  id: string;
  plugin_id: string;
  label: string;
  model: string;
}

export interface AssistantStatus {
  // The engine that answers, or null when none is chosen or it is not running.
  engine: EngineSummary | null;
  // Why there is none, in plain words; empty when there is one.
  problem: string;
  // Every engine running, to choose from.
  engines: EngineSummary[];
}

// The conversation held when no context is open.
export const general_conversation = "general";

export function conversation_id_of(context_id: string | null | undefined): string {
  return context_id || general_conversation;
}
