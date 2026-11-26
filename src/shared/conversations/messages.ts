// Reading and writing a conversation's messages, for the conversations store, its runs and the policy's approvals.

// ── Imports ──────────────────────────────────────────────────────────────────

import { asc, eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of, new_id } from "../feature.ts";
import type { ConversationMessage, ToolCallRecord } from "./model.ts";
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

export function list_messages(database: SqlDatabase, conversation_id: string): ConversationMessage[] {
  return drizzle_of(database)
    .select()
    .from(conversation_messages)
    .where(eq(conversation_messages.conversation_id, conversation_id))
    .orderBy(asc(conversation_messages.created_at), asc(conversation_messages.id))
    .all()
    .map((row) => ({ ...row, role: row.role as ConversationMessage["role"], tool_calls: parsed_calls(row.tool_calls) }));
}

export type NewMessage = Pick<ConversationMessage, "conversation_id" | "role" | "text"> & Partial<Pick<ConversationMessage, "engine" | "model" | "tool_calls" | "error" | "input_tokens" | "output_tokens">>;

// Adds a message after every one before it, even one written in the same millisecond.
export function add_message(database: SqlDatabase, message: NewMessage): ConversationMessage {
  const last = list_messages(database, message.conversation_id).at(-1);
  let created_at = new Date().toISOString();
  if (last && created_at <= last.created_at) created_at = new Date(Date.parse(last.created_at) + 1).toISOString();
  const row = {
    id: new_id(),
    engine: "",
    model: "",
    error: "",
    input_tokens: 0,
    output_tokens: 0,
    ...message,
    tool_calls: JSON.stringify(message.tool_calls ?? []),
    created_at,
  };
  drizzle_of(database).insert(conversation_messages).values(row).run();
  return { ...row, tool_calls: message.tool_calls ?? [] };
}

export function remove_messages(database: SqlDatabase, conversation_id: string): void {
  drizzle_of(database).delete(conversation_messages).where(eq(conversation_messages.conversation_id, conversation_id)).run();
}
