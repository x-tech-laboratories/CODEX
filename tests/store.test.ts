import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { hidden_secret } from "@x-tech-laboratories/x-libs/plugins";

import { bind_methods, is_read_only, needs_upgrade, open_store, setting_defaults } from "../src/shared/store.ts";

function open_database(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return database;
}

describe("store", () => {
  it("records each feature's schema version and opens again without redoing a step", () => {
    const database = open_database();
    open_store(database);
    const versions = database.prepare("SELECT owner, version FROM schema_versions WHERE owner IN ('settings', 'contexts') ORDER BY owner").all().map((row) => ({ ...row }));
    expect(versions).toEqual([
      { owner: "contexts", version: 4 },
      { owner: "settings", version: 1 },
    ]);
  });

  it("tells a database that is behind on a feature's schema, but not a new or current one, so it is backed up first", () => {
    expect(needs_upgrade(new DatabaseSync(":memory:"))).toBe(false);
    const database = open_database();
    expect(needs_upgrade(database)).toBe(false);
    database.prepare("UPDATE schema_versions SET version = version - 1 WHERE owner = 'contexts'").run();
    expect(needs_upgrade(database)).toBe(true);
  });

  it("keeps settings as JSON and gives every one, the ones never set at their defaults", () => {
    const database = open_database();
    const bound = bind_methods(() => database, () => undefined);
    expect(bound.get_settings()).toEqual(setting_defaults);
    bound.set_setting("refresh_minutes", 5);
    expect(bound.get_settings()).toEqual({ ...setting_defaults, refresh_minutes: 5 });
  });

  it("hides a plugin's key from what it reads, and keeps the stored key when the hidden one comes back", () => {
    const database = open_database();
    const bound = bind_methods(() => database, () => undefined);
    bound.set_setting("plugins", { "codex.trilium": { enabled: true, settings: { address: "https://notes.example.org", token: "real-token" } } });

    const shown = bound.get_settings().plugins as Record<string, { settings: Record<string, unknown> }>;
    expect(shown["codex.trilium"]!.settings).toEqual({ address: "https://notes.example.org", token: hidden_secret });

    bound.set_setting("plugins", { "codex.trilium": { enabled: true, settings: { address: "https://other.example.org", token: hidden_secret } } });
    const stored = JSON.parse((database.prepare("SELECT value FROM settings WHERE key = 'plugins'").get() as { value: string }).value);
    expect(stored["codex.trilium"].settings).toEqual({ address: "https://other.example.org", token: "real-token" });
  });

  it("announces writes and not reads", () => {
    const database = open_database();
    const on_change = vi.fn();
    const bound = bind_methods(() => database, on_change);
    bound.list_contexts(false);
    expect(on_change).not.toHaveBeenCalled();
    bound.add_context("Garden", null);
    expect(on_change).toHaveBeenCalledOnce();
    expect(is_read_only("search_collector")).toBe(true);
    expect(is_read_only("refresh_items")).toBe(false);
  });
});
