import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { forget_item_prefixes, item_client } from "@x-tech-laboratories/x-libs/item_client";
import { hidden_secret } from "@x-tech-laboratories/x-libs/plugins";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "../../../src/server/app.ts";
import { use_plugins } from "../../../src/shared/collectors/host.ts";
import { offered_api } from "../../../src/shared/policy/policy.ts";
import { open_screen } from "../../../src/shared/privacy/screen.ts";
import { list_kinds, read_cursor } from "../../../src/shared/sources/collector.ts";
import { open_plugin_host } from "../../../src/shared/collectors/host.ts";
import { open_index, sync_documents } from "../../../src/shared/search/indexer.ts";
import { bind_methods, open_store } from "../../../src/shared/store.ts";
import { start_fake_item_app, type FakeItemApp } from "../../fixtures/fake_item_app.ts";

const token = "read-only-test-token";
let apps: FakeItemApp[] = [];

async function fake(options: Parameters<typeof start_fake_item_app>[0] = {}): Promise<FakeItemApp> {
  const app = await start_fake_item_app(options);
  apps.push(app);
  return app;
}

function store() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, calls: bind_methods(() => database, () => undefined) };
}

beforeEach(() => {
  use_plugins([]);
  forget_item_prefixes();
});

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

const notes = [
  { id: "n1", title: "Boiler service", notes: "Call the plumber about the boiler" },
  { id: "n2", title: "Garden tiles", notes: "Porcelain lasts" },
];

