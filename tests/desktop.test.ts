import { DatabaseSync } from "node:sqlite";

import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { EventStream } from "@x-tech-laboratories/x-libs/server/events";

import { register_context_calls } from "../src/server/calls.ts";
import { open_store } from "../src/shared/store.ts";
import { desktop_setting_defaults, read_desktop_settings, starts_hidden } from "../src/shared/desktop.ts";
import { tray_view, type TrayActions, type TrayState } from "../src/main/tray_menu.ts";
import type { ContextSummary } from "../src/shared/contexts/model.ts";

// ============================================================================
// Desktop settings
// ============================================================================

describe("the desktop settings", () => {
  it("are all on when none were saved", () => {
    expect(read_desktop_settings(null)).toEqual(desktop_setting_defaults);
    expect(desktop_setting_defaults).toEqual({ show_tray_icon: true, keep_running_in_background: true, start_at_login: true });
  });

  it("keep what was saved and default anything damaged", () => {
    expect(read_desktop_settings({ show_tray_icon: false, start_at_login: "yes" })).toEqual({ show_tray_icon: false, keep_running_in_background: true, start_at_login: true });
  });

  it("start hidden only when asked and there is a tray icon to open the window from", () => {
    expect(starts_hidden(["electron", "app", "--hidden"], true)).toBe(true);
    expect(starts_hidden(["electron", "app", "--hidden"], false)).toBe(false);
    expect(starts_hidden(["electron", "app"], true)).toBe(false);
  });
});

// ============================================================================
// Tray menu
// ============================================================================

const context = (id: string, name: string, parent_id: string | null = null): ContextSummary => ({ id, name, parent_id, position: 0, is_archived: false, item_count: 0 });

describe("the tray menu", () => {
  const actions = (): TrayActions => ({ open_route: vi.fn(), show: vi.fn(), quit: vi.fn(), quit_completely: vi.fn() });
  const labels = (state: TrayState) => tray_view(state, actions()).rows.map((row) => (row.kind === "item" ? row.label : "—"));

  it("lists the top-level contexts, then the commands", () => {
    const state: TrayState = { contexts: [context("a", "Garden"), context("b", "Beds", "a"), context("c", "Taxes")] };

    expect(labels(state)).toEqual(["Garden", "Taxes", "—", "Show CODEX", "Quit", "Quit completely"]);
    expect(tray_view(state, actions()).tooltip).toBe("CODEX");
  });

  it("opens the window on the context a row names", () => {
    const done = actions();
    const rows = tray_view({ contexts: [context("a", "Garden")] }, done).rows.filter((row) => row.kind === "item");

    for (const row of rows) row.run();

    expect(done.open_route).toHaveBeenCalledWith("#/context/a");
    expect(done.quit_completely).toHaveBeenCalled();
  });

  it("shows only the commands when there are no contexts", () => {
    expect(labels({ contexts: [] })).toEqual(["Show CODEX", "Quit", "Quit completely"]);
  });
});

// ============================================================================
// Data calls over HTTP
// ============================================================================

describe("the data calls over HTTP", () => {
  it("send a call's text answer as JSON, so the window can read it", async () => {
    const app = fastify();
    const database = new DatabaseSync(":memory:");
    open_store(database);
    register_context_calls(app, () => database, new EventStream(), () => true);

    const started = await app.inject({ method: "POST", url: "/call/add_context", payload: ["Garden", null] });

    expect(started.headers["content-type"]).toContain("application/json");
    expect(typeof JSON.parse(started.body)).toBe("string");
    await app.close();
  });

  it("let the desktop window set a level, and refuse it to anything not the page", async () => {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const window = fastify();
    register_context_calls(window, () => database, new EventStream(), () => true);
    const program = fastify();
    register_context_calls(program, () => database, new EventStream(), () => false);

    const set = await window.inject({ method: "POST", url: "/call/set_action_level", payload: ["rename_context", "auto"] });
    const refused = await program.inject({ method: "POST", url: "/call/set_action_level", payload: ["rename_context", "background"] });

    expect(set.statusCode).toBe(204);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("Only you can do this");
    const policy = await program.inject({ method: "POST", url: "/call/get_action_policy", payload: [] });
    expect((policy.json() as { method: string; level: string }[]).find((entry) => entry.method === "rename_context")!.level).toBe("auto");
    await window.close();
    await program.close();
  });
});
