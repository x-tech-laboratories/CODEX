import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";

function open_device(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return database;
}

// Sends one device's unpushed changes to another, as an exchange through the server does.
function push(from: DatabaseSync, to: DatabaseSync): void {
  const outgoing = sync_engine.collect_unpushed_changes(from);
  sync_engine.write_state(from, { pushed_seq: outgoing.up_to_seq });
  sync_engine.apply_changes(to, outgoing.changes);
}

const task = { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" };

describe("sync between devices", () => {
  it("carries contexts, items and notes, and two devices adding the same item keep one copy of it", () => {
    const laptop = open_device();
    const server = open_device();
    const on_laptop = bind_methods(() => laptop, () => undefined);
    const on_server = bind_methods(() => server, () => undefined);

    const garden = on_laptop.add_context("Garden", null);
    on_laptop.add_item([garden], "x-tasks", task, "Before March");
    push(laptop, server);
    on_server.add_item([garden], "x-tasks", { ...task, title: "Order seeds now" }, "");
    push(server, laptop);

    const on_both = [on_laptop.get_context(garden), on_server.get_context(garden)];
    for (const context of on_both) {
      expect(context.items).toHaveLength(1);
      expect(context.items[0]).toMatchObject({ id: "x-tasks:t1", title: "Order seeds now", note: "Before March" });
    }
  });
});
