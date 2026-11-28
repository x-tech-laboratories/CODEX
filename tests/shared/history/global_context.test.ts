import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrate } from "@x-tech-laboratories/x-libs/sql";

import { install_history, record_history } from "../../../src/shared/history/store.ts";
import { bind_methods, features, open_store, sync_engine } from "../../../src/shared/store.ts";

// The contexts steps before Global, as the release before it ran them.
const steps_before_global = 4;

// A database as the release before Global kept it, opened by it once: triggers for History and sync in place.
function old_database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const feature of features) migrate(database, feature.id === "contexts" ? feature.migrations.slice(0, steps_before_global) : feature.migrations, { owner: feature.id });
  install_history(database);
  sync_engine.install(database);
  return database;
}

function add_old_context(database: DatabaseSync, id: string, name: string, parent_id: string | null = null): void {
  database.prepare("INSERT INTO contexts (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, parent_id, name, "2026-11-20T00:00:00.000Z");
}

function add_old_conversation(database: DatabaseSync, id: string, context_id: string | null, status = ""): void {
  database.prepare("INSERT INTO conversations (id, title, created_at) VALUES (?, ?, ?)").run(id, `Talk ${id}`, "2026-11-21T00:00:00.000Z");
  database.prepare("INSERT INTO items (id, collector, source_id, kind, title, status, created_at) VALUES (?, 'conversation', ?, 'conversation', ?, ?, ?)").run(`conversation:${id}`, id, `Talk ${id}`, status, "2026-11-21T00:00:00.000Z");
  if (context_id) database.prepare("INSERT INTO context_items (context_id, item_id, added_at) VALUES (?, ?, ?)").run(context_id, `conversation:${id}`, "2026-11-21T00:00:00.000Z");
}

// A store with two top-level contexts, one inside another, a conversation in no context, one in a context and one deleted.
function fill(database: DatabaseSync): void {
  add_old_context(database, "kitchen", "Kitchen");
  add_old_context(database, "tiles", "Tiles", "kitchen");
  add_old_context(database, "garden", "Garden");
  add_old_conversation(database, "loose", null);
  add_old_conversation(database, "held", "kitchen");
  add_old_conversation(database, "gone", null, "missing");
  // The release before kept a version after each write, as this one does.
  record_history(database);
}

// Sends one device's unpushed changes to another, as an exchange through the server does.
function push(from: DatabaseSync, to: DatabaseSync): void {
  const outgoing = sync_engine.collect_unpushed_changes(from);
  sync_engine.write_state(from, { pushed_seq: outgoing.up_to_seq });
  sync_engine.apply_changes(to, outgoing.changes);
}

function rows(database: DatabaseSync, sql: string): unknown[] {
  return database.prepare(sql).all().map((row) => ({ ...row }));
}

// Each context's way up to the root, which must end at Global without going round.
function paths_to_root(database: DatabaseSync): string[] {
  const parent_of = new Map((database.prepare("SELECT id, parent_id FROM contexts").all() as { id: string; parent_id: string | null }[]).map((row) => [row.id, row.parent_id]));
  return [...parent_of.keys()].sort().map((id) => {
    const path = [id];
    for (let at = parent_of.get(id); at; at = parent_of.get(at)) {
      if (path.includes(at)) return `${path.join(" › ")} › cycle`;
      path.push(at);
    }
    return path.join(" › ");
  });
}

describe("moving to Global", () => {
  it("makes Global the root, puts the top-level contexts under it and the conversations in no context in it, once", () => {
    const database = old_database();
    fill(database);
    open_store(database);
    const calls = bind_methods(() => database, () => undefined);

    expect(calls.list_contexts().map((context) => [context.id, context.parent_id])).toEqual([
      ["garden", "global"],
      ["global", null],
      ["kitchen", "global"],
      ["tiles", "kitchen"],
    ]);
    expect(calls.get_context("global")).toMatchObject({ name: "Global", notes: "", parent_id: null });
    expect(calls.list_conversations(null).map((each) => each.id)).toEqual(["loose"]);
    expect(calls.list_conversations("global").map((each) => each.id)).toEqual(["loose"]);
    expect(calls.list_conversations("kitchen").map((each) => each.id)).toEqual(["held"]);
    expect(calls.get_item("conversation:gone").contexts).toEqual([]);
    expect(paths_to_root(database)).toEqual(["garden › global", "global", "kitchen › global", "tiles › kitchen › global"]);

    // History shows Global made and the contexts it took in, as changes on this device.
    // History shows Global first seen, under an id every device gives it alike, and each context it took in edited.
    expect(calls.list_item_history("context", "global")).toMatchObject([{ id: "first_seen:global", change: "first_seen", origin: "here" }]);
    expect(calls.list_item_history("context", "kitchen").map((change) => change.change)).toContain("edited");

    // Opening again changes nothing.
    const before = rows(database, "SELECT * FROM contexts ORDER BY id");
    open_store(database);
    expect(rows(database, "SELECT * FROM contexts ORDER BY id")).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS total FROM context_items").get()).toEqual({ total: 2 });
  });

  it("starts a new store with Global alone, where conversations, blueprints and items go when no context is named", async () => {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const calls = bind_methods(() => database, () => undefined);
    expect(calls.list_contexts().map((context) => context.id)).toEqual(["global"]);
    const blueprint = calls.add_blueprint("Sort the mail", "When sorting mail", "File it.", null);
    expect(calls.get_blueprint(blueprint).contexts).toEqual([{ id: "global", name: "Global" }]);
    const garden = calls.add_context("Garden");
    expect(calls.list_blueprints(garden).map((each) => each.id)).toEqual([blueprint]);
    expect(calls.list_jobs(null)).toEqual([]);
  });
});

describe("Global under sync", () => {
  it("comes out as one Global with the same tree on two devices that moved to it on their own", () => {
    const laptop = old_database();
    const phone = old_database();
    fill(laptop);
    push(laptop, phone);

    open_store(laptop);
    open_store(phone);
    bind_methods(() => phone, () => undefined).set_context_notes("global", "Keep answers short.");
    push(laptop, phone);
    push(phone, laptop);

    for (const sql of ["SELECT * FROM contexts ORDER BY id", "SELECT * FROM context_items ORDER BY context_id, item_id"]) expect(rows(laptop, sql)).toEqual(rows(phone, sql));
    expect(laptop.prepare("SELECT COUNT(*) AS total FROM contexts WHERE parent_id IS NULL").get()).toEqual({ total: 1 });
    expect(laptop.prepare("SELECT notes FROM contexts WHERE id = 'global'").get()).toEqual({ notes: "Keep answers short." });
    expect(paths_to_root(laptop)).toEqual(["garden › global", "global", "kitchen › global", "tiles › kitchen › global"]);
  });

  it("puts what a device not yet updated syncs in at the top level under Global, and lists it there at once", () => {
    const laptop = new DatabaseSync(":memory:");
    open_store(laptop);
    const old_phone = old_database();
    add_old_context(old_phone, "shed", "Shed");
    add_old_conversation(old_phone, "from-phone", null);
    push(old_phone, laptop);

    const calls = bind_methods(() => laptop, () => undefined);
    expect(calls.list_contexts().find((context) => context.id === "shed")?.parent_id).toBe("global");
    calls.set_context_notes("shed", "Tools");
    expect(laptop.prepare("SELECT parent_id FROM contexts WHERE id = 'shed'").get()).toEqual({ parent_id: "global" });
    expect(calls.list_conversations(null).map((each) => each.id)).toEqual(["from-phone"]);

    // The old device takes the change back without trouble: Global is an ordinary context to it.
    push(laptop, old_phone);
    expect(old_phone.prepare("SELECT parent_id FROM contexts WHERE id = 'shed'").get()).toEqual({ parent_id: "global" });
  });
});
