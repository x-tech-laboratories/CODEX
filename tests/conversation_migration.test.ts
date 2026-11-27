import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrate } from "@x-tech-laboratories/x-libs/sql";

import { bind_methods, features, open_store, sync_engine } from "../src/shared/store.ts";

// A database as CODEX kept it before conversations were items: one conversation per context, keyed by its id, and
// "general" for when none was open.
function old_database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const feature of features) migrate(database, feature.id === "conversations" ? feature.migrations.slice(0, 2) : feature.migrations, { owner: feature.id });
  return database;
}

function add_old_message(database: DatabaseSync, conversation_id: string, role: string, text: string, created_at: string): void {
  database.prepare("INSERT INTO conversation_messages (id, conversation_id, role, text, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`${conversation_id}-${created_at}`, conversation_id, role, text, role === "user" ? "[]" : '["*"]', created_at);
}

function add_old_context(database: DatabaseSync, id: string, name: string): void {
  database.prepare("INSERT INTO contexts (id, name, created_at) VALUES (?, ?, ?)").run(id, name, "2026-11-20T00:00:00.000Z");
}

describe("moving to conversations as items", () => {
  it("makes each context's conversation with messages an item in it and the general one a conversation in Global, dropping empty ones and losing no message", () => {
    const database = old_database();
    add_old_context(database, "kitchen", "Kitchen");
    add_old_context(database, "garden", "Garden");
    add_old_message(database, "kitchen", "user", "What tiles?", "2026-11-21T10:00:00.000Z");
    add_old_message(database, "kitchen", "assistant", "Blue ones.", "2026-11-21T10:00:01.000Z");
    add_old_message(database, "general", "user", "Hello", "2026-11-22T10:00:00.000Z");
    add_old_message(database, "gone-context", "user", "Still here", "2026-11-23T10:00:00.000Z");
    database.prepare("INSERT INTO proposals (id, conversation_id, method, summary, created_at) VALUES ('p1', 'kitchen', 'rename_context', 'Rename it.', '2026-11-21T10:00:02.000Z')").run();

    open_store(database);
    const calls = bind_methods(() => database, () => undefined);

    expect(calls.list_conversations("kitchen")).toMatchObject([{ id: "kitchen", title: "What tiles?", message_count: 2, created_at: "2026-11-21T10:00:00.000Z", contexts: [{ id: "kitchen", name: "Kitchen" }] }]);
    expect(calls.get_conversation("kitchen").proposals.map((proposal) => proposal.id)).toEqual(["p1"]);
    expect(calls.list_conversations("garden")).toEqual([]);
    expect(calls.list_conversations(null).map((each) => [each.id, each.title])).toEqual([
      ["gone-context", "Still here"],
      ["general", "Hello"],
    ]);
    expect(calls.get_context("kitchen").items).toMatchObject([{ id: "conversation:kitchen", kind: "conversation", title: "What tiles?", snippet: "You: What tiles? · CODEX: Blue ones." }]);
    expect(database.prepare("SELECT COUNT(*) AS total FROM conversation_messages").get()).toEqual({ total: 4 });

    // Opening again changes nothing.
    open_store(database);
    expect(database.prepare("SELECT COUNT(*) AS total FROM conversations").get()).toEqual({ total: 3 });
    expect(database.prepare("SELECT COUNT(*) AS total FROM context_items").get()).toEqual({ total: 3 });
  });

  it("takes in what a device still on the old shape syncs, without breaking", () => {
    const device = new DatabaseSync(":memory:");
    open_store(device);
    const calls = bind_methods(() => device, () => undefined);
    const kitchen = calls.add_context("Kitchen");
    // What an old device sends is message rows alone, keyed by the context's id or "general", with no conversation.
    const old_device = new DatabaseSync(":memory:");
    open_store(old_device);
    add_old_message(old_device, kitchen, "user", "From the old laptop", "2026-11-26T08:00:00.000Z");
    add_old_message(old_device, "general", "user", "Hi from the old laptop", "2026-11-26T08:00:01.000Z");
    const outgoing = sync_engine.collect_unpushed_changes(old_device);
    sync_engine.apply_changes(device, outgoing.changes.filter((change) => change.table === "conversation_messages"));

    // The next write anywhere takes them in.
    calls.set_context_notes(kitchen, "Spring");
    expect(calls.list_conversations(kitchen).map((each) => [each.id, each.title])).toEqual([[kitchen, "From the old laptop"]]);
    expect(calls.list_conversations(null).map((each) => each.title)).toEqual(["Hi from the old laptop"]);

    // More from the old device lands in the conversation it already became.
    add_old_message(old_device, kitchen, "user", "And again", "2026-11-26T08:05:00.000Z");
    sync_engine.apply_changes(device, sync_engine.collect_unpushed_changes(old_device).changes.filter((change) => change.table === "conversation_messages" && !outgoing.changes.includes(change)));
    expect(calls.get_conversation(kitchen).messages.map((message) => message.text)).toEqual(["From the old laptop", "And again"]);
  });
});
