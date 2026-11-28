// Reading and writing a conversation's messages, for the conversations store, its runs and the policy's approvals.

// ── Imports ──────────────────────────────────────────────────────────────────

import { asc, eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of, new_id } from "../feature.ts";
import { parse_sources, unrecorded_source } from "../privacy/sources.ts";
import { call_path_mark, type ConversationMessage, type ThinkingPiece, type ToolCallRecord } from "./model.ts";
import { has_conversation, refresh_conversation_items } from "./records.ts";
import { conversation_messages } from "./schema.ts";

// ── Messages ─────────────────────────────────────────────────────────────────

function parsed_calls(text: string): ToolCallRecord[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as ToolCallRecord[]) : [];
  } catch {
    return [];
  }
}

function parsed_notices(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  } catch {
    return [];
  }
}

// The stretches of thinking kept on a message, leaving out any not shaped as one.
function parsed_thinking(text: string): ThinkingPiece[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((each): each is ThinkingPiece => typeof each?.text === "string" && typeof each.text_at === "number" && typeof each.calls_before === "number");
  } catch {
    return [];
  }
}

export function list_messages(database: SqlDatabase, conversation_id: string): ConversationMessage[] {
  return drizzle_of(database)
    .select()
    .from(conversation_messages)
    .where(eq(conversation_messages.conversation_id, conversation_id))
    .orderBy(asc(conversation_messages.created_at), asc(conversation_messages.id))
    .all()
    .map((row) => ({ ...row, role: row.role as ConversationMessage["role"], tool_calls: parsed_calls(row.tool_calls), notices: parsed_notices(row.notices), sources: parse_sources(row.sources), thinking: parsed_thinking(row.thinking) }));
}

export type NewMessage = Pick<ConversationMessage, "conversation_id" | "role" | "text"> & Partial<Pick<ConversationMessage, "engine" | "model" | "tool_calls" | "error" | "error_detail" | "notices" | "input_tokens" | "output_tokens" | "sources" | "thinking">>;

// Adds a message after every one before it, even one written in the same millisecond; without sources given, its
// sources count as not recorded. The conversation's item takes the new exchange.
export function add_message(database: SqlDatabase, message: NewMessage): ConversationMessage {
  const last = list_messages(database, message.conversation_id).at(-1);
  let created_at = new Date().toISOString();
  if (last && created_at <= last.created_at) created_at = new Date(Date.parse(last.created_at) + 1).toISOString();
  const row = {
    id: new_id(),
    engine: "",
    model: "",
    error: "",
    error_detail: "",
    input_tokens: 0,
    output_tokens: 0,
    ...message,
    tool_calls: JSON.stringify(message.tool_calls ?? []),
    notices: JSON.stringify(message.notices ?? []),
    sources: JSON.stringify(message.sources ?? [unrecorded_source]),
    thinking: JSON.stringify(message.thinking ?? []),
    created_at,
  };
  drizzle_of(database).insert(conversation_messages).values(row).run();
  refresh_conversation_items(database, has_conversation(database, message.conversation_id) ? [message.conversation_id] : []);
  return { ...row, tool_calls: message.tool_calls ?? [], notices: message.notices ?? [], sources: message.sources ?? [unrecorded_source], thinking: message.thinking ?? [] };
}

// One message by its id, or null when it is gone.
export function message_of(database: SqlDatabase, id: string): ConversationMessage | null {
  const row = drizzle_of(database).select({ conversation_id: conversation_messages.conversation_id }).from(conversation_messages).where(eq(conversation_messages.id, id)).get();
  return row ? (list_messages(database, row.conversation_id).find((message) => message.id === id) ?? null) : null;
}

// ── Tool calls ───────────────────────────────────────────────────────────────

// The call at an id path among a message's calls, a specialist's under its ask.
export function call_at(calls: ToolCallRecord[], path: string): ToolCallRecord | undefined {
  const [first, ...rest] = path.split(call_path_mark);
  const call = calls.find((each) => each.id === first);
  return call && rest.length > 0 ? call_at(call.calls ?? [], rest.join(call_path_mark)) : call;
}

// Every call among a message's calls with its id path, a specialist's after its ask.
export function calls_with_paths(calls: ToolCallRecord[], above = ""): { path: string; call: ToolCallRecord }[] {
  return calls.flatMap((call) => {
    const path = above ? `${above}${call_path_mark}${call.id}` : call.id;
    return [{ path, call }, ...calls_with_paths(call.calls ?? [], path)];
  });
}

function changed_at(calls: ToolCallRecord[], path: string, change: (call: ToolCallRecord) => ToolCallRecord): ToolCallRecord[] {
  const [first, ...rest] = path.split(call_path_mark);
  return calls.map((call) => (call.id !== first ? call : rest.length === 0 ? change(call) : { ...call, calls: changed_at(call.calls ?? [], rest.join(call_path_mark), change) }));
}

// Rewrites one tool call kept on a message, by its id path, such as to mark it undone.
export function update_tool_call(database: SqlDatabase, message_id: string, call_id: string, change: (call: ToolCallRecord) => ToolCallRecord): void {
  const message = message_of(database, message_id);
  if (!message) throw new Error(`There is no message ${message_id}.`);
  const calls = changed_at(message.tool_calls, call_id, change);
  drizzle_of(database).update(conversation_messages).set({ tool_calls: JSON.stringify(calls) }).where(eq(conversation_messages.id, message_id)).run();
}
