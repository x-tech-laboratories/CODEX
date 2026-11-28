// MCP servers as tool plugins: added, listed, called and stopped against a small fake MCP server over stdio and over
// streamable HTTP, their settings the user's alone, their words fenced, and a server that exits or hangs failing plainly.

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { hidden_secret } from "@x-tech-laboratories/x-libs/plugins";

import { instructions_of, mcp_limits, node_mcp_connector, open_connections, passed_variables, result_text } from "../../../src/server/tools/mcp_client.ts";
import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { add_conversation_record, has_conversation } from "../../../src/shared/conversations/records.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { engine_tools, type ToolContext } from "../../../src/shared/conversations/tools.ts";
import { specialist_groups, specialist_instructions } from "../../../src/shared/conversations/specialists.ts";
import { use_mcp_connector, mcp_connector, type McpConnector } from "../../../src/shared/mcp/connector.ts";
import { is_loopback_address, sends_outside, type McpServerFields } from "../../../src/shared/mcp/model.ts";
import { device_id_of } from "../../../src/shared/jobs/records.ts";
import { background_devices } from "../../../src/shared/jobs/schema.ts";
import { drizzle_of } from "../../../src/shared/feature.ts";
import { page_only_methods } from "../../../src/shared/store.ts";
import { local_screen, note_source } from "../../../src/shared/privacy/screen.ts";
import { page_only, settings_store } from "../../../src/shared/store.ts";
import { open_plugin_tools } from "../../../src/shared/tools/offered.ts";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";
import { injected, start_fake_mcp_http } from "../../fixtures/fake_mcp_server.ts";

const fake_program = fileURLToPath(new URL("../../fixtures/fake_mcp_server.ts", import.meta.url));
const saved_limits = { ...mcp_limits };

afterEach(async () => {
  await wait_for_runs();
  await node_mcp_connector.forget();
  Object.assign(mcp_limits, saved_limits);
  use_mcp_connector(null);
  use_assistant_host(null);
});

function stdio(name: string, args: string[] = [], extra: Partial<McpServerFields> = {}): McpServerFields {
  return { name, transport: "stdio", command: process.execPath, args: [fake_program, ...args], ...extra };
}

function with_mcp(): Fixture {
  const fixture = start_fixture();
  use_mcp_connector(node_mcp_connector);
  return fixture;
}

async function tools_of(fixture: Fixture, extra: Partial<ToolContext> = {}) {
  if (!has_conversation(fixture.database, "general")) add_conversation_record(fixture.database, null, "general");
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id: "general",
    presence: "conversation",
    has_outside_content: false,
    plugin_tools: await open_plugin_tools(fixture.database),
    ...extra,
  };
  return { context, tools: engine_tools(context) };
}

