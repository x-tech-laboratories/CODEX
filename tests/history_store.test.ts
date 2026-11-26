import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { prune_history } from "../src/shared/history/store.ts";
import { bind_methods, open_store, sync_engine } from "../src/shared/store.ts";

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, store: bind_methods(() => database, () => undefined) };
}

const note = { source_id: "n1", kind: "note", title: "Bed layout" };

describe("history", () => {
  it("keeps a version of a context for every change to it, its items included, and brings a deleted one back whole", () => {
    const { store } = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "trilium", note, "");
    store.set_context_notes(garden, "Raised beds this year.");

    const versions = store.list_item_history("context", garden);
    expect(versions.at(-1)!.change).toBe("created");
    expect(versions[0]).toMatchObject({ kind: "context", kind_label: "Context", item_name: "Garden", summary: "1 item", origin: "here" });

    store.remove_context(garden);
    expect(store.list_contexts(true)).toEqual([]);
    const deleted = store.list_recent_changes(10).find((change) => change.item_id === garden)!;
    expect(deleted.change).toBe("deleted");

    store.restore_item_version("context", deleted.id);
    const back = store.get_context(garden);
    expect(back).toMatchObject({ name: "Garden", notes: "Raised beds this year." });
    expect(back.items.map((item) => item.title)).toEqual(["Bed layout"]);
  });

  it("leaves a refresh out of the history, since it changes only what the apps said", async () => {
    const { store } = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "trilium", note, "");
    const before = store.list_item_history("context", garden).length;
    await store.refresh_items(null);
    expect(store.list_item_history("context", garden)).toHaveLength(before);
  });

  it("records versions that arrive by sync on the device that made them only, and prunes old ones", () => {
    const { database, store } = open_methods();
    const garden = store.add_context("Garden", null);
    const other = open_methods();
    const outgoing = sync_engine.collect_unpushed_changes(database);
    sync_engine.apply_changes(other.database, outgoing.changes);
    expect(other.store.list_item_history("context", garden).every((version) => version.origin === "elsewhere")).toBe(true);

    store.set_setting("history.keep_days", 1);
    prune_history(database, Date.now() + 3 * 24 * 60 * 60 * 1000);
    expect(store.list_item_history("context", garden)).toHaveLength(1);
  });
});
