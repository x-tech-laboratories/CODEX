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
  // Set on a change that was applied: what undoing it would put back.
  undo?: ChangeUndo;
  // How far into the reply's text the call was made, in characters; left out on calls kept before it was recorded,
  // which show before the text.
  text_at?: number;
  // Set on an ask_ tool's call: the calls its specialist made, in order.
  calls?: ToolCallRecord[];
  // Set on an ask_ tool's call: what its specialist's model thought, each piece placed among its calls.
  thinking?: ThinkingPiece[];
}

// One stretch of a reasoning model's thinking, placed where it happened: how far into the reply's text, in characters,
// and after how many of its tool calls.
export interface ThinkingPiece {
  text: string;
  text_at: number;
  calls_before: number;
}

// The thinking after one more streamed piece: added to the last stretch while nothing was written or called since,
// else a new stretch where the reply stands now.
export function add_thinking(thinking: ThinkingPiece[], text: string, text_at: number, calls_before: number): ThinkingPiece[] {
  const last = thinking.at(-1);
  if (last && last.text_at === text_at && last.calls_before === calls_before) return [...thinking.slice(0, -1), { ...last, text: last.text + text }];
  return [...thinking, { text, text_at, calls_before }];
}

// A reply as it reads: its text cut where each call was made and each stretch of thinking happened, each between the
// text before it and after it.
export type ReplyPart = { text: string } | { call: ToolCallRecord } | { thinking: string };

export function reply_parts(text: string, calls: ToolCallRecord[], thinking: ThinkingPiece[] = []): ReplyPart[] {
  const clamp = (at: number | undefined) => Math.max(0, Math.min(text.length, at ?? 0));
  // A stretch of thinking goes before the call made after it, so ties sort by calls made, then thinking first.
  const placed = [
    ...calls.map((call, order) => ({ part: { call } as ReplyPart, at: clamp(call.text_at), order: order + 1, kind: 1 })),
    ...thinking.filter((piece) => piece.text.trim()).map((piece) => ({ part: { thinking: piece.text } as ReplyPart, at: clamp(piece.text_at), order: piece.calls_before + 1, kind: 0 })),
  ].sort((first, second) => first.at - second.at || first.order - second.order || first.kind - second.kind);
  const parts: ReplyPart[] = [];
  let from = 0;
  for (const { part, at } of placed) {
    if (text.slice(from, at).trim()) parts.push({ text: text.slice(from, at) });
    parts.push(part);
    from = at;
  }
  if (text.slice(from).trim()) parts.push({ text: text.slice(from) });
  return parts;
}

// The setting that keeps a reasoning model's thinking with each reply; off, it still shows while it streams.
export const keep_thinking_setting = "keep_thinking";

// What undoing an applied change puts back: each context it touched, by the version it made and the version before it
// (null for a context it made), with the change in plain words and when it was undone.
export interface ChangeUndo {
  summary: string;
  steps: { item_id: string; made: string; before: string | null }[];
  undone_at?: string;
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
  // What a reasoning model thought while writing it, each stretch where it happened; never sent back to an engine.
  thinking: ThinkingPiece[];
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
  // What a reasoning model thought so far, each stretch where it happened; kept with the answer while the Keep thinking
  // setting is on, and never sent back to it.
  thinking: ThinkingPiece[];
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
  // The contexts holding it, by id and name; Global at least once the store has caught up.
  contexts: { id: string; name: string }[];
  // Where it opens, such as codex://conversation/<id>.
  link: string;
  // The background job whose runs it keeps, by the job's title; null for one the user talks in.
  job: { title: string } | null;
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

// The id of the general conversation kept before conversations were items; it became a conversation in Global.
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