describe("an MCP server over stdio", () => {
  it("is added by listing its tools, each read-only one a read and every other a change, staying on this machine", async () => {
    const fixture = with_mcp();
    const id = await fixture.calls.add_mcp_server(stdio("Notes"));
    expect(id).toBe("notes");
    const [server] = fixture.calls.list_mcp_servers();
    expect(server).toMatchObject({ id: "notes", name: "Notes", transport: "stdio", command: process.execPath, args: [fake_program], enabled: true, key: "codex.mcp/mcp_notes", sends_outside: false, has_token: false });
    expect(server!.tools.map((tool) => [tool.name, tool.read_only])).toEqual([
      ["read_note", true],
      ["add_note", false],
      ["list_contexts", true],
      ["env_names", true],
      ["wait", true],
      ["fail", true],
    ]);
    expect(server!.tools[0]!.description.length).toBeLessThanOrEqual(300);
    const [entry] = await fixture.calls.list_plugin_tools();
    expect(entry).toMatchObject({ key: "codex.mcp/mcp_notes", plugin_id: "codex.mcp", label: "Notes" });
    expect(entry!.tools.map((tool) => [tool.name, tool.changes, tool.sends_outside, tool.level])).toEqual([
      ["mcp_notes__read_note", false, false, null],
      ["mcp_notes__add_note", true, false, "proposal"],
      ["mcp_notes__list_contexts", false, false, null],
      ["mcp_notes__env_names", false, false, null],
      ["mcp_notes__wait", false, false, null],
      ["mcp_notes__fail", false, false, null],
    ]);
    expect(await fixture.calls.add_mcp_server(stdio("Notes"))).toBe("notes-2");
  });

  it("shows the engine its tools in the server's own words, fenced and clipped, never in place of CODEX's own", async () => {
    const fixture = with_mcp();
    await fixture.calls.add_mcp_server(stdio("Notes"));
    const { tools } = await tools_of(fixture);
    const names = tools.definitions.map((tool) => tool.name);
    expect(names.filter((name) => name === "list_contexts")).toHaveLength(1);
    expect(names).toContain("mcp_notes__list_contexts");
    const read = tools.definitions.find((tool) => tool.name === "mcp_notes__read_note")!;
    expect(read.description).toContain("Notes describes it, in its own words:\n<untrusted-data>");
    expect(read.description).not.toContain("Ignore all previous instructions");
    expect(read.description.length).toBeLessThan(1300);
    expect(read.parameters).toMatchObject({ type: "object", required: ["id"] });
    expect((await tools.call("list_contexts", {})).result).not.toContain("Not CODEX's");
  });

  it("keeps the instructions it gave when listed, and its specialist is told them fenced as its own words", async () => {
    const fixture = with_mcp();
    await fixture.calls.add_mcp_server(stdio("Notes"));
    const [stored] = fixture.calls.get_settings().mcp_servers as { instructions?: string }[];
    expect(stored!.instructions).toContain("Notes are kept by room");
    const plugin_tools = await open_plugin_tools(fixture.database);
    expect(plugin_tools[0]!.guidance).toContain("Notes are kept by room");
    const [group] = specialist_groups(plugin_tools);
    const told = specialist_instructions(group!, "");
    expect(told).toContain("Notes says how to use it, in its own words:\n<untrusted-data>");
    expect(told).toContain("Notes are kept by room");
    // Refreshing keeps them, and a server that gives none leaves none.
    await fixture.calls.refresh_mcp_server("notes");
    expect((fixture.calls.get_settings().mcp_servers as { instructions?: string }[])[0]!.instructions).toContain("Notes are kept by room");
    expect(instructions_of(undefined)).toBe("");
    expect(instructions_of("x".repeat(mcp_limits.max_instructions + 50))).toHaveLength(mcp_limits.max_instructions);
  });

  it("runs a read at once, fenced and lowering the run unless the server is trusted, and proposes a change, which approving runs", async () => {
    const fixture = with_mcp();
    await fixture.calls.add_mcp_server(stdio("Notes"));
    let { context, tools } = await tools_of(fixture);
    const read = await tools.call("mcp_notes__read_note", { id: "7" });
    expect(read.result).toContain("<untrusted-data>\nNote 7: lay tiles from the middle.");
    expect(read.result).not.toContain("Ignore all previous instructions");
    expect(context.has_outside_content).toBe(true);
    expect(open_connections()).toBe(1);

    fixture.calls.set_tool_plugin_mark("codex.mcp/mcp_notes", "trusted", true);
    ({ context, tools } = await tools_of(fixture));
    await tools.call("mcp_notes__read_note", { id: "8" });
    expect(context.has_outside_content).toBe(false);

    const proposed = await tools.call("mcp_notes__add_note", { text: "Buy grout" });
    expect(proposed.result).toContain("Not done yet");
    const [proposal] = fixture.calls.list_proposals("general");
    expect(proposal!.summary).toBe("Use the Notes plugin's add_note with text “Buy grout”.");
    const approved = await fixture.calls.resolve_proposal(proposal!.id, "approve");
    expect(approved).toMatchObject({ status: "approved", result: "<untrusted-data>\nAdded “Buy grout”.\n</untrusted-data>" });
  });

  it("starts the command without a shell, with only the SDK's safe variables and those the user names", async () => {
    process.env.CODEX_TEST_PASSED = "yes";
    process.env.CODEX_TEST_KEPT = "no";
    try {
      const fixture = with_mcp();
      await fixture.calls.add_mcp_server(stdio("Env", [], { variables: ["CODEX_TEST_PASSED", "CODEX_TEST_UNSET"] }));
      const server = fixture.calls.list_mcp_servers()[0]!;
      expect(server.variables).toEqual(["CODEX_TEST_PASSED", "CODEX_TEST_UNSET"]);
      const { tools } = await tools_of(fixture);
      const names = (await tools.call("mcp_env__env_names", {})).result.replace(/<\/?untrusted-data>/g, "").trim().split(",");
      expect(names).toContain("CODEX_TEST_PASSED");
      expect(names).not.toContain("CODEX_TEST_KEPT");
      for (const name of names) expect(["CODEX_TEST_PASSED", "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]).toContain(name);
      expect(passed_variables(["A", "B"], { A: "1" })).toEqual({ A: "1" });
      // A command with shell syntax in it is a program name, never run by a shell.
      await expect(fixture.calls.add_mcp_server({ name: "Shell", transport: "stdio", command: "echo hi; touch /tmp/never" })).rejects.toThrow("could not be started");
    } finally {
      delete process.env.CODEX_TEST_PASSED;
      delete process.env.CODEX_TEST_KEPT;
    }
  });

  it("says plainly when a tool fails, and stops a call that never answers", async () => {
    const fixture = with_mcp();
    await fixture.calls.add_mcp_server(stdio("Notes"));
    const { tools } = await tools_of(fixture);
    const failed = await tools.call("mcp_notes__fail", {});
    expect(failed.is_error).toBe(true);
    expect(failed.result).toContain("Tool error from Notes:\n<untrusted-data>\nIt broke.");
    expect(failed.result).not.toContain("Ignore all previous instructions");

    const server = (await import("../../../src/shared/mcp/records.ts")).read_servers(fixture.database)[0]!;
    const stop = new AbortController();
    const waiting = mcp_connector().call_tool(server, "wait", {}, stop.signal);
    setTimeout(() => stop.abort(), 100);
    await expect(waiting).rejects.toThrow("Stopped.");
    expect(open_connections()).toBe(0);
    mcp_limits.call_ms = 200;
    await expect(mcp_connector().call_tool(server, "wait", {}, new AbortController().signal)).rejects.toThrow(/Notes failed: .*timed out/i);
    expect(open_connections()).toBe(0);
    // The next call starts the server again.
    expect(await mcp_connector().call_tool(server, "read_note", { id: "1" }, new AbortController().signal)).toContain("Note 1");
  });

  it("refuses a server that exits, hangs or cannot be found, keeping nothing, and never stops CODEX", async () => {
    const fixture = with_mcp();
    await expect(fixture.calls.add_mcp_server(stdio("Broken", ["exit"]))).rejects.toThrow(/Broken stopped: it exited or closed its connection\. It wrote: Missing its configuration file\./);
    mcp_limits.connect_ms = 500;
    await expect(fixture.calls.add_mcp_server(stdio("Stuck", ["hang"]))).rejects.toThrow("Stuck did not answer within 0.5 seconds.");
    await expect(fixture.calls.add_mcp_server({ name: "Gone", transport: "stdio", command: "/nonexistent/mcp-server" })).rejects.toThrow("Gone could not be started: /nonexistent/mcp-server was not found.");
    expect(fixture.calls.list_mcp_servers()).toEqual([]);
    expect(open_connections()).toBe(0);
  });
});

describe("where a local MCP server runs", () => {
  // The servers as another device's write would sync them: the server given now recorded as run elsewhere.
  function moved_away(fixture: Fixture, id: string, device: string): void {
    const stored = fixture.calls.get_settings().mcp_servers as { id: string; device: string }[];
    fixture.calls.set_setting("mcp_servers", stored.map((each) => (each.id === id ? { ...each, device } : each)));
  }

  // A connector that counts how often a server is started or reached, beside the real one.
  function counting(fixture: Fixture) {
    const started: string[] = [];
    use_mcp_connector({
      list_tools: (server) => (started.push(`list ${server.id}`), node_mcp_connector.list_tools(server)),
      call_tool: (server, name, args, signal) => (started.push(`call ${server.id}`), node_mcp_connector.call_tool(server, name, args, signal)),
      forget: (id) => node_mcp_connector.forget(id),
    });
    return { fixture, started };
  }

  it("is recorded with the device that added it, and runs there", async () => {
    const fixture = with_mcp();
    await fixture.calls.add_mcp_server(stdio("Notes"));
    const stored = fixture.calls.get_settings().mcp_servers as { device: string }[];
    expect(stored[0]!.device).toBe(device_id_of(fixture.database));
    expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ runs_here: true });
    const { tools } = await tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name)).toContain("mcp_notes__read_note");
  });

  it("is never started on another device: its tools are not offered, and refreshing or changing its command is refused", async () => {
    const { fixture, started } = counting(with_mcp());
    await fixture.calls.add_mcp_server(stdio("Notes"));
    drizzle_of(fixture.database).insert(background_devices).values({ id: "laptop-id", name: "Laptop", kind: "desktop", started_at: new Date().toISOString() }).run();
    moved_away(fixture, "notes", "laptop-id");
    started.length = 0;

    expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ runs_here: false, device_name: "Laptop", enabled: true });
    expect((await fixture.calls.list_plugin_tools()).map((entry) => entry.key)).not.toContain("codex.mcp/mcp_notes");
    const { tools } = await tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name).filter((name) => name.startsWith("mcp_"))).toEqual([]);
    expect((await tools.call("mcp_notes__read_note", { id: "1" })).is_error).toBe(true);
    await expect(fixture.calls.refresh_mcp_server("notes")).rejects.toThrow("Notes is a command on another device. It runs on Laptop; move it to this device first, after reading its command.");
    await expect(fixture.calls.change_mcp_server("notes", stdio("Notes", ["--other"]))).rejects.toThrow("It runs on Laptop");
    // Renaming or turning it off changes nothing about where it runs, and starts nothing.
    await fixture.calls.change_mcp_server("notes", stdio("Notes kept"));
    expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ name: "Notes kept", runs_here: false, device_name: "Laptop" });
    expect(started).toEqual([]);
  });

  it("moves to this device only with the command the user was shown, then runs here alone", async () => {
    const { fixture, started } = counting(with_mcp());
    await fixture.calls.add_mcp_server(stdio("Notes"));
    moved_away(fixture, "notes", "unknown-id");
    started.length = 0;
    expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ runs_here: false, device_name: "" });

    await expect(fixture.calls.move_mcp_server_here("notes", { command: "/bin/sh", args: [fake_program] })).rejects.toThrow("Notes's command is not the one you were shown");
    await expect(fixture.calls.move_mcp_server_here("notes", { command: process.execPath, args: [] })).rejects.toThrow("not the one you were shown");
    expect(started).toEqual([]);

    const moved = await fixture.calls.move_mcp_server_here("notes", { command: process.execPath, args: [fake_program] });
    expect(moved).toMatchObject({ runs_here: true });
    expect(started).toEqual(["list notes"]);
    expect((fixture.calls.get_settings().mcp_servers as { device: string }[])[0]!.device).toBe(device_id_of(fixture.database));
    const { tools } = await tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name)).toContain("mcp_notes__read_note");
  });

  it("starts nowhere when it was added before its device was recorded, until moved", async () => {
    const fixture = with_mcp();
    fixture.calls.set_setting("mcp_servers", [{ id: "old", name: "Old", transport: "stdio", command: process.execPath, args: [fake_program], variables: [], enabled: true, tools: [{ name: "read_note", description: "", read_only: true, input_schema: {} }], listed_at: "" }]);
    expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ runs_here: false, device_name: "" });
    expect((await fixture.calls.list_plugin_tools()).map((entry) => entry.key)).toEqual([]);
  });

  it("does not bind a server at an address, which works from every device", async () => {
    const fake = await start_fake_mcp_http("");
    try {
      const fixture = with_mcp();
      await fixture.calls.add_mcp_server({ name: "Remote", transport: "http", address: fake.address, token: "" });
      moved_away(fixture, "remote", "laptop-id");
      expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ runs_here: true });
      await expect(fixture.calls.move_mcp_server_here("remote", { command: "", args: [] })).rejects.toThrow("works from every device already");
      // Turned into a local command here, it runs here.
      await fixture.calls.change_mcp_server("remote", stdio("Remote"));
      expect((fixture.calls.get_settings().mcp_servers as { device: string }[])[0]!.device).toBe(device_id_of(fixture.database));
    } finally {
      await fake.close();
    }
  });
});

