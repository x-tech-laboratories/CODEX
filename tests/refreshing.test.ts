import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../src/shared/collectors/collector.ts";
import { use_plugins, type ContextPluginApi } from "../src/shared/collectors/host.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";
import { keep_refreshing } from "../src/server/refreshing.ts";
import { register_device } from "../src/shared/jobs/records.ts";

// A collector whose app says each item's title, or fails when asked to.
function tasks_plugin(answer: () => Promise<Record<string, { source_id: string; kind: string; title: string }>>) {
  return define_plugin<ContextPluginApi>({
    id: "tests.tasks",
    name: "Tasks",
    version: "1.0.0",
    app: app_info.id,
    start: (context) => context.provide("collector", "tasks", { label: "Tasks", kinds: ["task"], resolve: async () => answer() }),
  });
}

function open_database() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const store = bind_methods(() => database, () => undefined);
  // This device is the one that runs background work.
  register_device(database, "Test laptop", "desktop", Date.now());
  const garden = store.add_context("Garden", null);
  store.add_item([garden], "tasks", { source_id: "t1", kind: "task", title: "Order seeds" }, "");
  return { database, store, garden };
}

afterEach(() => {
  use_plugins([]);
  vi.restoreAllMocks();
});

describe("refreshing in the background", () => {
  it("refreshes once the set minutes have passed, and not again before", async () => {
    use_plugins([tasks_plugin(async () => ({ t1: { source_id: "t1", kind: "task", title: "Order more seeds" } }))]);
    const { database, store, garden } = open_database();
    let clock = 60 * 60_000;
    const reports: number[] = [];
    const on_change = vi.fn();
    const refreshing = keep_refreshing(() => database, { on_change, on_report: (report) => reports.push(report.updated), now: () => clock });

    await refreshing.check();
    expect(reports).toEqual([1]);
    expect(store.get_context(garden).items[0]!.title).toBe("Order more seeds");
    expect(on_change).toHaveBeenCalled();

    clock += 29 * 60_000;
    await refreshing.check();
    expect(reports).toEqual([1]);
    clock += 60_000;
    await refreshing.check();
    expect(reports).toEqual([1, 0]);
    refreshing.stop();
  });

  it("refreshes only on the device chosen for background work, and not while it is paused", async () => {
    use_plugins([tasks_plugin(async () => ({ t1: { source_id: "t1", kind: "task", title: "Order more seeds" } }))]);
    const { database, store } = open_database();
    const on_report = vi.fn();
    const refreshing = keep_refreshing(() => database, { on_report });
    store.set_setting("background.paused", true);
    await refreshing.check();
    store.set_setting("background.paused", false);
    store.set_setting("background.device", "another-device");
    await refreshing.check();
    expect(on_report).not.toHaveBeenCalled();
    refreshing.stop();
  });

  it("refreshes nothing while refresh_minutes is off", async () => {
    const { database, store } = open_database();
    store.set_setting("refresh_minutes", 0);
    const on_report = vi.fn();
    const refreshing = keep_refreshing(() => database, { on_report });
    await refreshing.check();
    expect(on_report).not.toHaveBeenCalled();
    refreshing.stop();
  });

  it("logs each collector that could not answer", async () => {
    use_plugins([tasks_plugin(async () => Promise.reject(new Error("Tasks is down")))]);
    const { database } = open_database();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const on_report = vi.fn();
    const refreshing = keep_refreshing(() => database, { on_report });
    await refreshing.check();
    expect(warn.mock.calls.flat().join(" ")).toContain("Tasks is down");
    expect(on_report).toHaveBeenCalledOnce();
    refreshing.stop();
  });

  it("checks each minute on its own", async () => {
    vi.useFakeTimers();
    try {
      const { database } = open_database();
      const on_report = vi.fn();
      const refreshing = keep_refreshing(() => database, { on_report, now: () => 60 * 60_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(on_report).toHaveBeenCalledOnce();
      refreshing.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