describe("apps read through the item calls", () => {
  it("are added after checking they answer, listed with their kinds and with their tokens hidden everywhere", async () => {
    const app = await fake({ notes });
    const { calls } = store();
    const id = await calls.add_item_source("Notes app", `${app.address}/`, token);
    expect(id).toBe("notes-app");
    expect(calls.list_item_sources()).toEqual([
      { id, name: "Notes app", address: app.address, has_token: true, kinds: [{ kind: "note", label: "Note" }], collector: "app.notes-app", mark_key: "codex.items/app.notes-app" },
    ]);
    const settings = calls.get_settings();
    expect(JSON.stringify(settings)).not.toContain(token);
    const listed = settings.item_sources as { token: string }[];
    expect(listed[0]!.token).toBe(hidden_secret);
    // A hidden token sent back, as a settings import does, keeps the one stored.
    calls.set_setting("item_sources", listed);
    expect((await calls.get_item_source_status(id)).ok).toBe(true);
    // A second app of the same name gets an id of its own.
    expect(await calls.add_item_source("Notes app", app.address, token)).toBe("notes-app-2");
  });

  it("say plainly when an app is unreachable, refuses the token or lacks an item call", async () => {
    const app = await fake({ notes });
    const { calls } = store();
    await expect(calls.add_item_source("Gone", "http://127.0.0.1:9/", token)).rejects.toThrow("Could not reach Gone at 127.0.0.1:9");
    await expect(calls.add_item_source("Notes", app.address, "wrong")).rejects.toThrow("Notes refused the token");
    await expect(calls.add_item_source("Notes", "ftp://example.org", token)).rejects.toThrow("starts with https://");
    await expect(calls.add_item_source("", app.address, token)).rejects.toThrow("Give the app a name");
    const no_kinds = await fake({ without: ["list_item_kinds"] });
    await expect(calls.add_item_source("Partial", no_kinds.address, token)).rejects.toThrow("Partial does not answer the item calls: list_item_kinds is missing.");
    expect(calls.list_item_sources()).toEqual([]);

    const no_search = await fake({ without: ["search_items"], prefix: "/api/call/" });
    const id = await calls.add_item_source("Partial", no_search.address, token);
    await expect(calls.search_collector(`app.${id}`, "boiler")).rejects.toThrow("Partial does not answer the item calls: search_items is missing.");
    await expect(calls.change_item_source(id, "Partial", no_search.address, "wrong")).rejects.toThrow("Partial refused the token");
    await no_search.close();
    expect(await calls.get_item_source_status(id)).toEqual({ ok: false, message: expect.stringContaining("Could not reach Partial"), kinds: [] });
    await expect(calls.get_item_source_status("nope")).rejects.toThrow("There is no app nope");
  });

  it("are called at the standard path first, and at the older one only for an app not yet on it", async () => {
    const standard = await fake({ notes, prefix: "/api/call/" });
    const older = await fake({ notes, prefix: "/api/" });
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      await list_kinds({ name: "Standard", address: standard.address, token });
      expect(fetched.mock.calls.map(([url]) => String(url))).toEqual([`${standard.address}/api/call/list_item_kinds`]);

      fetched.mockClear();
      await list_kinds({ name: "Older", address: older.address, token });
      await item_client({ name: "Older", address: older.address, token }).search_items("boiler", 5);
      expect(fetched.mock.calls.map(([url]) => String(url))).toEqual([
        `${older.address}/api/call/list_item_kinds`,
        `${older.address}/api/list_item_kinds`,
        `${older.address}/api/search_items`,
      ]);
    } finally {
      fetched.mockRestore();
    }
  });

  it("each become a collector of their own, whose items cannot collide with another app's", async () => {
    const first = await fake({ notes });
    const second = await fake({ notes: [{ id: "n1", title: "Boiler manual", notes: "" }], prefix: "/api/call/" });
    const { calls } = store();
    await calls.add_item_source("Notes", first.address, token);
    await calls.add_item_source("Manuals", second.address, token);
    const collectors = await calls.list_collectors();
    expect(collectors.filter((each) => each.id.startsWith("app.")).map((each) => [each.id, each.plugin_id, each.label, each.kinds, each.can_search, each.can_refresh])).toEqual([
      ["app.notes", "codex.items", "Notes", ["note"], true, true],
      ["app.manuals", "codex.items", "Manuals", ["note"], true, true],
    ]);
    const found = await calls.search_collector("app.notes", "boiler");
    expect(found).toEqual([
      { source_id: "n1", kind: "note", title: "Boiler service", snippet: "Call the plumber about the boiler", uri: "x-notes://note/n1", status: "", detail: { words: "6" }, kept_in: [] },
    ]);
    const home = calls.add_context("Home");
    const one = calls.add_item([home], "app.notes", found[0]!);
    const other = calls.add_item([home], "app.manuals", (await calls.search_collector("app.manuals", "boiler"))[0]!);
    expect([one, other]).toEqual(["app.notes:n1", "app.manuals:n1"]);
  });

  it("refresh by the changes since the last refresh, a deleted or missing item marked missing", async () => {
    const app = await fake({ notes });
    const { database, calls } = store();
    const id = await calls.add_item_source("Notes", app.address, token);
    const home = calls.add_context("Home");
    for (const found of await calls.search_collector("app.notes", "o")) calls.add_item([home], "app.notes", found);

    app.calls.length = 0;
    await calls.refresh_items();
    // The first refresh reads the items whole and keeps where it got to.
    expect(app.calls).toEqual(["get_items"]);
    expect(read_cursor(database, id)).toBe("2026-11-20T09:00:02.000Z");

    app.put({ id: "n1", title: "Boiler serviced", notes: "Done", done: true });
    app.remove("n2");
    app.calls.length = 0;
    const report = await calls.refresh_items();
    expect(app.calls).toEqual(["list_item_changes"]);
    expect(report).toMatchObject({ checked: 2, missing: 1, problems: [] });
    expect(calls.get_item("app.notes:n1")).toMatchObject({ title: "Boiler serviced", status: "done", snippet: "Done" });
    expect(calls.get_item("app.notes:n2").status).toBe("missing");

    // Nothing changed: one call, and every item stays as kept.
    app.calls.length = 0;
    expect(await calls.refresh_items()).toMatchObject({ checked: 2, updated: 0, missing: 0 });
    expect(app.calls).toEqual(["list_item_changes"]);
    expect(calls.get_item("app.notes:n2").status).toBe("missing");

    // A refresh of one context leaves the cursor where it was, so no change to another context's item is skipped.
    const before = read_cursor(database, id);
    const garden = calls.add_context("Garden");
    app.put({ id: "n3", title: "Gravel", notes: "" });
    calls.add_item([garden], "app.notes", (await calls.search_collector("app.notes", "gravel"))[0]!);
    app.put({ id: "n1", title: "Boiler again", notes: "" });
    await calls.refresh_items(garden);
    expect(read_cursor(database, id)).toBe(before);
    await calls.refresh_items();
    expect(calls.get_item("app.notes:n1").title).toBe("Boiler again");
  });

  it("give the index each item's snippet when the app has no text call", async () => {
    const app = await fake({ notes: [...notes, { id: "n3", title: "Empty", notes: "" }] });
    const { database, calls } = store();
    await calls.add_item_source("Notes", app.address, token);
    const collector = (await open_plugin_host(database)).providers("collector").find((each) => each.id === "app.notes")!.value;
    expect(await collector.content!(["n1", "n3", "gone"])).toEqual({ n1: "Call the plumber about the boiler" });
    expect(app.calls).not.toContain("get_item_texts");
  });

  it("give the index each item's full text for a kind that has it, and keep has_text with the kinds", async () => {
    const long = `# Boiler\n\n${"Call the plumber about the boiler. ".repeat(20)}`;
    const app = await fake({ with_text: true, notes: [{ id: "n1", title: "Boiler service", notes: long }, { id: "n3", title: "Empty", notes: "" }] });
    const { database, calls } = store();
    await calls.add_item_source("Notes", app.address, token);
    expect(calls.list_item_sources()[0]!.kinds).toEqual([{ kind: "note", label: "Note", has_text: true }]);
    const collector = (await open_plugin_host(database)).providers("collector").find((each) => each.id === "app.notes")!.value;
    expect(await collector.content!(["n1", "n3", "gone"])).toEqual({ n1: long });
    expect(app.calls).toContain("get_item_texts");
  });

  it("read an item's text into the index alone, and again only once its changed_at moved", async () => {
    const long = `${"Porcelain lasts longer than stone. ".repeat(10)}The grout is grey.`;
    const app = await fake({ with_text: true, notes: [{ id: "n1", title: "Garden tiles", notes: long }, { id: "n2", title: "Boiler", notes: "Short" }] });
    const { database, calls } = store();
    await calls.add_item_source("Notes", app.address, token);
    const home = calls.add_context("Home");
    for (const found of await calls.search_collector("app.notes", "e")) calls.add_item([home], "app.notes", found);
    await calls.refresh_items();
    const index = new DatabaseSync(":memory:");
    open_index(index);
    const text_reads = () => app.calls.filter((name) => name === "get_item_texts").length;
    const content_of = (id: string) => (index.prepare("SELECT content FROM docs WHERE key = ?").get(`item:app.notes:${id}`) as { content: string }).content;

    await sync_documents(database, index);
    expect(content_of("n1")).toBe(long);
    expect(calls.get_item("app.notes:n1").snippet.length).toBeLessThanOrEqual(200);
    // The store keeps the snippet the app gave, never the text.
    expect(JSON.stringify(database.prepare("SELECT * FROM items").all())).not.toContain("grout");
    const after_first = text_reads();
    expect(after_first).toBe(1);

    // Nothing moved: no text is read.
    await calls.refresh_items();
    await sync_documents(database, index);
    expect(text_reads()).toBe(after_first);

    // A change past the snippet moves changed_at, so the text is read again.
    const changed = long.replace("grey", "white");
    app.put({ id: "n1", title: "Garden tiles", notes: changed });
    await calls.refresh_items();
    await sync_documents(database, index);
    expect(text_reads()).toBe(after_first + 1);
    expect(content_of("n1")).toBe(changed);
  });

  it("are marked one by one, beside the plugins' own marks, and lose their marks when removed", async () => {
    const app = await fake({ notes });
    const { database, calls } = store();
    const { x_tasks_plugin } = await import("../../../src/shared/collectors/bundled.ts");
    use_plugins([x_tasks_plugin]);
    calls.set_source_mark("codex.x-tasks", "trusted", true);
    await calls.add_item_source("Notes", app.address, token);
    await calls.add_item_source("Mail", app.address, token);
    calls.set_source_mark("codex.items/app.notes", "send_to_hosted", true);

    expect(await calls.list_source_marks()).toEqual([
      { plugin_id: "codex.x-tasks", name: "X-Tasks", collectors: ["x-tasks"], send_to_hosted: false, trusted: true },
      { plugin_id: "codex.items/app.notes", name: "Notes", collectors: ["app.notes"], send_to_hosted: true, trusted: false },
      { plugin_id: "codex.items/app.mail", name: "Mail", collectors: ["app.mail"], send_to_hosted: false, trusted: false },
    ]);
    const screen = await open_screen(database, true);
    expect([screen.mark_of("x-tasks"), screen.mark_of("app.notes"), screen.mark_of("app.mail")]).toEqual([
      { send_to_hosted: false, trusted: true },
      { send_to_hosted: true, trusted: false },
      { send_to_hosted: false, trusted: false },
    ]);
    expect(screen.label_of("app.notes")).toBe("Notes");

    calls.remove_item_source("notes");
    expect(Object.keys(calls.get_settings().source_marks as object)).toEqual(["codex.x-tasks"]);
    expect(calls.list_item_sources().map((each) => each.id)).toEqual(["mail"]);
    expect(() => calls.remove_item_source("notes")).toThrow("There is no app notes");
  });

  it("are never offered to engines", () => {
    for (const name of ["list_item_sources", "get_item_source_status", "add_item_source", "change_item_source", "remove_item_source"]) expect(offered_api).not.toHaveProperty(name);
  });
});

