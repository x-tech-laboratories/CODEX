import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "../src/server/app.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { route_of_link } from "../src/shared/links.ts";
import { offered_api } from "../src/shared/policy/policy.ts";
import { bind_methods, context_api, open_store } from "../src/shared/store.ts";

function store() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return { database, calls: bind_methods(() => database, () => undefined) };
}

function say(database: DatabaseSync, conversation_id: string, role: string, text: string, at: string): void {
  database
    .prepare("INSERT INTO conversation_messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), conversation_id, role, text, at);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the item calls", () => {
  it("names CODEX's own kinds", async () => {
    const { calls } = store();
    expect(await calls.list_item_kinds()).toEqual([
      { kind: "context", label: "Context", has_text: true },
      { kind: "conversation", label: "Conversation", has_text: false },
      { kind: "entity", label: "Entity", has_text: false },
      { kind: "blueprint", label: "Blueprint", has_text: true },
    ]);
  });

  it("gives a context's notes and a blueprint's body as Markdown text, and nothing of conversations or entities", async () => {
    const { database, calls } = store();
    const notes = `Tiles from the **garden** centre.\n\n${"More about the tiles. ".repeat(20)}`;
    const kitchen = calls.add_context("Kitchen", null);
    calls.set_context_notes(kitchen, notes);
    const empty = calls.add_context("Empty");
    const blueprint = calls.add_blueprint("Weekly review", "When the user asks for the weekly review.", "1. List open tasks.", null);
    const talk = add_conversation_record(database, kitchen);
    say(database, talk, "user", "A secret message.", "2026-11-20T10:00:00.000Z");
    const entity = calls.add_entity("person", "Ada");

    const ids = [`context:${kitchen}`, `context:${empty}`, `blueprint:${blueprint}`, `conversation:${talk}`, `entity:${entity}`, "context:gone", "nonsense"];
    const texts = await calls.get_item_texts(ids);
    const [kitchen_item, blueprint_item] = await calls.get_items([`context:${kitchen}`, `blueprint:${blueprint}`]);
    expect(texts).toEqual([
      { id: `context:${kitchen}`, text: notes, format: "markdown", changed_at: kitchen_item!.changed_at, is_truncated: false },
      { id: `blueprint:${blueprint}`, text: "1. List open tasks.", format: "markdown", changed_at: blueprint_item!.changed_at, is_truncated: false },
    ]);
    expect(JSON.stringify(texts)).not.toContain("secret");
  });

  it("finds contexts by name and notes, conversations by title, entities by their names, titles first", async () => {
    const { database, calls } = store();
    const kitchen = calls.add_context("Kitchen renovation");
    calls.set_context_notes(kitchen, "Tiles from the **garden** centre.");
    const garden = calls.add_context("Garden");
    const talk = add_conversation_record(database, kitchen);
    say(database, talk, "user", "Which garden tiles last longest?\nAnd a secret second line.", "2026-11-20T10:00:00.000Z");
    say(database, talk, "assistant", "Porcelain ones, private words.", "2026-11-20T10:00:05.000Z");
    const entity = calls.add_entity("place", "Garden centre", ["Plant shop"]);

    const found = await calls.search_items("garden");
    expect(found.map((item) => item.id)).toEqual([`context:${garden}`, `conversation:${talk}`, `entity:${entity}`, `context:${kitchen}`]);
    const [garden_item, talk_item, entity_item, kitchen_item] = found;
    expect(garden_item).toMatchObject({ kind: "context", title: "Garden", link: `codex://context/${garden}`, status: "" });
    expect(kitchen_item!.snippet).toBe("Tiles from the **garden** centre.");
    expect(talk_item).toMatchObject({ kind: "conversation", title: "Which garden tiles last longest?", link: `codex://conversation/${talk}`, snippet: "A conversation in Kitchen renovation." });
    expect(talk_item!.detail).toEqual({ last_used_at: "2026-11-20T10:00:05.000Z", messages: "2", contexts: "Kitchen renovation" });
    // A conversation's messages never leave through these calls, only its title.
    expect(JSON.stringify(found)).not.toMatch(/secret|Porcelain|private/);
    expect(entity_item).toMatchObject({ kind: "entity", title: "Garden centre", snippet: "A place, also known as Plant shop.", link: `codex://entity/${entity}`, status: "accepted" });
    expect((await calls.search_items("plant shop")).map((item) => item.id)).toEqual([`entity:${entity}`]);
    expect(await calls.search_items("nothing like this")).toEqual([]);
    expect(await calls.search_items("garden", 1)).toHaveLength(1);
  });

  it("finds a conversation by the note on it", async () => {
    const { database, calls } = store();
    const home = calls.add_context("Home");
    const talk = add_conversation_record(database, home);
    calls.set_item_note(home, `conversation:${talk}`, "About the boiler");
    expect((await calls.search_items("boiler")).map((item) => item.id)).toEqual([`conversation:${talk}`]);
  });

  it("gets items by id as they are now, leaving out what is gone or not CODEX's", async () => {
    const { database, calls } = store();
    const home = calls.add_context("Home");
    const child = calls.add_context("Garden", home);
    calls.set_context_archived(child, true);
    const talk = add_conversation_record(database, null);
    const entity = calls.add_entity("person", "Ada");
    const got = await calls.get_items([`entity:${entity}`, `context:${child}`, `conversation:${talk}`, "context:nope", "x-tasks:t1", "nonsense", "context:"]);
    expect(got.map((item) => item.id)).toEqual([`entity:${entity}`, `context:${child}`, `conversation:${talk}`]);
    expect(got[1]).toMatchObject({ status: "archived", detail: { parent: `context:${home}`, items: "0" } });
    expect(got[2]).toMatchObject({ title: "New conversation", snippet: "A conversation in Global." });
    expect(got[0]!.changed_at).toMatch(/^\d{4}-/);
  });

  it("lists changes oldest first from History and the conversations, deletions included, missing nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T09:00:00.000Z"));
    const { database, calls } = store();
    const home = calls.add_context("Home");
    const entity = calls.add_entity("topic", "Boilers");
    const talk = add_conversation_record(database, home);

    const first = await calls.list_item_changes();
    expect(first.map((change) => change.id).sort()).toEqual(["context:global", `context:${home}`, `conversation:${talk}`, `entity:${entity}`].sort());
    const since = first.at(-1)!.changed_at;
    expect(await calls.list_item_changes(since)).toEqual([]);

    vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
    calls.rename_conversation(talk, "Boiler service");
    calls.rename_context(home, "House");
    const second = await calls.list_item_changes(since);
    expect(second.map((change) => [change.id, change.is_deleted])).toEqual([
      [`context:${home}`, false],
      [`conversation:${talk}`, false],
    ]);
    expect(second[1]).toMatchObject({ title: "Boiler service", changed_at: "2026-11-20T10:00:00.000Z" });
    expect(second[0]).toMatchObject({ title: "House" });

    vi.setSystemTime(new Date("2026-11-20T11:00:00.000Z"));
    calls.delete_conversation(talk);
    calls.remove_entity(entity);
    const third = await calls.list_item_changes(second.at(-1)!.changed_at);
    expect(third.map((change) => [change.id, change.kind, change.is_deleted]).sort()).toEqual(
      [
        // The context no longer holds the conversation, so it changed too.
        [`context:${home}`, "context", false],
        [`conversation:${talk}`, "conversation", true],
        [`entity:${entity}`, "entity", true],
      ].sort(),
    );
    expect(await calls.get_items([`conversation:${talk}`, `entity:${entity}`])).toEqual([]);
    // A deletion is told once; asking again from its moment gives nothing more.
    expect(await calls.list_item_changes(third.at(-1)!.changed_at)).toEqual([]);
    expect((await calls.list_item_changes(null, 1)).length).toBeGreaterThanOrEqual(1);
  });

  it("are read-only calls, never offered to engines", () => {
    for (const name of ["list_item_kinds", "search_items", "get_items", "list_item_changes", "get_item_texts"]) {
      expect(context_api).toHaveProperty(name);
      expect(offered_api).not.toHaveProperty(name);
    }
  });
});

