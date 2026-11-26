// Conversations: one per context and one general one for when no context is open, each the user's messages and the
// engine's answers with the tool calls it made. Sending a message starts a run where the store lives and answers at
// once; the reply streams to open pages and is kept as a message when it ends.

// ── Imports ──────────────────────────────────────────────────────────────────

import { inArray, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "../api_schemas.ts";
import { engine_setting } from "../engines/engine.ts";
import { contexts } from "../contexts/schema.ts";
import { define_feature, drizzle_of } from "../feature.ts";
import { list_proposals_of, proposal_conversations, remove_proposals } from "../policy/proposals.ts";
import { context_conversations, list_messages, remove_messages } from "./messages.ts";
import { migrations } from "./migrations/index.ts";
import { conversation_id_of, type AssistantStatus, type Conversation } from "./model.ts";
import { find_engine, is_running, run_state, start_run, stop_run_of } from "./run.ts";
import { conversation_tables } from "./schema.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

function get_conversation(database: SqlDatabase, context_id: string | null = null): Conversation {
  const id = conversation_id_of(context_id);
  return { id, context_id: context_id || null, messages: list_messages(database, id), proposals: list_proposals_of(database, id), run: run_state(id) };
}

async function get_assistant_status(database: SqlDatabase): Promise<AssistantStatus> {
  const { engine, problem, engines } = await find_engine(database);
  return { engine, problem, engines };
}

function send_message(database: SqlDatabase, context_id: string | null, message: string): Promise<{ run_id: string }> {
  return start_run(database, context_id || null, message);
}

function stop_reply(_database: SqlDatabase, context_id: string | null = null): boolean {
  return stop_run_of(conversation_id_of(context_id));
}

// Deletes the messages and proposals, so the next message starts afresh.
function clear_conversation(database: SqlDatabase, context_id: string | null = null): void {
  const id = conversation_id_of(context_id);
  if (is_running(id)) throw new Error("A reply is still being written here; stop it first.");
  remove_messages(database, id);
  remove_proposals(database, id);
}

// A removed context takes its conversation with it: the messages, the proposals and a reply still being written.
// History can bring the context back, but not its conversation.
export function forget_removed_contexts(database: SqlDatabase): void {
  const held = [...new Set([...context_conversations(database), ...proposal_conversations(database)])];
  if (held.length === 0) return;
  const kept = new Set(drizzle_of(database).select({ id: contexts.id }).from(contexts).where(inArray(contexts.id, held)).all().map((row) => row.id));
  for (const id of held.filter((each) => !kept.has(each))) {
    stop_run_of(id);
    remove_messages(database, id);
    remove_proposals(database, id);
  }
}

// ── Feature ──────────────────────────────────────────────────────────────────

const context_param = { name: "context_id", schema: { type: ["string", "null"], description: "The context's id, from list_contexts, or null for the general conversation held when no context is open." } };

export const conversations_feature = define_feature({
  id: "conversations",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(conversation_tables),
  methods: { get_conversation, get_assistant_status, send_message, stop_reply, clear_conversation },
  api: {
    get_conversation: {
      description:
        "Gets the conversation with the assistant about one context, or the general one: every message oldest first, each answer with the engine and model that wrote it and the tool calls it made, the changes proposed in it, and the reply being written now, if any.",
      params: [{ ...context_param, optional: true }],
    },
    get_assistant_status: {
      description: "Says which engine answers the conversations and with which model, or why none does, and lists every engine running.",
      params: [],
    },
    send_message: {
      description:
        "Sends the user's message to the assistant in a context's conversation, or the general one, and starts the reply; it answers at once with the run's id, and the reply is kept in the conversation when it ends. One reply is written at a time per conversation.",
      params: [context_param, { name: "message", schema: text("The message, in Markdown.") }],
    },
    stop_reply: {
      description: "Stops the reply being written in a context's conversation, or the general one, keeping what it had written; true when there was one.",
      params: [{ ...context_param, optional: true }],
    },
    clear_conversation: {
      description: "Deletes every message and proposal of a context's conversation, or the general one.",
      params: [{ ...context_param, optional: true }],
      destructive: true,
    },
  },
  setting_defaults: { [engine_setting]: "" },
  after_write: forget_removed_contexts,
});
