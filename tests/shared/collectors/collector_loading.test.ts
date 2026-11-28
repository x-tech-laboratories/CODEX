import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { use_plugins } from "../../../src/shared/collectors/host.ts";
import { bind_methods, open_store } from "../../../src/shared/store.ts";
import { load_collectors } from "../../../src/server/collectors/index.ts";

async function labels_running(): Promise<string[]> {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return (await bind_methods(() => database, () => undefined).list_collectors()).map((collector) => collector.label);
}

afterEach(() => {
  use_plugins([]);
  vi.restoreAllMocks();
});

describe("loading the collectors", () => {
  it("hands the store the bundled collectors, and the desktop's only on the desktop", async () => {
    await load_collectors(null);
    const on_server = await labels_running();
    expect(on_server).toContain("Web links");
    expect(on_server).not.toContain("Firefox bookmarks");

    await load_collectors(null, true);
    expect((await labels_running()).length).toBeGreaterThanOrEqual(on_server.length);
  });

  it("reports a broken plugin in the plugins folder and loads the rest", async () => {
    const folder = mkdtempSync(join(tmpdir(), "codex-plugins-"));
    try {
      mkdirSync(join(folder, "broken"));
      writeFileSync(join(folder, "broken", "package.json"), "{ not json");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await load_collectors(folder);
      expect(warn.mock.calls.flat().join(" ")).toContain("plugin broken");
      expect(await labels_running()).toContain("Web links");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