describe("an entity's link", () => {
  it("opens the Graph page on the entity", () => {
    expect(route_of_link("codex://entity/e1")).toBe(`#/graph/${encodeURIComponent("entity:e1")}`);
    expect(route_of_link("codex://entity/e1/")).toBe(`#/graph/${encodeURIComponent("entity:e1")}`);
    expect(route_of_link("codex://conversation/c1")).toBe("#/conversation/c1");
  });
});

describe("the item calls on the server", () => {
  let app: FastifyInstance;
  const password = "a long enough password";
  afterEach(async () => app?.close());

  async function start() {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const backups = { list_backups: async () => [], create_backup: vi.fn(), restore_backup: vi.fn(), remove_backup: vi.fn(), get_backup_schedule: () => ({ automatic: true, to_keep: 14 }), set_backup_schedule: vi.fn() };
    app = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder: "/nonexistent", backups: backups as never });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const made = await app.inject({ method: "POST", url: "/api/account/tokens", headers: { cookie }, payload: { name: "reader", read_only: true } });
    const reader = { authorization: `Bearer ${made.json<{ token: string }>().token}` };
    await app.inject({ method: "POST", url: "/api/call/add_context", headers: { cookie }, payload: ["Garden"] });
    return reader;
  }

  it("answers a read-only token over REST, by name or in order, and still refuses it a change", async () => {
    const reader = await start();
    const by_name = await app.inject({ method: "POST", url: "/api/call/search_items", headers: reader, payload: { query: "garden" } });
    expect(by_name.statusCode).toBe(200);
    expect(by_name.json<{ title: string }[]>().map((item) => item.title)).toEqual(["Garden"]);
    const kinds = await app.inject({ method: "POST", url: "/api/call/list_item_kinds", headers: reader, payload: [] });
    expect(kinds.json<unknown[]>()).toHaveLength(4);
    const changes = await app.inject({ method: "POST", url: "/api/call/list_item_changes", headers: reader, payload: { since: null, limit: 5 } });
    // Global, first seen when the store opened, and the garden.
    expect(changes.json<unknown[]>()).toHaveLength(2);
    const garden = changes.json<{ id: string }[]>().find((change) => change.id !== "context:global");
    const texts = await app.inject({ method: "POST", url: "/api/call/get_item_texts", headers: reader, payload: { ids: [garden!.id] } });
    expect(texts.statusCode).toBe(200);
    expect(texts.json<unknown[]>()).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/call/add_context", headers: reader, payload: ["Nope"] })).statusCode).toBe(403);
  });

  it("lists them in the OpenAPI document as reads and serves them over MCP as read-only tools", async () => {
    const reader = await start();
    const openapi = (await app.inject({ method: "GET", url: "/api/openapi.json", headers: reader })).json<{ paths: Record<string, { post: { operationId: string; tags: string[] } }> }>();
    for (const name of ["list_item_kinds", "search_items", "get_items", "list_item_changes", "get_item_texts"]) expect(openapi.paths[`/api/call/${name}`]!.post).toMatchObject({ operationId: name, tags: ["read"] });
    const reply = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { ...reader, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const data = /^data: (.+)$/m.exec(reply.body)?.[1] ?? reply.body;
    const tools = (JSON.parse(data) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools;
    const search = tools.find((tool) => tool.name === "search_items");
    expect(search?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "get_item_texts")?.annotations?.readOnlyHint).toBe(true);
  });
});
