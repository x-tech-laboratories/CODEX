// The shapes the conversations store hands the page and other programs, and the events a run streams to open pages.
// The page imports only these types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { item_link } from "@x-tech-laboratories/x-libs/items";

import type { Proposal } from "../policy/model.ts";

// ── Messages ─────────────────────────────────────────────────────────────────

// What became of a tool call: run, left for the user's approval, refused by the policy, rejected by the user, or failed.
export type ToolCallOutcome = "pending" | "ran" | "proposed" | "refused" | "rejected" | "failed";

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
  // Why the answer stopped short, in plain words; empty when it finished.
  error: string;
  // The raw failure behind the error, for a Details disclosure; empty when there is none.
  error_detail: string;
  // What the user should know about how the answer was written, such as their message shortened to fit the model.
  notices: string[];
  // The sources whose content the run that wrote it had read, by collector id; "*" when not recorded.
  sources: string[];
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
  // What a reasoning model thought so far, shown while it writes; never kept with the answer or sent back to it.
  reasoning: string;
  tool_calls: ToolCallRecord[];
  notices: string[];
}

// ── Conversations ────────────────────────────────────────────────────────────

// A conversation as a switcher lists it.
export interface ConversationSummary {
  id: string;
  // The name the user gave it, or its first message clipped, or "New conversation" before it has one.
  title: string;
  // The user named it, rather than it going by its first message.
  is_named: boolean;
  created_at: string;
  // When its last message was kept, or when it was made.
  last_used_at: string;
  message_count: number;
  // A reply is being written in it now.
  is_running: boolean;
  // The contexts holding it, by id and name; none for a conversation in no context.
  contexts: { id: string; name: string }[];
  // Where it opens, such as codex://conversation/<id>.
  link: string;
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[];
  proposals: Proposal[];
  run: RunState | null;
}

// What a run tells open pages as it goes; the page lays them over the conversation it loaded.
export type ConversationEvent = { conversation_id: string; run_id: string } & (
  | { type: "started"; engine: string; model: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "notice"; text: string }
  | { type: "tool_call"; call: ToolCallRecord }
  | { type: "tool_result"; call: ToolCallRecord }
  | { type: "finished"; error: string; error_detail?: string }
);

// ── Engines ──────────────────────────────────────────────────────────────────

export interface EngineSummary {
  // The id its plugin provides it under, which the engine setting names.
  id: string;
  plugin_id: string;
  label: string;
  model: string;
  // Its model answers on this machine or the user's own network; a hosted engine is sent only items of marked sources.
  is_local: boolean;
}

export interface AssistantStatus {
  // The engine that answers, or null when none is chosen or it is not running.
  engine: EngineSummary | null;
  // Why there is none, in plain words; empty when there is one.
  problem: string;
  // Every engine running, to choose from.
  engines: EngineSummary[];
}

// ── Items ────────────────────────────────────────────────────────────────────

// The collector, and the kind, a conversation is kept under as an item; CODEX's own, so never an outside source.
export const conversation_collector = "conversation";
export const conversation_kind = "conversation";

// The id of the general conversation kept before conversations were items; it became a conversation in no context.
export const old_general_conversation = "general";

export function conversation_item_id(conversation_id: string): string {
  return `${conversation_collector}:${conversation_id}`;
}

// The conversation an item id names, or null for any other item.
export function conversation_of_item(item_id: string): string | null {
  return item_id.startsWith(`${conversation_collector}:`) ? item_id.slice(conversation_collector.length + 1) : null;
}

export function conversation_link(conversation_id: string): string {
  return item_link("codex", conversation_kind, conversation_id);
}

// The page's route that opens a conversation in the pane.
export function conversation_route(conversation_id: string): string {
  return `#/conversation/${encodeURIComponent(conversation_id)}`;
}

export const untitled_conversation = "New conversation";
