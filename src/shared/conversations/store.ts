// Conversations: any number in each context, Global included, each kept as an item of kind "conversation"
// so it lists, searches and moves like any other item. Sending a message starts a run where the store lives and
// answers at once; the reply streams to open pages and is kept as a message when it ends.

// ── Imports ──────────────────────────────────────────────────────────────────

import { synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { settings_of } from "@x-tech-laboratories/x-libs/settings";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { when_items_left } from "../contexts/records.ts";
import { engine_setting } from "../engines/engine.ts";
import { define_feature } from "../feature.ts";
import { list_proposals_of } from "../policy/proposals.ts";
import { list_messages } from "./messages.ts";
import { migrations } from "./migrations/index.ts";
import { conversation_of_item, keep_thinking_setting, type AssistantStatus, type Conversation, type ConversationSummary } from "./model.ts";
import { adopt_stray_conversations, conversation_ids_in, conversation_row, delete_conversation_records, rename_conversation_record, summaries_of } from "./records.ts";
import { find_engine, is_running, run_state, start_run, stop_run_of } from "./run.ts";
import { conversation_tables } from "./schema.ts";
import { read_task_list, set_task_list_tool, write_task_list, type TaskStep } from "./task_list.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

function list_conversations(database: SqlDatabase, context_id: string | null = null): ConversationSummary[] {
  return summaries_of(database, conversation_ids_in(database, context_id || null), is_running);
}

function get_conversation(database: SqlDatabase, id: string): Conversation {
  conversation_row(database, id);
  const [summary] = summaries_of(database, [id], is_running);
  return { ...summary!, messages: list_messages(database, id), proposals: list_proposals_of(database, id), run: run_state(id), task_list: read_task_list(database, id) };
}

function set_conversation_task_list(database: SqlDatabase, id: string, steps: unknown): TaskStep[] {
  return write_task_list(database, id, steps);
}

async function get_assistant_status(database: SqlDatabase): Promise<AssistantStatus> {
  const { engine, problem, engines } = await find_engine(database);
  return { engine, problem, engines };
}

function send_message(database: SqlDatabase, context_id: string | null, message: string, conversation_id?: string | null): Promise<{ conversation_id: string; run_id: string }> {
  return start_run(database, context_id || null, message, conversation_id);
}

function stop_reply(_database: SqlDatabase, conversation_id: string): boolean {
  return stop_run_of(conversation_id);
}

function rename_conversation(database: SqlDatabase, id: string, title: string): void {
  rename_conversation_record(database, id, title);
}

// Deletes the conversation with its messages and proposals, from every context holding it, and stops its reply.
function delete_conversation(database: SqlDatabase, id: string): void {
  conversation_row(database, id);
  stop_run_of(id);
  delete_conversation_records(database, id);
}

// Conversations no other context holds when theirs is removed go with it: their messages, proposals and any reply being
// written. History can bring the context back, but not them.
function forget_left_conversations(database: SqlDatabase, item_ids: string[]): void {
  for (const id of item_ids.map(conversation_of_item).filter((each): each is string => each !== null)) {
    stop_run_of(id);
    delete_conversation_records(database, id);
  }
}

when_items_left(forget_left_conversations);

// ── Feature ──────────────────────────────────────────────────────────────────

const context_param = { name: "context_id", schema: { type: ["string", "null"], description: "A context's id, from list_contexts, or null for Global, the root context." } };
const conversation_param = { name: "id", schema: id_of("conversation") };

export const conversations_feature = define_feature({
  id: "conversations",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(conversation_tables),
  methods: { list_conversations, get_conversation, get_assistant_status, send_message, stop_reply, rename_conversation, delete_conversation, set_conversation_task_list },
  api: {
    list_conversations: {
      description:
        "Lists the conversations with the assistant held in one context, Global for null, most recently used first: each with its title, when it was last used, how many messages it has, whether a reply is being written in it now and the contexts holding it.",
      params: [{ ...context_param, optional: true }],
    },
    get_conversation: {
      description:
        "Gets one conversation with the assistant: every message oldest first, each answer with the engine and model that wrote it, the tool calls it made and what a reasoning model thought, where it happened, the changes proposed in it, the reply being written now, if any, and the assistant's task list for the job in hand.",
      params: [conversation_param],
    },
    get_assistant_status: {
      description: "Says which engine answers the conversations and with which model, or why none does, and lists every engine running.",
      params: [],
    },
    send_message: {
      description:
        "Sends the user's message to the assistant and starts the reply, which is told about the context given; it answers at once with the conversation's id and the run's id, and the reply is kept in the conversation when it ends. Left out, the conversation is the context's most recently used one, or a new one when it has none; null starts a new one in that context. One reply is written at a time per conversation.",
      params: [
        { ...context_param, schema: { ...context_param.schema, description: "The context the user has open, which the assistant is told about; null for Global, where it covers everything." } },
        { name: "message", schema: text("The message, in Markdown.") },
        { name: "conversation_id", schema: { type: ["string", "null"], description: "The conversation's id, from list_conversations; null for a new one." }, optional: true },
      ],
    },
    stop_reply: {
      description: "Stops the reply being written in a conversation, keeping what it had written; true when there was one.",
      params: [{ name: "conversation_id", schema: id_of("conversation") }],
    },
    rename_conversation: {
      description: "Names a conversation; an empty title lets it go by its first message again.",
      params: [conversation_param, { name: "title", schema: text("The new title; empty for its first message.") }],
    },
    delete_conversation: {
      description: "Deletes a conversation with every message and proposal in it, from every context holding it, and stops a reply being written there.",
      params: [conversation_param],
      destructive: true,
    },
    set_conversation_task_list: {
      description:
        "Replaces the assistant's task list in a conversation, the steps it keeps for the job in hand, and gives back what was kept; an empty list clears it. Each step has its text, a status (todo, doing, done or skipped) and a short note.",
      params: [conversation_param, { name: "steps", schema: set_task_list_tool.parameters.properties.steps }],
    },
  },
  settings: { ...settings_of({ [engine_setting]: "" }, { user_only: true }), ...settings_of({ [keep_thinking_setting]: true }) },
  // Every conversation kept before conversations were items, and any a device still on that shape syncs in, becomes one.
  on_open: (database) => void adopt_stray_conversations(database),
  after_write: (database) => void adopt_stray_conversations(database),
});
