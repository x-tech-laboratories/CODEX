// The conversation tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// One message of a conversation: the user's, the engine's answer, or an event such as an approved change.
export const conversation_messages = sqliteTable(
  "conversation_messages",
  {
    id: text().primaryKey(),
    // The open context's id, or "general" for the conversation held with no context open.
    conversation_id: text().notNull(),
    // "user", "assistant" or "event".
    role: text().notNull(),
    // Markdown.
    text: text().notNull().default(""),
    // The engine and model that answered; empty on the user's own messages.
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    // The tool calls made while answering, as a JSON list, each with its arguments, result and what became of it.
    tool_calls: text().notNull().default("[]"),
    // Why the answer stopped short, such as a refusal or the user stopping it; empty when it finished.
    error: text().notNull().default(""),
    // The sources whose content the run that wrote it had read, as a JSON list of collector ids; ["*"] when not
    // recorded, as on every message kept before 2026-11-26. The user's own messages are theirs whatever it says.
    sources: text().notNull().default('["*"]'),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    created_at: text().notNull(),
  },
  (table) => [index("conversation_messages_by_conversation").on(table.conversation_id, table.created_at)],
);

export const conversation_tables = [conversation_messages];
