// A tool plugin's mark "May be sent to a hosted engine": on to begin with only for a plugin whose tools all send
// outside, and while off, a hosted engine is not offered its tools, nor sent replayed answers, events, proposal
// summaries or search hits that carry what they gave back.

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { web_plugin } from "../src/server/tools/web.ts";
import type { ContextPlugin, ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import { engine_tools, turns_of, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { is_local_endpoint } from "../src/shared/engines/hosting.ts";
import { server_tools } from "../src/shared/mcp/plugin.ts";
import type { McpServerRecord } from "../src/shared/mcp/model.ts";
import { has_read_private, open_screen } from "../src/shared/privacy/screen.ts";
import { index_now, open_index, settle_index, use_search_index } from "../src/shared/search/indexer.ts";
import { is_plugin_tool_name, tool_source_of } from "../src/shared/tools/model.ts";
import { marks_of, open_plugin_tools } from "../src/shared/tools/offered.ts";
import type { PluginTool } from "../src/shared/tools/tool.ts";
import { start_fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await settle_index();
  await wait_for_runs();
  use_search_index(null);
  use_assistant_host(null);
});

const files_key = "tests.files/files";
const files_source = tool_source_of(files_key);

const read_file: PluginTool = { name: "read_file", description: "Reads a file.", parameters: { type: "object", properties: { path: { type: "string" } } }, changes: false, sends_outside: false };
const write_file: PluginTool = { name: "write_file", description: "Writes a file.", parameters: { type: "object", properties: { path: { type: "string" } } }, changes: true, sends_outside: false };
const ask_out: PluginTool = { name: "ask_out", description: "Asks a service on the web.", parameters: { type: "object", properties: { q: { type: "string" } } }, changes: false, sends_outside: true };

// A plugin reading private files on this computer, as a local MCP server might.
function files_plugin(tools: PluginTool[] = [read_file, write_file]): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: "tests.files",
    name: "Files",
    version: "1.0.0",
    start: (context) => context.provide("tools", "files", { label: "Files", own_words: true, tools: () => tools, call: async () => "The secret plan is in plan.txt" }),
  });
}

// A plugin whose every tool sends outside, as the Web plugin's do.
function outside_plugin(): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: "tests.outside",
    name: "Outside",
    version: "1.0.0",
    start: (context) => context.provide("tools", "outside", { label: "Outside", own_words: true, tools: () => [ask_out], call: async () => "A public answer." }),
  });
}

const plugin_names = (tools: { name: string }[]) => tools.map((tool) => tool.name).filter(is_plugin_tool_name);

describe("the mark's starting value", () => {
  it("is on only for a plugin whose tools all send outside, until the user sets it", async () => {
    expect(marks_of(undefined, [ask_out])).toEqual({ send_to_hosted: true, trusted: false, after_private: false });
    expect(marks_of(undefined, [ask_out, read_file]).send_to_hosted).toBe(false);
    expect(marks_of(undefined, []).send_to_hosted).toBe(false);
    expect(marks_of({ send_to_hosted: false }, [ask_out]).send_to_hosted).toBe(false);
    expect(marks_of({ send_to_hosted: true }, [read_file]).send_to_hosted).toBe(true);

    const fixture = start_fixture({ plugins: [files_plugin(), outside_plugin(), web_plugin()] });
    fixture.calls.set_setting("plugins", { "codex.web": { enabled: true } });
    const listed = Object.fromEntries((await fixture.calls.list_plugin_tools()).map((entry) => [entry.key, entry.send_to_hosted]));
    expect(listed).toEqual({ [files_key]: false, "tests.outside/outside": true, "codex.web/web": true });

    fixture.calls.set_tool_plugin_mark(files_key, "send_to_hosted", true);
    fixture.calls.set_tool_plugin_mark("codex.web/web", "send_to_hosted", false);
    const changed = Object.fromEntries((await fixture.calls.list_plugin_tools()).map((entry) => [entry.key, entry.send_to_hosted]));
    expect(changed).toEqual({ [files_key]: true, "tests.outside/outside": true, "codex.web/web": false });
  });

  it("is off for a local MCP server and one on a loopback address, and on for a remote one", () => {
    const server = (fields: Partial<McpServerRecord>): McpServerRecord => ({ id: "s", name: "S", transport: "stdio", address: "", token: "", command: "x", args: [], variables: [], enabled: true, tools: [{ name: "t", description: "", read_only: true, input_schema: {} }], listed_at: "", ...fields });
    const mark = (fields: Partial<McpServerRecord>) => marks_of(undefined, server_tools(server(fields)).tools() as PluginTool[]).send_to_hosted;
    expect(mark({})).toBe(false);
    expect(mark({ transport: "http", address: "http://127.0.0.1:9000/mcp" })).toBe(false);
    expect(mark({ transport: "http", address: "https://mcp.example.org/mcp" })).toBe(true);
  });
});

