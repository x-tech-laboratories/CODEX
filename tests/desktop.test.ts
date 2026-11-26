import { DatabaseSync } from "node:sqlite";

import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { calls_under, register_accounts } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { register_context_calls } from "../src/server/calls.ts";
import { open_store, page_only } from "../src/shared/store.ts";
import { desktop_setting_defaults, first_window_size, read_desktop_settings, starts_hidden } from "../src/shared/desktop.ts";
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
    register_context_calls(app, () => database, new EventStream());

    const started = await app.inject({ method: "POST", url: "/call/add_context", payload: ["Garden", null] });

    expect(started.headers["content-type"]).toContain("application/json");
    expect(typeof JSON.parse(started.body)).toBe("string");
    await app.close();
  });

  it("let the desktop window set a level, and refuse it to anything not the page", async () => {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const window = fastify();
    register_context_calls(window, () => database, new EventStream());
    // A program reaches the calls through the server, whose sign-in refuses a token what only the page may do.
    const program = fastify();
    const accounts = new AccountStore({ database: new DatabaseSync(":memory:"), app_name: "CODEX", declared: new Map([["root", hash_password("a long enough password")]]) });
    await register_accounts(program, { accounts, cookie_name: "codex_session", call_of: calls_under("/api/call"), page_only });
    await program.register(async (api) => register_context_calls(api, () => database, new EventStream()), { prefix: "/api" });
    const headers = { authorization: `Bearer ${accounts.create_token("root", { name: "script", read_only: false }).token}` };

    const set = await window.inject({ method: "POST", url: "/call/set_action_level", payload: ["rename_context", "auto"] });
    const refused = await program.inject({ method: "POST", url: "/api/call/set_action_level", headers, payload: ["rename_context", "background"] });

    expect(set.statusCode).toBe(204);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("Only you can do this");
    const policy = await program.inject({ method: "POST", url: "/api/call/get_action_policy", headers, payload: [] });
    expect((policy.json() as { method: string; level: string }[]).find((entry) => entry.method === "rename_context")!.level).toBe("auto");
    await window.close();
    await program.close();
  });
});

describe("the first window's size", () => {
  it("takes most of the screen, keeps a sensible least and most, and never passes the screen", () => {
    expect(first_window_size({ width: 1600, height: 1000 })).toEqual({ width: 1360, height: 880 });
    expect(first_window_size({ width: 3840, height: 2160 })).toEqual({ width: 1800, height: 1200 });
    expect(first_window_size({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });
});
