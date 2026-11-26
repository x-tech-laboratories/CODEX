import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { hash_password } from "@x-tech-laboratories/x-libs/server/passwords";
import { create_sync_client } from "@x-tech-laboratories/x-libs/sync_client";
import type { SyncConfig } from "@x-tech-laboratories/x-libs/sync_protocol";

import { build_app } from "../src/server/app.ts";
import { use_plugins, type ContextPluginApi } from "../src/shared/collectors/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import { method_names, open_store, page_only, sync_engine } from "../src/shared/store.ts";
import { user_only_settings } from "../src/shared/page_api.ts";
import { register_context_calls } from "../src/server/calls.ts";
import fastify from "fastify";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";

let app: FastifyInstance;
// The token every request but the sign-in tests carries.
let token = "";
const password = "a long enough password";

afterEach(async () => {
  await app?.close();
});

// Sends one MCP request as a client speaking the 2025 protocol would, and gives back its result.
async function mcp(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
  const reply = await signed({
    method: "POST",
    url: "/api/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = /^data: (.+)$/m.exec(reply.body)?.[1] ?? reply.body;
  return (JSON.parse(data) as { result: Record<string, unknown> }).result;
}

const taken = { name: "context-2026-11-10T09-30-00Z.db", taken_at: "2026-11-10T09:30:00Z", is_automatic: false, size_bytes: 4096 };
const fake_backups = {
  list_backups: vi.fn(async () => [taken]),
  create_backup: vi.fn(async () => taken),
  restore_backup: vi.fn(async () => undefined),
  remove_backup: vi.fn(async () => undefined),
  get_backup_schedule: vi.fn(() => ({ automatic: true, to_keep: 14 })),
  set_backup_schedule: vi.fn(),
};

async function start(web_folder = "/nonexistent"): Promise<FastifyInstance> {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  app = await build_app({ database, declared: new Map([["root", hash_password(password)]]), web_folder, backups: fake_backups });
  token = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password, device: "tests" } })).json().token;
  page_cookie = "";
  return app;
}

// A request as the signed-in tests device.
function signed(options: InjectOptions) {
  return app.inject({ ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
}

// A request as the user at the page: a browser signed in with a password, once per server, as sign-ins are limited.
let page_cookie = "";
async function as_page(options: InjectOptions) {
  if (!page_cookie) {
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password } });
    page_cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  }
  return app.inject({ ...options, headers: { ...options.headers, cookie: page_cookie } });
}