describe("a hosted engine and an unmarked tool plugin", () => {
  it("is not offered its tools, while a local engine is, and is once the plugin is marked", async () => {
    const fixture = start_fixture({ plugins: [files_plugin(), outside_plugin()] });
    await fixture.calls.send_message(null, "Hello");
    await wait_for_runs();
    expect(plugin_names(fixture.requests.at(-1)!.tools.definitions)).toEqual(["files__read_file", "files__write_file", "outside__ask_out"]);

    fixture.set_hosted(true);
    await fixture.calls.send_message(null, "Hello again");
    await wait_for_runs();
    const hosted = fixture.requests.at(-1)!;
    expect(plugin_names(hosted.tools.definitions)).toEqual(["outside__ask_out"]);
    expect(hosted.instructions).not.toContain("files__");
    expect(await hosted.tools.call("files__read_file", { path: "plan.txt" })).toEqual({ result: "There is no tool named files__read_file.", is_error: true });

    fixture.calls.set_tool_plugin_mark(files_key, "send_to_hosted", true);
    await fixture.calls.send_message(null, "And now?");
    await wait_for_runs();
    expect(plugin_names(fixture.requests.at(-1)!.tools.definitions)).toEqual(["files__read_file", "files__write_file", "outside__ask_out"]);
  });

  it("counts a host on a Tailscale address as hosted, so its tools stay unoffered", () => {
    expect(is_local_endpoint("http://100.101.102.103:8080/v1")).toBe(false);
    expect(is_local_endpoint("http://192.168.1.20:8080/v1")).toBe(true);
  });

  it("is never replayed an answer that used its tools, and the log counts it", async () => {
    const fixture = start_fixture({ plugins: [files_plugin()] });
    fixture.set_script(async function* (request) {
      const read = await request.tools.call("files__read_file", { path: "plan.txt" });
      yield { type: "done", text: read.result.includes("secret plan") ? "The secret plan is in plan.txt." : "Nothing." };
    });
    const { conversation_id } = await fixture.calls.send_message(null, "Where is the plan?");
    await wait_for_runs();
    expect(fixture.calls.get_conversation(conversation_id).messages[1]!.sources).toEqual([files_source]);

    fixture.set_hosted(true);
    fixture.set_script(async function* () {
      yield { type: "done", text: "Hosted." };
    });
    await fixture.calls.send_message(null, "Again?", conversation_id);
    await wait_for_runs();
    const sent = fixture.requests.at(-1)!;
    expect(sent.conversation.map((turn) => turn.text)).toEqual([
      "Where is the plan?",
      "[An earlier answer is withheld from this hosted engine: it drew on Files, which the user has not marked “May be sent to a hosted engine”.]",
      "Again?",
    ]);
    expect(JSON.stringify(sent)).not.toContain("secret plan");
    expect(fixture.calls.list_hosted_sends()[0]!.withheld).toEqual([{ collector: files_source, label: "Files", count: 1 }]);

    fixture.calls.set_tool_plugin_mark(files_key, "send_to_hosted", true);
    expect(turns_of(fixture.database, conversation_id, await open_screen(fixture.database, true))[1]!.text).toBe("The secret plan is in plan.txt.");
  });

  it("is never replayed the event of an approved change that ran its tool", async () => {
    const fixture = start_fixture({ plugins: [files_plugin()] });
    fixture.set_script(async function* (request) {
      await request.tools.call("files__write_file", { path: "plan.txt" });
      yield { type: "done", text: "Proposed." };
    });
    const { conversation_id } = await fixture.calls.send_message(null, "Write the plan");
    await wait_for_runs();
    const [proposal] = fixture.calls.list_proposals(conversation_id);
    await fixture.calls.resolve_proposal(proposal!.id, "approve");
    expect(fixture.calls.get_conversation(conversation_id).messages.at(-1)!.sources).toContain(files_source);

    fixture.set_hosted(true);
    fixture.set_script(async function* () {
      yield { type: "done", text: "Ok." };
    });
    await fixture.calls.send_message(null, "Next", conversation_id);
    await wait_for_runs();
    const last_turn = fixture.requests.at(-1)!.conversation.at(-1)!.text;
    expect(last_turn).toContain("[An earlier event is withheld from this hosted engine: it drew on Files");
    expect(last_turn).not.toContain("secret plan");
  });

  it("is not sent search hits that carry its results, nor is a hosted embedder", async () => {
    const embedded: string[] = [];
    const embedder = define_plugin<ContextPluginApi>({
      id: "tests.fake-embedder",
      name: "Fake embedder",
      version: "1.0.0",
      start: (context) =>
        context.provide("embedder", "fake-embedder", { label: "Fake embedder", model: () => "m", dimensions: () => 4, is_local: () => false, embed: async (texts) => (embedded.push(...texts), texts.map(() => [1, 0, 0, 0])) }),
    });
    const fixture = start_fixture({ plugins: [files_plugin(), embedder] });
    const index = new DatabaseSync(":memory:");
    open_index(index);
    use_search_index({ database: () => fixture.database, index: () => index });
    fixture.calls.set_setting("embedder", "fake-embedder");
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "From the files: plan in the drawer", sources: [files_source] });
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Plain: plan the week", sources: [] });
    await index_now();
    expect(embedded.join(" | ")).not.toContain("drawer");
    expect(embedded.join(" | ")).toContain("plan the week");

    const tools = engine_tools({
      database: () => fixture.database,
      call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
      conversation_id: "elsewhere",
      presence: "conversation",
      has_outside_content: false,
      screen: await open_screen(fixture.database, true),
    });
    const found = await tools.call("search_index", { query: "plan" });
    expect(found.result).toContain("plan the week");
    expect(found.result).not.toContain("drawer");
    expect(found.result).toContain("1 from Files");
  });
});

describe("what an unmarked tool plugin gave back", () => {
  it("keeps a tool that sends outside from being used for the rest of the run, as a private source's items do", async () => {
    const fixture = start_fixture({ plugins: [files_plugin(), outside_plugin()] });
    const screen = await open_screen(fixture.database, false);
    const context: ToolContext = {
      database: () => fixture.database,
      call: async () => undefined,
      conversation_id: "general",
      presence: "conversation",
      has_outside_content: false,
      screen,
      plugin_tools: await open_plugin_tools(fixture.database),
    };
    const tools = engine_tools(context);
    expect((await tools.call("outside__ask_out", { q: "weather" })).is_error).toBe(false);
    expect(has_read_private(screen)).toBe(false);
    await tools.call("files__read_file", { path: "plan.txt" });
    expect(has_read_private(screen)).toBe(true);
    expect((await tools.call("outside__ask_out", { q: "plan.txt" })).result).toContain("from a source or tool plugin the user has not marked");
    // A proposal's evidence keeps an excerpt only of what may go to a hosted engine.
    expect(context.reads!.map((read) => [read.name, read.excerpt !== ""])).toEqual([
      ["outside__ask_out", true],
      ["files__read_file", false],
    ]);
  });
});