describe("an MCP server over streamable HTTP", () => {
  it("is reached at its address with its bearer token, kept hidden from everything that reads settings", async () => {
    const fake = await start_fake_mcp_http("secret-token-1234");
    try {
      const fixture = with_mcp();
      await expect(fixture.calls.add_mcp_server({ name: "Remote", transport: "http", address: fake.address, token: "wrong" })).rejects.toThrow("Remote refused the token.");
      await fixture.calls.add_mcp_server({ name: "Remote", transport: "http", address: fake.address, token: "secret-token-1234" });
      expect(fake.authorizations).toContain("Bearer secret-token-1234");
      const [server] = fixture.calls.list_mcp_servers();
      expect(server).toMatchObject({ transport: "http", address: fake.address, has_token: true, sends_outside: false });
      expect(JSON.stringify(fixture.calls.list_mcp_servers())).not.toContain("secret-token-1234");
      const stored = fixture.calls.get_settings().mcp_servers as { token: string }[];
      expect(stored[0]!.token).toBe(hidden_secret);
      // The hidden token sent back keeps the one stored.
      fixture.calls.set_setting("mcp_servers", stored);
      const { tools } = await tools_of(fixture);
      expect((await tools.call("mcp_remote__read_note", { id: "3" })).result).toContain("Note 3");
      // Renaming keeps the token and does not ask the server again; a null token keeps it too.
      const asked = fake.authorizations.length;
      await fixture.calls.change_mcp_server("remote", { name: "Remote notes", transport: "http", address: fake.address, token: null });
      expect(fake.authorizations.length).toBe(asked);
      expect(fixture.calls.list_mcp_servers()[0]).toMatchObject({ name: "Remote notes", has_token: true });
    } finally {
      await fake.close();
    }
  });

  it("says plainly when nothing answers at the address", async () => {
    const fake = await start_fake_mcp_http();
    const address = fake.address;
    await fake.close();
    const fixture = with_mcp();
    await expect(fixture.calls.add_mcp_server({ name: "Down", transport: "http", address })).rejects.toThrow(/^Down could not be reached at 127\.0\.0\.1:\d+\.$/);
  });
});