describe("server", () => {
  it("refuses API calls until signed in, but serves the page", async () => {
    await start();
    expect((await app.inject({ method: "POST", url: "/api/call/get_settings", payload: [] })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/mcp", payload: {} })).statusCode).toBe(401);
    expect((await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).statusCode).toBe(200);
  });

  it("serves the built page beside the API", async () => {
    const folder = mkdtempSync(join(tmpdir(), "codex-web-"));
    writeFileSync(join(folder, "index.html"), "<title>CODEX</title>");
    await start(folder);
    expect((await signed({ method: "GET", url: "/" })).body).toContain("CODEX");
    expect((await signed({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
  });

  it("answers the page's calls by name with JSON arguments", async () => {
    await start();
    const write = await signed({ method: "POST", url: "/api/call/set_setting", payload: ["refresh_minutes", 5] });
    expect(write.statusCode).toBe(204);
    const read = await signed({ method: "POST", url: "/api/call/get_settings", payload: [] });
    expect(read.json()).toMatchObject({ refresh_minutes: 5, "history.keep_days": 180 });
  });

  it("takes a call whose argument is a large import file", async () => {
    await start();
    const big = JSON.stringify({ log: "x".repeat(3 * 1024 * 1024) });
    const reply = await signed({ method: "POST", url: "/api/call/set_setting", payload: ["import.test", big] });
    expect(reply.statusCode).toBe(204);
  });

  it("takes the arguments by name as a JSON object too", async () => {
    await start();
    const write = await signed({ method: "POST", url: "/api/call/set_setting", payload: { value: 15, key: "refresh_minutes" } });
    expect(write.statusCode).toBe(204);
    expect((await signed({ method: "POST", url: "/api/call/get_settings", payload: {} })).json()).toMatchObject({ refresh_minutes: 15 });
  });

  it("refuses arguments it cannot place and calls it does not know", async () => {
    await start();
    const unknown_name = await signed({ method: "POST", url: "/api/call/get_settings", payload: { not: "an argument" } });
    expect(unknown_name.statusCode).toBe(400);
    expect(unknown_name.body).toBe("unknown argument not");
    expect((await signed({ method: "POST", url: "/api/call/set_setting", payload: { key: "refresh_minutes" } })).statusCode).toBe(400);
    expect((await signed({ method: "POST", url: "/api/call/drop_everything", payload: [] })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("describes every call in an OpenAPI document", async () => {
    await start();
    const document = (await signed({ method: "GET", url: "/api/openapi.json" })).json() as { paths: Record<string, { post: { operationId: string; tags: string[] } }> };
    expect(document.paths["/api/call/get_context"]!.post).toMatchObject({ operationId: "get_context", tags: ["read"] });
    expect(document.paths["/api/call/add_item"]!.post.tags).toEqual(["change"]);
    expect(Object.keys(document.paths)).toHaveLength(method_names.length);
    // The calls only the user at the page may make are marked so.
    expect(document.paths["/api/call/resolve_proposal"]!.post).toMatchObject({ "x-page-only": true });
    expect(document.paths["/api/call/accept_graph_proposals"]!.post).toMatchObject({ "x-page-only": true });
    expect(document.paths["/api/call/reject_graph_proposals"]!.post).toMatchObject({ "x-page-only": true });
    expect(document.paths["/api/call/add_item"]!.post).not.toHaveProperty("x-page-only");
  });

  it("serves every call as an MCP tool, keeping other services' keys out of what it reads", async () => {
    await start();
    const listed = await mcp("tools/list");
    const tools = listed.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    // Approving a change and setting a level are the user's alone, so no MCP client is offered them.
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      method_names.filter((name) => !["resolve_proposal", "undo_change", "set_action_level", "set_source_mark", "accept_graph_proposals", "reject_graph_proposals", "add_item_source", "change_item_source", "remove_item_source", "accept_blueprint_proposals", "reject_blueprint_proposals", "restore_blueprint", "place_blueprint", "set_job_on", "run_job_now", "set_background_device"].includes(name)).sort(),
    );
    expect(tools.some((tool) => tool.name === "get_action_policy" || tool.name === "list_proposals")).toBe(true);
    expect(tools.find((tool) => tool.name === "list_contexts")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "add_context")!.annotations.readOnlyHint).toBe(false);

    const added = await mcp("tools/call", { name: "add_context", arguments: { name: "Garden", parent_id: null } });
    const context_id = (added.content as { text: string }[])[0]!.text;
    const listed_contexts = await mcp("tools/call", { name: "list_contexts", arguments: {} });
    expect(JSON.parse((listed_contexts.content as { text: string }[])[0]!.text)).toContainEqual(expect.objectContaining({ id: context_id, name: "Garden" }));

    const plugins = { "codex.trilium": { enabled: true, settings: { address: "https://notes.example.org", token: "not-a-real-token" } } };
    expect((await as_page({ method: "POST", url: "/api/call/set_setting", payload: ["plugins", plugins] })).statusCode).toBe(204);
    const settings = await mcp("tools/call", { name: "get_settings", arguments: {} });
    const text = (settings.content as { text: string }[])[0]!.text;
    expect(text).toContain("notes.example.org");
    expect(text).not.toContain("not-a-real-token");
  });

  it("serves sync to devices", async () => {
    await start();
    const snapshot = await signed({ method: "GET", url: "/api/sync/snapshot" });
    expect(snapshot.statusCode).toBe(200);
    const { generation, changes } = snapshot.json() as { generation: string; changes: { table: string; key: string }[] };
    expect(generation).not.toBe("");
    expect(changes.some((change) => change.table === "settings")).toBe(false);
  });

  it("lets an admin list and take the server's backups, and refuses unknown backup calls", async () => {
    await start();

    expect((await app.inject({ method: "POST", url: "/api/backup/list_backups", payload: [] })).statusCode).toBe(401);
    const listed = await signed({ method: "POST", url: "/api/backup/list_backups", payload: [] });
    expect(listed.json()).toEqual([taken]);
    expect((await signed({ method: "POST", url: "/api/backup/create_backup", payload: [] })).json()).toEqual(taken);
    expect(fake_backups.create_backup).toHaveBeenCalled();
    expect((await signed({ method: "POST", url: "/api/backup/drop_everything", payload: [] })).statusCode).toBe(404);
  });

  it("restores, deletes and reschedules backups only for the user at the page, never for a token", async () => {
    await start();
    fake_backups.restore_backup.mockClear();
    fake_backups.remove_backup.mockClear();
    fake_backups.set_backup_schedule.mockClear();
    const made = async (read_only: boolean) => (await as_page({ method: "POST", url: "/api/account/tokens", payload: { name: `script ${read_only}`, read_only } })).json<{ token: string }>().token;
    // The admin's own device token, an admin's program token that may change things, and a read-only one.
    const tokens = [token, await made(false), await made(true)];
    const guarded: [string, unknown[]][] = [
      ["restore_backup", [taken.name]],
      ["remove_backup", [taken.name]],
      ["set_backup_schedule", [{ automatic: false, to_keep: 0 }]],
    ];
    for (const each of tokens) {
      for (const [method, args] of guarded) {
        // The address spelled with an escaped letter reaches the same route, and is refused the same way.
        for (const url of [`/api/backup/${method}`, `/api/backup/${method.replace("e", "%65")}`]) {
          const refused = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${each}` }, payload: args });
          expect([url, refused.statusCode]).toEqual([url, 403]);
        }
      }
    }
    expect(fake_backups.restore_backup).not.toHaveBeenCalled();
    expect(fake_backups.remove_backup).not.toHaveBeenCalled();
    expect(fake_backups.set_backup_schedule).not.toHaveBeenCalled();
    // Listing, taking a backup and reading the schedule stay open to an admin's token.
    expect((await signed({ method: "POST", url: "/api/backup/list_backups", payload: [] })).statusCode).toBe(200);
    expect((await signed({ method: "POST", url: "/api/backup/create_backup", payload: [] })).statusCode).toBe(200);
    expect((await signed({ method: "POST", url: "/api/backup/get_backup_schedule", payload: [] })).statusCode).toBe(200);

    // The page still restores, deletes and sets the schedule.
    expect((await as_page({ method: "POST", url: "/api/backup/restore_backup", payload: [taken.name] })).statusCode).toBe(204);
    expect(fake_backups.restore_backup).toHaveBeenCalledWith(taken.name);
    expect((await as_page({ method: "POST", url: "/api/backup/remove_backup", payload: [taken.name] })).statusCode).toBe(204);
    expect((await as_page({ method: "POST", url: "/api/backup/set_backup_schedule", payload: [{ automatic: true, to_keep: 7 }] })).statusCode).toBe(204);

    // No MCP client is offered a backup call at all.
    const tools = ((await mcp("tools/list")).tools as { name: string }[]).map((tool) => tool.name);
    expect(tools.filter((name) => name.includes("backup"))).toEqual([]);
  });

  it("streams a reply to the pages over the event stream as it is written, and keeps it", async () => {
    use_plugins([
      define_plugin<ContextPluginApi>({
        id: "tests.echo",
        name: "Echo",
        version: "1.0.0",
        start: (context) =>
          context.provide("engine", "echo", {
            label: "Echo",
            model: () => "echo-1",
            run: async function* (request) {
              const said = request.conversation.at(-1)!.text;
              yield { type: "text", text: "You said " };
              yield { type: "text", text: said };
              yield { type: "done", text: `You said ${said}` };
            },
          }),
      }),
    ]);
    await start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await as_page({ method: "POST", url: "/api/call/set_setting", payload: ["engine", "echo"] })).statusCode).toBe(204);
    const stream = await fetch(`${base}/api/events`, { headers });
    const reader = stream.body!.getReader();
    let seen = "";
    const read_until = async (text: string) => {
      while (!seen.includes(text)) seen += new TextDecoder().decode((await reader.read()).value);
    };
    await read_until("event: hello");

    const sent = await fetch(`${base}/api/call/send_message`, { method: "POST", headers, body: JSON.stringify({ context_id: null, message: "hi" }) });
    expect(sent.status).toBe(200);
    const { conversation_id } = (await sent.json()) as { conversation_id: string };
    await read_until('"type":"finished"');
    await reader.cancel();
    await wait_for_runs();

    const pieces = [...seen.matchAll(/event: conversation\ndata: (.+)/g)].map((match) => JSON.parse(match[1]!) as { type: string; text?: string });
    expect(pieces.map((piece) => piece.type)).toEqual(["started", "text", "text", "finished"]);
    expect(pieces.filter((piece) => piece.type === "text").map((piece) => piece.text).join("")).toBe("You said hi");
    const conversation = (await signed({ method: "POST", url: "/api/call/get_conversation", payload: [conversation_id] })).json() as { messages: { text: string; engine: string }[] };
    expect(conversation.messages.map((message) => [message.text, message.engine])).toEqual([
      ["hi", ""],
      ["You said hi", "Echo"],
    ]);
  });

  it("records a link or entity added through a token or MCP as a program's proposal, and the page's as the user's", async () => {
    await start();
    const call = (method: string, payload: unknown[], as_browser = false) => (as_browser ? as_page : signed)({ method: "POST", url: `/api/call/${method}`, payload });
    const by_token = (await call("add_entity", ["person", "Alex Gardener"])).json() as string;
    await mcp("tools/call", { name: "add_entity", arguments: { kind: "topic", name: "Seeds" } });
    const by_page = (await call("add_entity", ["place", "Allotment"], true)).json() as string;

    const proposals = (await call("list_graph_proposals", [])).json() as { entities: { id: string; name: string; made_by: string; status: string }[] };
    expect(proposals.entities.map((each) => [each.name, each.made_by, each.status]).sort()).toEqual([
      ["Alex Gardener", "program", "proposed"],
      ["Seeds", "program", "proposed"],
    ]);
    expect(proposals.entities.some((each) => each.id === by_token)).toBe(true);
    const own = (await call("get_node_links", [`entity:${by_page}`])).json() as { node: { status: string } };
    expect(own.node.status).toBe("accepted");
  });

  it("lets only a signed-in browser approve or undo a change or set a level, never a token or MCP", async () => {
    await start();
    const refused_level = await signed({ method: "POST", url: "/api/call/set_action_level", payload: ["rename_context", "auto"] });
    const refused_approval = await signed({ method: "POST", url: "/api/call/resolve_proposal", payload: { id: "anything", decision: "approve" } });
    const refused_mark = await signed({ method: "POST", url: "/api/call/set_source_mark", payload: ["codex.x-tasks", "send_to_hosted", true] });
    const refused_undo = await signed({ method: "POST", url: "/api/call/undo_change", payload: ["a-message", "a-call"] });
    expect([refused_level.statusCode, refused_approval.statusCode, refused_mark.statusCode, refused_undo.statusCode]).toEqual([403, 403, 403, 403]);
    expect(refused_level.body).toContain("Only you can do this");
    const through_mcp = await mcp("tools/call", { name: "set_action_level", arguments: { method: "rename_context", level: "auto" } });
    // An unknown tool answers with a protocol error rather than a result.
    expect(through_mcp === undefined || through_mcp.isError === true).toBe(true);
    // The reads stay open to programs, and nothing was changed.
    const before = (await signed({ method: "POST", url: "/api/call/get_action_policy", payload: [] })).json() as { method: string; level: string }[];
    expect(before.find((entry) => entry.method === "rename_context")!.level).toBe("proposal");
    expect((await signed({ method: "POST", url: "/api/call/list_proposals", payload: [] })).statusCode).toBe(200);

    const login = await app.inject({ method: "POST", url: "/api/login", payload: { name: "root", password } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const set = await app.inject({ method: "POST", url: "/api/call/set_action_level", headers: { cookie }, payload: ["rename_context", "auto"] });
    expect(set.statusCode).toBe(204);
    const policy = (await signed({ method: "POST", url: "/api/call/get_action_policy", payload: [] })).json() as { method: string; level: string }[];
    expect(policy.find((entry) => entry.method === "rename_context")!.level).toBe("auto");
  });

  it("keeps the settings that guard the user's control to the page: a token and MCP are refused, the page is not", async () => {
    await start();
    const protected_values: Record<string, unknown> = {
      action_policy: { rename_context: "background" },
      source_marks: { "codex.trilium": { send_to_hosted: true, trusted: true } },
      engine: "anthropic",
      embedder: "openai-embeddings",
      "hosted_log.keep_days": 1,
      plugins: { "codex.openai": { enabled: true, settings: { endpoint: "https://elsewhere.example.org/v1", api_key_command: "touch /tmp/x" } } },
      item_sources: [{ id: "elsewhere", name: "Elsewhere", address: "https://elsewhere.example.org", token: "", kinds: [] }],
      "background.enabled": true,
      "background.daily_runs": 500,
      "background.daily_tokens": 9_000_000,
    };
    expect(Object.keys(protected_values).sort()).toEqual([...user_only_settings].sort());
    const before = (await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).json() as Record<string, unknown>;
    for (const [key, value] of Object.entries(protected_values)) {
      const in_order = await signed({ method: "POST", url: "/api/call/set_setting", payload: [key, value] });
      const by_name = await signed({ method: "POST", url: "/api/call/set_setting", payload: { key, value } });
      expect([key, in_order.statusCode, by_name.statusCode]).toEqual([key, 403, 403]);
      expect(in_order.body).toContain("Only you can do this");
      const through_mcp = await mcp("tools/call", { name: "set_setting", arguments: { key, value } });
      expect(through_mcp === undefined || through_mcp.isError === true).toBe(true);
    }
    expect((await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).json()).toEqual(before);
    // Other settings stay open to programs.
    expect((await signed({ method: "POST", url: "/api/call/set_setting", payload: ["refresh_minutes", 7] })).statusCode).toBe(204);
    expect((await mcp("tools/call", { name: "set_setting", arguments: { key: "refresh_minutes", value: 8 } })).isError).not.toBe(true);

    for (const [key, value] of Object.entries(protected_values)) {
      expect([key, (await as_page({ method: "POST", url: "/api/call/set_setting", payload: [key, value] })).statusCode]).toEqual([key, 204]);
    }
    const after = (await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).json() as Record<string, unknown>;
    expect([after.engine, after.embedder, after["hosted_log.keep_days"], after.refresh_minutes]).toEqual(["anthropic", "openai-embeddings", 1, 8]);
  });

  it("lets the desktop window, which reaches the daemon's socket, change them", async () => {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    const daemon = fastify();
    register_lenient_json_body(daemon);
    register_context_calls(daemon, () => database, new EventStream());
    app = daemon;
    const reply = await daemon.inject({ method: "POST", url: "/call/set_setting", payload: ["engine", "anthropic"] });
    expect(reply.statusCode).toBe(204);
    expect((await daemon.inject({ method: "POST", url: "/call/get_settings", payload: [] })).json()).toMatchObject({ engine: "anthropic" });
    expect(page_only.is_page_only_call("set_setting", ["engine", "x"])).toBe(true);
    expect(page_only.is_page_only_call("set_setting", ["refresh_minutes", 5])).toBe(false);
    expect(page_only.is_page_only_call("set_source_mark", [])).toBe(true);
  });
});

describe("sync and the user's own settings", () => {
  // A device's copy of the data, kept in memory with its sign-in.
  function device(): { database: DatabaseSync; client: ReturnType<typeof create_sync_client> } {
    const database = new DatabaseSync(":memory:");
    open_store(database);
    let config: SyncConfig | null = null;
    const storage = { read_config: () => config, write_config: (next: SyncConfig) => void (config = next), remove_config: () => void (config = null), back_up_before_download: () => undefined };
    return { database, client: create_sync_client({ engine: sync_engine, database: () => database, storage, device_name: "CODEX on a test", event_stream_retry_ms: 60_000 }) };
  }

  function setting_of(database: DatabaseSync, key: string): unknown {
    const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  it("refuses a protected setting pushed through the sync exchange by a program's token, and takes the rest", async () => {
    await start();
    const made = await as_page({ method: "POST", url: "/api/account/tokens", payload: { name: "script", read_only: false } });
    const headers = { authorization: `Bearer ${made.json<{ token: string }>().token}` };
    const { generation } = (await app.inject({ method: "GET", url: "/api/sync/snapshot", headers })).json() as { generation: string };
    const row = (key: string, value: unknown) =>
      ["_exists", "key", "value"].map((column) => ({ table: "settings", key, column, value: column === "_exists" ? 1 : column === "key" ? key : JSON.stringify(value), ts: Date.now(), site: "program" }));
    const exchange = (changes: unknown[]) => app.inject({ method: "POST", url: "/api/sync/exchange", headers, payload: { site: "program", generation, cursor: 0, changes } });

    for (const key of user_only_settings) {
      const refused = await exchange([...row("refresh_minutes", 3), ...row(key, key === "action_policy" ? { rename_context: "background" } : "changed")]);
      expect([key, refused.statusCode]).toEqual([key, 403]);
    }
    expect((await app.inject({ method: "POST", url: "/api/sync/replace", headers, payload: { changes: [] } })).statusCode).toBe(403);
    const settings = (await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).json() as Record<string, unknown>;
    expect(settings.engine).not.toBe("changed");
    // A refused exchange takes none of its changes, the harmless ones beside a protected setting included.
    expect(settings.refresh_minutes).not.toBe(3);
    expect(settings.action_policy).not.toEqual({ rename_context: "background" });

    expect((await exchange(row("refresh_minutes", 9))).statusCode).toBe(200);
    expect(((await signed({ method: "POST", url: "/api/call/get_settings", payload: [] })).json() as Record<string, unknown>).refresh_minutes).toBe(9);
  });

  it("still syncs every setting both ways between the user's own devices", async () => {
    await start();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const desktop = device();
    const phone = device();

    desktop.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("engine", JSON.stringify("anthropic"));
    expect((await desktop.client.connect(address, { name: "root", password }, "upload")).state).toBe("idle");
    expect((await phone.client.connect(address, { name: "root", password }, "download")).state).toBe("idle");
    expect(setting_of(phone.database, "engine")).toBe("anthropic");

    phone.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("action_policy", JSON.stringify({ rename_context: "auto" }));
    expect((await phone.client.sync_now()).state).toBe("idle");
    await desktop.client.sync_now();
    expect(setting_of(desktop.database, "action_policy")).toEqual({ rename_context: "auto" });

    desktop.client.stop();
    phone.client.stop();
  });
});