describe("apps on the server", () => {
  let server: FastifyInstance;
  afterEach(async () => server?.close());

  it("are added, changed and removed only by the user at the page, never by a token", async () => {
    const app = await fake({ notes });
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const backups = { list_backups: async () => [], create_backup: vi.fn(), restore_backup: vi.fn(), remove_backup: vi.fn(), get_backup_schedule: () => ({ automatic: true, to_keep: 14 }), set_backup_schedule: vi.fn() };
    const password = "a long enough password";
    server = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups: backups as never });
    const login = await server.inject({ method: "POST", url: "/api/login", payload: { name: "root", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const made = await server.inject({ method: "POST", url: "/api/account/tokens", headers: { cookie }, payload: { name: "script", read_only: false } });
    const program = { authorization: `Bearer ${made.json<{ token: string }>().token}` };

    const refused = await server.inject({ method: "POST", url: "/api/call/add_item_source", headers: program, payload: ["Notes", app.address, token] });
    expect(refused.statusCode).toBe(403);
    const setting = await server.inject({ method: "POST", url: "/api/call/set_setting", headers: program, payload: ["item_sources", []] });
    expect(setting.statusCode).toBe(403);
    const added = await server.inject({ method: "POST", url: "/api/call/add_item_source", headers: { cookie }, payload: { name: "Notes", address: app.address, token } });
    expect(added.json()).toBe("notes");
    for (const [method, args] of [["change_item_source", ["notes", "Notes", app.address, null]], ["remove_item_source", ["notes"]]] as const) {
      expect((await server.inject({ method: "POST", url: `/api/call/${method}`, headers: program, payload: args })).statusCode).toBe(403);
    }
    const listed = await server.inject({ method: "POST", url: "/api/call/list_item_sources", headers: program, payload: [] });
    expect(listed.body).not.toContain(token);
    expect(listed.json<{ id: string }[]>().map((each) => each.id)).toEqual(["notes"]);
  });
});