describe("the MCP servers' settings", () => {
  it("are checked, changed, refreshed, turned off and removed, each tool still turned off on its own", async () => {
    const fixture = with_mcp();
    await expect(fixture.calls.add_mcp_server({ name: " ", transport: "stdio", command: "x" })).rejects.toThrow("Give the server a name");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "ftp" as never })).rejects.toThrow("reached over http");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "http", address: "nowhere" })).rejects.toThrow("whole address");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "http", address: "ftp://x/" })).rejects.toThrow("must start with http");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "http", address: ["https://someone", "word@x.example/"].join(":") })).rejects.toThrow("token in its own field");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "stdio", command: " " })).rejects.toThrow("Give the program");
    await expect(fixture.calls.add_mcp_server({ name: "X", transport: "stdio", command: "x", variables: ["NOT A NAME"] })).rejects.toThrow("NOT A NAME is not a variable's name");
    await expect(fixture.calls.change_mcp_server("nothing", stdio("X"))).rejects.toThrow("There is no MCP server nothing");

    await fixture.calls.add_mcp_server(stdio("Notes"));
    fixture.calls.set_plugin_tool_offer("codex.mcp/mcp_notes", "add_note", "enabled", false);
    let { tools } = await tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name)).not.toContain("mcp_notes__add_note");
    expect(tools.definitions.map((tool) => tool.name)).toContain("mcp_notes__read_note");

    expect((await fixture.calls.refresh_mcp_server("notes")).tools).toHaveLength(6);
    await fixture.calls.change_mcp_server("notes", { ...stdio("Notes"), enabled: false });
    expect(await fixture.calls.list_plugin_tools()).toEqual([]);
    ({ tools } = await tools_of(fixture));
    expect(tools.definitions.some((tool) => tool.name.startsWith("mcp_"))).toBe(false);
    await expect(fixture.calls.change_mcp_server("notes", stdio("Notes", ["exit"]))).rejects.toThrow("stopped");
    expect(fixture.calls.list_mcp_servers()[0]!.args).toEqual([fake_program]);

    await fixture.calls.remove_mcp_server("notes");
    expect(fixture.calls.list_mcp_servers()).toEqual([]);
    expect(open_connections()).toBe(0);
  });

  it("are the user's alone: every change page-only, the setting user-only, never an engine's tool", async () => {
    for (const name of ["add_mcp_server", "change_mcp_server", "refresh_mcp_server", "move_mcp_server_here", "remove_mcp_server"]) {
      expect(page_only_methods.has(name)).toBe(true);
      expect(page_only.is_page_only_call(name, [])).toBe(true);
    }
    expect(page_only.is_page_only_call("list_mcp_servers", [])).toBe(false);
    expect(settings_store.user_only.has("mcp_servers")).toBe(true);
    expect(page_only.is_page_only_call("set_setting", ["mcp_servers", []])).toBe(true);
    const fixture = with_mcp();
    const { tools } = await tools_of(fixture);
    for (const name of ["list_mcp_servers", "add_mcp_server", "change_mcp_server", "refresh_mcp_server", "move_mcp_server_here", "remove_mcp_server"]) expect(tools.definitions.map((tool) => tool.name)).not.toContain(name);
  });

  it("count a server's tools as sending outside unless it is a local command or on a loopback address", () => {
    for (const address of ["http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]:8/mcp", "http://notes.localhost/mcp"]) expect(is_loopback_address(address), address).toBe(true);
    for (const address of ["https://mcp.example.org/mcp", "http://192.168.1.4/mcp", "http://10.0.0.1/", "not an address"]) expect(is_loopback_address(address), address).toBe(false);
    expect(sends_outside({ transport: "stdio", address: "" })).toBe(false);
    expect(sends_outside({ transport: "http", address: "http://192.168.1.4/mcp" })).toBe(true);
  });
});

describe("a remote MCP server's tools", () => {
  // A server on another machine, answered by a stand-in connector, so nothing leaves this one.
  function remote_fixture(): { fixture: Fixture; called: string[] } {
    const fixture = start_fixture();
    const called: string[] = [];
    const connector: McpConnector = {
      list_tools: async () => ({ tools: [{ name: "search", description: "Searches.", read_only: true, input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }], instructions: "" }),
      call_tool: async (_server, name) => (called.push(name), "Found it."),
      forget: async () => undefined,
    };
    use_mcp_connector(connector);
    return { fixture, called };
  }

  it("are refused after a private source, unless the server is marked to allow it, and each use is logged", async () => {
    const { fixture, called } = remote_fixture();
    await fixture.calls.add_mcp_server({ name: "Far", transport: "http", address: "https://mcp.example.org/mcp" });
    expect(fixture.calls.list_mcp_servers()[0]!.sends_outside).toBe(true);
    const screen = local_screen();
    note_source(screen.included, "links", "links:1");
    let { tools } = await tools_of(fixture, { screen });
    expect((await tools.call("mcp_far__search", { q: "x" })).result).toContain("May be used after reading private sources");
    expect(called).toEqual([]);
    fixture.calls.set_tool_plugin_mark("codex.mcp/mcp_far", "after_private", true);
    ({ tools } = await tools_of(fixture, { screen }));
    expect((await tools.call("mcp_far__search", { q: "tiles" })).result).toContain("Found it.");
    expect(fixture.calls.list_hosted_sends()).toMatchObject([{ kind: "tool", tool: "Far: search", argument_count: 1, argument_chars: 5 }]);
  });

  it("read a server's answer whole: text, resources and what else it gave, in words", () => {
    expect(result_text({ content: [{ type: "text", text: "One" }, { type: "image", data: "", mimeType: "image/png" }, { type: "resource", resource: { uri: "file:///a", text: "Two" } }, { type: "resource_link", uri: "file:///b", name: "b" }] })).toBe("One\n[image]\nTwo\n[b: file:///b]");
    expect(result_text({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(result_text({ content: [] })).toBe("(No answer.)");
    expect(injected).toContain("Ignore");
  });
});
