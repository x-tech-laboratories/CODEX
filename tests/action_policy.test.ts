import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import type { ToolCallRecord } from "../src/shared/conversations/model.ts";
import { add_conversation_record, has_conversation } from "../src/shared/conversations/records.ts";
import { engine_tools, max_result_chars, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { record_history } from "../src/shared/history/store.ts";
import { brings_outside_content, changing_calls, decide } from "../src/shared/policy/policy.ts";
import { summarize_call } from "../src/shared/policy/summaries.ts";
import { open_plugin_tools } from "../src/shared/tools/offered.ts";
import type { ChatMessage } from "../src/shared/engines/direct.ts";
import { default_chars_per_token, fit_request, tools_chars } from "../src/shared/engines/fitting.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

// The tools a run in a conversation in no context gets, calling the fixture's store as the host does.
function tools_of(fixture: Fixture, conversation_id = "general"): { context: ToolContext; tools: ReturnType<typeof engine_tools>; decided: string[] } {
  // Made as a bound call would make it, with History recording the conversation joining Global.
  if (!has_conversation(fixture.database, conversation_id)) {
    add_conversation_record(fixture.database, null, conversation_id);
    record_history(fixture.database);
  }
  const decided: string[] = [];
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id,
    presence: "conversation",
    has_outside_content: false,
    on_decided: (name, record) => void decided.push(`${name}:${record.outcome}${record.applied_by ? `:${record.applied_by}` : ""}`),
  };
  return { context, tools: engine_tools(context), decided };
}

describe("the levels", () => {
  it("start every change at proposal, and keep a level set for one call", () => {
    const fixture = start_fixture();
    const policy = fixture.calls.get_action_policy();

    // The calls an engine is offered, then the one only background maintenance makes.
    expect(policy.map((entry) => entry.method)).toEqual([...changing_calls(), "close_graph_link"]);
    expect(policy.at(-1)!.description).toMatch(/^Background maintenance: /);
    expect(new Set(policy.map((entry) => entry.level))).toEqual(new Set(["proposal"]));
    expect(policy.find((entry) => entry.method === "remove_context")).toMatchObject({ destructive: true, description: expect.stringContaining("Deletes a context") });
    expect(policy.some((entry) => entry.method.startsWith("get_") || entry.method.startsWith("list_"))).toBe(false);

    fixture.calls.set_action_level("rename_context", "auto");
    expect(fixture.calls.get_action_policy().find((entry) => entry.method === "rename_context")!.level).toBe("auto");
    expect(fixture.calls.get_settings().action_policy).toEqual({ rename_context: "auto" });
    expect(() => fixture.calls.set_action_level("get_context", "auto")).toThrow("not a change an engine is offered");
    expect(() => fixture.calls.set_action_level("set_setting", "auto")).toThrow("not a change");
    expect(() => fixture.calls.set_action_level("rename_context", "always" as never)).toThrow("A level is one of restricted, proposal, auto, background.");
  });

  it("read a stored level that is not one as the default", () => {
    const fixture = start_fixture();
    fixture.calls.set_setting("action_policy", { rename_context: "whenever", remove_context: "restricted" });
    const levels = Object.fromEntries(fixture.calls.get_action_policy().map((entry) => [entry.method, entry.level]));
    expect([levels.rename_context, levels.remove_context]).toEqual(["proposal", "restricted"]);
    fixture.calls.set_setting("action_policy", "broken");
    expect(fixture.calls.get_action_policy().every((entry) => entry.level === "proposal")).toBe(true);
  });

  it("decide by level, by who is present and by what the run has read", () => {
    expect(decide("restricted", "conversation", false)).toEqual({ action: "refuse" });
    expect(decide("proposal", "conversation", false)).toEqual({ action: "propose", reason: "level" });
    expect(decide("auto", "conversation", false)).toEqual({ action: "run", level: "auto" });
    expect(decide("auto", "conversation", true)).toEqual({ action: "propose", reason: "outside content" });
    expect(decide("background", "conversation", true)).toEqual({ action: "propose", reason: "outside content" });
    // Only background lets a job with nobody present change anything.
    expect(decide("auto", "background", false)).toEqual({ action: "propose", reason: "level" });
    expect(decide("background", "background", false)).toEqual({ action: "run", level: "background" });
    expect(decide("restricted", "background", false)).toEqual({ action: "refuse" });
    expect(brings_outside_content("list_contexts")).toBe(false);
    expect(brings_outside_content("search_collector")).toBe(true);
    expect(brings_outside_content("get_context")).toBe(true);
    expect(brings_outside_content("refresh_items")).toBe(true);
    expect(brings_outside_content("rename_context")).toBe(false);
  });
});

// Every call an engine may be offered, written out, so a new call becomes a tool only by being added here.
const allowed_tools = [
  "add_context",
  "add_contexts_from_feed_group",
  "add_contexts_from_feeds",
  "add_item",
  "add_item_to_contexts",
  "add_job",
  "add_manual_item",
  "change_job",
  "follow_feed",
  "get_blueprint",
  "get_context",
  "get_item",
  "get_node_links",
  "get_source_item",
  "list_blueprints",
  "list_collector_feeds",
  "list_collectors",
  "list_contexts",
  "list_feed_group_news",
  "list_graph_proposals",
  "list_interests",
  "list_jobs",
  "move_context",
  "move_item",
  "propose_blueprint",
  "propose_blueprint_change",
  "propose_entity",
  "propose_interest",
  "propose_link",
  "propose_link_drop",
  "read_tool_result",
  "refresh_items",
  "remove_context",
  "remove_item",
  "remove_job",
  "rename_context",
  "search_collector",
  "search_index",
  "search_kept_items",
  "set_context_archived",
  "set_context_notes",
  "set_item_note",
  "set_mood",
  "stop_feed_group_news",
  "unfollow_feed",
];

// The core set a model with a small context is offered, written out the same way.
const allowed_core_tools = [
  "add_context",
  "add_item",
  "add_item_to_contexts",
  "get_blueprint",
  "get_context",
  "get_item",
  "get_node_links",
  "get_source_item",
  "list_contexts",
  "list_graph_proposals",
  "move_item",
  "propose_blueprint",
  "propose_blueprint_change",
  "propose_entity",
  "propose_interest",
  "propose_link",
  "propose_link_drop",
  "read_tool_result",
  "remove_item",
  "rename_context",
  "search_collector",
  "search_index",
  "set_context_notes",
  "set_item_note",
  "set_mood",
];

describe("a run's tools", () => {
  it("are exactly the allowed calls, and never settings, plugins, the policy, marks or anything only the page may call", () => {
    const fixture = start_fixture();
    const { tools } = tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name).sort()).toEqual(allowed_tools);
    expect(tools.core!.map((tool) => tool.name).sort()).toEqual(allowed_core_tools);
    for (const name of allowed_core_tools) expect(allowed_tools).toContain(name);
    for (const never of ["set_setting", "get_settings", "set_action_level", "resolve_proposal", "set_source_mark", "accept_graph_proposals", "reject_graph_proposals", "add_graph_link", "remove_entity", "suggest_links", "accept_blueprint_proposals", "reject_blueprint_proposals", "add_blueprint", "change_blueprint", "retire_blueprint", "restore_blueprint", "place_blueprint", "remove_blueprint", "save_as_blueprint", "list_blueprint_proposals", "set_job_on", "run_job_now", "set_background_device", "set_maintenance_job", "list_maintenance_jobs", "close_graph_link", "dismiss_job_runs", "list_inbox", "get_inbox_count", "get_background_state", "rebuild_index", "import_contexts", "send_message", "list_conversations", "get_conversation", "rename_conversation", "delete_conversation", "stop_reply", "list_plugin_tools", "set_tool_plugin_mark", "set_plugin_tool_offer", "set_plugin_tool_level", "list_mcp_servers", "add_mcp_server", "change_mcp_server", "refresh_mcp_server", "remove_mcp_server"]) {
      expect(allowed_tools).not.toContain(never);
    }
  });

  it("gain a plugin's tools only while each is turned on, the core set only those offered to small models", async () => {
    const plugin = define_plugin<ContextPluginApi>({
      id: "tests.tools",
      name: "Tools",
      version: "1.0.0",
      start: (context) =>
        context.provide("tools", "extra", {
          label: "Extra",
          tools: () => [{ name: "look", description: "Looks.", parameters: { type: "object", properties: {} }, changes: false, sends_outside: false }],
          call: async () => "Seen.",
        }),
    });
    const fixture = start_fixture({ plugins: [plugin] });
    const with_plugins = async () => engine_tools({ ...tools_of(fixture).context, plugin_tools: await open_plugin_tools(fixture.database) });
    expect((await with_plugins()).definitions.map((tool) => tool.name).sort()).toEqual([...allowed_tools, "extra__look"].sort());
    expect((await with_plugins()).core!.map((tool) => tool.name).sort()).toEqual(allowed_core_tools);
    fixture.calls.set_plugin_tool_offer("tests.tools/extra", "look", "small", true);
    expect((await with_plugins()).core!.map((tool) => tool.name).sort()).toEqual([...allowed_core_tools, "extra__look"].sort());
    fixture.calls.set_plugin_tool_offer("tests.tools/extra", "look", "enabled", false);
    expect((await with_plugins()).definitions.map((tool) => tool.name).sort()).toEqual(allowed_tools);
    expect((await with_plugins()).core!.map((tool) => tool.name).sort()).toEqual(allowed_core_tools);
  });

  it("offer a core set briefly described, its fields without their descriptions, smaller than the whole", () => {
    const fixture = start_fixture();
    const { tools } = tools_of(fixture);
    const core = tools.core!;
    const full = new Map(tools.definitions.map((tool) => [tool.name, tool]));
    for (const tool of core) {
      expect(tool.description.length).toBeLessThan(80);
      expect(JSON.stringify(tool.parameters)).not.toContain('"description"');
      expect(Object.keys(tool.parameters.properties as object)).toEqual(Object.keys(full.get(tool.name)!.parameters.properties as object));
    }
    // Under a third of the whole, the graph's two reads and three proposing calls included.
    expect(JSON.stringify(core).length * 3).toBeLessThan(JSON.stringify(tools.definitions).length);
    // The core set, with room for the instructions and the conversation, takes well under a 16,384-token context.
    expect(Math.ceil(tools_chars(core) / default_chars_per_token)).toBeLessThan(16_384 / 4);
  });

  it("run reads, fencing what other apps wrote, and refuse calls that are not offered or arguments that do not fit", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    const { context, tools, decided } = tools_of(fixture);

    const listed = await tools.call("list_contexts", {});
    expect(listed.is_error).toBe(false);
    expect(listed.result).toContain("Kitchen");
    expect(listed.result).not.toContain("<untrusted-data>");
    expect(context.has_outside_content).toBe(false);

    const read = await tools.call("get_context", { id: kitchen });
    expect(read.result.startsWith("<untrusted-data>")).toBe(true);
    expect(context.has_outside_content).toBe(true);

    expect(await tools.call("set_setting", { key: "engine", value: "x" })).toEqual({ result: "There is no tool named set_setting.", is_error: true });
    expect(await tools.call("rename_context", { id: kitchen, colour: "red" })).toEqual({ result: "Tool error: unknown argument colour.", is_error: true });
    expect(await tools.call("get_context", { id: "nowhere" })).toEqual({ result: "Tool error: There is no context nowhere.", is_error: true });
    expect(decided).toEqual(["list_contexts:ran", "get_context:ran", "set_setting:refused", "rename_context:failed", "get_context:failed"]);
    expect(tools.definitions.find((tool) => tool.name === "rename_context")!.parameters).toMatchObject({ type: "object", required: ["id", "name"] });
  });

  it("cut a long result short with its size, its call id and where the rest starts", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("x".repeat(max_result_chars));
    const { tools } = tools_of(fixture);
    const whole = JSON.stringify(fixture.calls.list_contexts());

    const listed = await tools.call("list_contexts", {}, "c1");

    expect(listed.result.startsWith(whole.slice(0, max_result_chars))).toBe(true);
    expect(listed.result.endsWith(`[Cut at 12,000 of ${whole.length.toLocaleString("en")} characters. For the rest call read_tool_result with call_id "c1" and offset 12000, or call list_contexts again with narrower arguments.]`)).toBe(true);
  });

  it("page a kept result to its end with read_tool_result, and say plainly when there is no such call", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("x".repeat(2 * max_result_chars));
    const { tools, decided } = tools_of(fixture);
    const whole = JSON.stringify(fixture.calls.list_contexts());
    await tools.call("list_contexts", {}, "c1");

    let offset = max_result_chars;
    let read = whole.slice(0, max_result_chars);
    for (;;) {
      const page = await tools.call("read_tool_result", { call_id: "c1", offset });
      expect(page.is_error).toBe(false);
      const [slice, marker] = [page.result.slice(0, page.result.lastIndexOf("\n[")), page.result.slice(page.result.lastIndexOf("\n[") + 1)];
      expect(slice.length).toBeLessThanOrEqual(max_result_chars);
      read += slice;
      offset += slice.length;
      if (marker.endsWith("That is the end.]")) break;
      expect(marker).toContain(`with call_id "c1" and offset ${offset}.]`);
    }
    expect(read).toBe(whole);
    expect((await tools.call("read_tool_result", { call_id: "c1", offset: whole.length })).result).toContain("There is no more");
    expect(await tools.call("read_tool_result", { call_id: "c1", offset: 5, length: 3 })).toMatchObject({ result: `${whole.slice(5, 8)}\n[Characters 5 to 8 of ${whole.length.toLocaleString("en")} of list_contexts call "c1". For the rest call read_tool_result with call_id "c1" and offset 8.]` });

    const unknown = await tools.call("read_tool_result", { call_id: "nowhere" });
    expect(unknown).toEqual({ result: 'Tool error: there is no result with call_id "nowhere" in this run. The calls kept in this run are: c1.', is_error: true });
    expect(decided.at(-1)).toBe("read_tool_result:failed");
  });

  it("read back a dropped result by the call its marker names", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("Kitchen");
    const { tools } = tools_of(fixture);
    const listed = await tools.call("list_contexts", {}, "call_7");
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "question" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_7", name: "list_contexts", arguments: "{}" }] },
      { role: "tool", tool_call_id: "call_7", content: listed.result + "x".repeat(6000) },
      { role: "assistant", content: "", tool_calls: [{ id: "call_8", name: "get_context", arguments: "{}" }] },
      { role: "tool", tool_call_id: "call_8", content: "y".repeat(6000) },
    ];

    const fit = fit_request(messages, tools.definitions.filter((tool) => tool.name === "read_tool_result"), { context_size: 4096, max_tokens: 512, chars_per_token: default_chars_per_token });

    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    const marker = fit.messages[3]!.content;
    expect(marker).toBe('[The result of list_contexts call "call_7" was dropped to fit the context. To read it again call read_tool_result with call_id "call_7".]');
    const call_id = /call_id "([^"]+)"/.exec(marker)![1]!;
    const again = await tools.call("read_tool_result", { call_id });
    expect(again.result).toBe(`${listed.result}\n[Characters 0 to ${listed.result.length} of ${listed.result.length} of list_contexts call "call_7". That is the end.]`);
  });

  it("lower the run again when read_tool_result reads back outside content, and not for CODEX's own", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    const { context, tools } = tools_of(fixture);
    await tools.call("list_contexts", {}, "own");
    await tools.call("get_context", { id: kitchen }, "outside");
    expect(context.has_outside_content).toBe(true);

    context.has_outside_content = false;
    await tools.call("read_tool_result", { call_id: "own" });
    expect(context.has_outside_content).toBe(false);
    const again = await tools.call("read_tool_result", { call_id: "outside" });
    expect(again.result.startsWith("<untrusted-data>")).toBe(true);
    expect(context.has_outside_content).toBe(true);
    expect(context.reads!.at(-1)).toMatchObject({ name: "read_tool_result", arguments: { call_id: "outside" }, sources: ["links"] });
  });

  it("refuse a restricted change, run an auto one recording that the engine made it, and propose the rest", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("remove_context", "restricted");
    fixture.calls.set_action_level("rename_context", "auto");
    const { tools, decided } = tools_of(fixture);

    expect(await tools.call("remove_context", { id: kitchen })).toEqual({ result: "The user does not permit remove_context, so it was not run.", is_error: true });
    expect(await tools.call("rename_context", { id: kitchen, name: "Cooking" })).toEqual({ result: "Done.", is_error: false });
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    const proposed = await tools.call("set_context_notes", { id: kitchen, notes: "Tiles first." });
    expect(proposed.is_error).toBe(false);
    expect(proposed.result).toContain("Not done yet: this change waits for the user's approval.");
    expect(fixture.calls.get_context(kitchen).notes).toBe("");
    expect(decided).toEqual(["remove_context:refused", "rename_context:ran:engine_auto", "set_context_notes:proposed"]);
    expect(fixture.calls.list_proposals(null, "waiting")).toMatchObject([{ method: "set_context_notes", arguments: { id: kitchen, notes: "Tiles first." }, summary: 'Replace the notes of the context “Cooking” with “Tiles first.”.', reason: "level" }]);
  });

  it("propose every change once the run has read outside content, whatever the level", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "background");
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    const { tools } = tools_of(fixture);

    await tools.call("search_kept_items", { query: "tile" });
    const outcome = await tools.call("rename_context", { id: kitchen, name: "Tiles" });

    expect(outcome.result).toContain("because this conversation has read text from other apps");
    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");
    expect(fixture.calls.list_proposals()).toMatchObject([{ method: "rename_context", reason: "outside content", status: "waiting" }]);
  });
});

describe("proposals", () => {
  it("run once approved, recording the result and that the user approved it in the conversation", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "rename_context", arguments: { id: kitchen, name: "Cooking" } };
      const outcome = await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      yield { type: "tool_result", id: "t1", ...outcome };
      yield { type: "done", text: "I proposed renaming it." };
    });

    const { conversation_id } = await fixture.calls.send_message(kitchen, "Rename this to Cooking");
    await wait_for_runs();
    const conversation = fixture.calls.get_conversation(conversation_id);
    const [proposal] = conversation.proposals;
    expect(proposal).toMatchObject({ conversation_id, method: "rename_context", status: "waiting", summary: "Rename the context “Kitchen” to “Cooking”." });
    expect(conversation.messages[1]!.tool_calls).toMatchObject([{ id: "t1", outcome: "proposed", proposal_id: proposal!.id }]);
    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");

    const approved = await fixture.calls.resolve_proposal(proposal!.id, "approve");

    expect(approved).toMatchObject({ status: "approved", result: "Done." });
    expect(approved.resolved_at).not.toBe("");
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    const event = fixture.calls.get_conversation(conversation_id).messages.at(-1)!;
    expect(event).toMatchObject({ role: "event", text: "Approved and done: Rename the context “Kitchen” to “Cooking”." });
    expect(event.tool_calls).toMatchObject([{ name: "rename_context", outcome: "ran", applied_by: "user_approval", proposal_id: proposal!.id }]);
    // The change is in History like any other.
    expect(fixture.calls.list_item_history("context", kitchen).length).toBeGreaterThan(1);
    await expect(fixture.calls.resolve_proposal(proposal!.id, "reject")).rejects.toThrow("That proposal was already approved.");
  });

  it("are set aside when rejected, and recorded as failed when the change fails", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { tools } = tools_of(fixture);
    await tools.call("rename_context", { id: kitchen, name: "Cooking" });
    await tools.call("remove_context", { id: kitchen });
    await tools.call("rename_context", { id: kitchen, name: "Baking" });
    const listed = fixture.calls.list_proposals("general");
    expect(listed.map((proposal) => proposal.method)).toEqual(["rename_context", "remove_context", "rename_context"]);
    const [rename, remove, again] = listed;

    expect(await fixture.calls.resolve_proposal(rename!.id, "reject")).toMatchObject({ status: "rejected" });
    await fixture.calls.resolve_proposal(remove!.id, "approve");
    const failed = await fixture.calls.resolve_proposal(again!.id, "approve");

    expect(failed).toMatchObject({ status: "failed", result: `There is no context ${kitchen}.` });
    const events = fixture.calls.get_conversation("general").messages.map((message) => [message.role, message.text.split(":")[0]]);
    expect(events).toEqual([
      ["event", "Rejected"],
      ["event", "Approved and done"],
      ["event", "Approved, but it failed"],
    ]);
    expect(fixture.calls.get_conversation("general").messages[0]!.tool_calls.map((call) => call.outcome)).toEqual(["rejected"]);
    await expect(fixture.calls.resolve_proposal("nothing", "approve")).rejects.toThrow("There is no proposal nothing.");
    await expect(fixture.calls.resolve_proposal(rename!.id, "maybe" as never)).rejects.toThrow("already rejected");
  });

  it("can remove the context whose conversation proposed it, taking that conversation with it", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      await request.tools.call("remove_context", { id: kitchen });
      yield { type: "done", text: "Proposed." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Remove this context");
    await wait_for_runs();
    const [remove] = fixture.calls.list_proposals(conversation_id);

    expect(await fixture.calls.resolve_proposal(remove!.id, "approve")).toMatchObject({ status: "approved" });
    expect(fixture.calls.list_contexts().map((context) => context.id)).toEqual(["global"]);
    expect(() => fixture.calls.get_conversation(conversation_id)).toThrow("There is no conversation");
    expect(fixture.calls.list_proposals()).toEqual([]);
  });

  it("say each change in plain words, naming contexts and items", () => {
    const fixture = start_fixture();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen", home);
    const item = fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org", kind: "link", title: "Tiles" });
    const said = (method: string, args: Record<string, unknown>) => summarize_call(fixture.database, method, args);

    expect(said("add_context", { name: "Pantry", parent_id: kitchen })).toBe("Add a context named “Pantry” inside the context “Kitchen”.");
    expect(said("add_context", { name: "Work" })).toBe("Add a context named “Work” at the top level.");
    expect(said("set_context_archived", { id: kitchen, is_archived: true })).toBe("Archive the context “Kitchen”.");
    expect(said("set_context_archived", { id: kitchen, is_archived: false })).toBe("Bring back the context “Kitchen”.");
    expect(said("move_context", { id: kitchen, parent_id: null })).toBe("Move the context “Kitchen” at the top level.");
    expect(said("remove_context", { id: "gone" })).toBe("Delete a context that does not exist (gone) and every context inside it; the items stay in their apps.");
    expect(said("add_item", { context_ids: [kitchen, home], collector: "links", item: { title: "Grout" } })).toBe("Add “Grout” from links to the contexts “Kitchen”, “Home”.");
    expect(said("add_manual_item", { context_ids: [kitchen], collector: "links", values: { url: "https://example.org/x" } })).toBe("Add “https://example.org/x” to the context “Kitchen”.");
    expect(said("set_item_note", { context_id: kitchen, item_id: item, note: "floor" })).toBe("Set the note on “Tiles” in the context “Kitchen” to “floor”.");
    expect(said("remove_item", { context_id: kitchen, item_id: "nope" })).toBe("Take the item nope out of the context “Kitchen”.");
    expect(said("move_item", { context_id: kitchen, item_id: item, to_context_id: home })).toBe("Move “Tiles” from the context “Kitchen” to the context “Home”.");
    expect(said("add_item_to_contexts", { item_id: item, context_ids: [home], note: "too" })).toBe("Add “Tiles” to the context “Home” with the note “too”.");
    fixture.database.prepare("INSERT INTO items (id, collector, source_id, kind, title, created_at) VALUES ('conversation:c1', 'conversation', 'c1', 'conversation', 'Plans', '')").run();
    expect(said("add_item_to_contexts", { item_id: "conversation:c1", context_ids: [kitchen] })).toBe("Add the conversation “Plans” to the context “Kitchen”.");
    expect(said("refresh_items", {})).toBe("Ask the apps what became of the items in every context.");
    expect(said("follow_feed", { context_id: kitchen, collector: "x-tasks", feed_id: "tag:1", label: "Renovation" })).toBe("Make the context “Kitchen” follow “Renovation” in x-tasks.");
    expect(said("unfollow_feed", { context_id: kitchen, collector: "x-tasks", feed_id: "tag:1" })).toBe("Stop the context “Kitchen” following tag:1 in x-tasks.");
    expect(said("add_contexts_from_feeds", { collector: "x-tasks", feeds: [{ id: "a", label: "A" }] })).toBe("Make a context following each of “A” in x-tasks, at the top level.");
    expect(said("add_contexts_from_feed_group", { collector: "x-tasks", group_id: "g" })).toBe("Make contexts from the group g in x-tasks, at the top level.");
    expect(said("stop_feed_group_news", { id: kitchen })).toBe("Stop offering the context “Kitchen” the feeds added to the group it was made from.");
    expect(said("set_context_notes", { id: 7, notes: "x".repeat(300) })).toMatch(/^Replace the notes of a context with “x+…”\.$/);
    expect(said("add_item", { context_ids: [], collector: "links" })).toBe("Add “” from links to no context.");
    expect(said("made_up", { a: 1 })).toBe('made_up ({"a":1})');
  });
});

describe("undoing applied changes", () => {
  // A conversation in the context in which the engine renames it, then answers.
  async function renamed_by_engine(fixture: Fixture, kitchen: string): Promise<{ conversation_id: string; message_id: string }> {
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "rename_context", arguments: { id: kitchen, name: "Cooking" } };
      const outcome = await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      yield { type: "tool_result", id: "t1", ...outcome };
      yield { type: "done", text: "Renamed it." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Rename this to Cooking");
    await wait_for_runs();
    return { conversation_id, message_id: fixture.calls.get_conversation(conversation_id).messages[1]!.id };
  }

  it("undoes a change made at the auto level through History, records it in the conversation, and only once", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "auto");
    const { conversation_id, message_id } = await renamed_by_engine(fixture, kitchen);
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    expect(fixture.calls.list_change_undos(conversation_id)).toEqual([{ message_id, call_id: "t1", state: "possible", reason: "" }]);

    expect(fixture.calls.undo_change(message_id, "t1")).toMatchObject({ state: "undone" });

    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");
    const messages = fixture.calls.get_conversation(conversation_id).messages;
    expect(messages.at(-1)).toMatchObject({ role: "event", text: "Undone by you: Rename the context “Kitchen” to “Cooking”." });
    expect(messages[1]!.tool_calls[0]!.undo!.undone_at).toBeTruthy();
    expect(fixture.calls.list_change_undos(conversation_id)).toMatchObject([{ call_id: "t1", state: "undone" }]);
    expect(() => fixture.calls.undo_change(message_id, "t1")).toThrow("already undone");
    expect(() => fixture.calls.undo_change(message_id, "nothing")).toThrow("There is no applied change");
  });

  it("says why it cannot undo a change once the context changed since, and leaves it as it is", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "auto");
    const { conversation_id, message_id } = await renamed_by_engine(fixture, kitchen);
    fixture.calls.set_context_notes(kitchen, "Tiles first.");

    expect(fixture.calls.list_change_undos(conversation_id)).toEqual([{ message_id, call_id: "t1", state: "impossible", reason: "Cooking has changed since, so undoing this would undo that too." }]);
    expect(() => fixture.calls.undo_change(message_id, "t1")).toThrow("has changed since");
    expect(fixture.calls.get_context(kitchen)).toMatchObject({ name: "Cooking", notes: "Tiles first." });
  });

  it("undoes approved changes: a context made is removed, and a removed one comes back with what was inside it", async () => {
    const fixture = start_fixture();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen", home);
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    const { tools } = tools_of(fixture);
    await tools.call("add_context", { name: "Garden", parent_id: null });
    await tools.call("remove_context", { id: home });
    const [add, remove] = fixture.calls.list_proposals("general");
    await fixture.calls.resolve_proposal(add!.id, "approve");
    await fixture.calls.resolve_proposal(remove!.id, "approve");
    expect(fixture.calls.list_contexts(false).map((context) => context.name)).toEqual(["Global", "Garden"]);
    const events = fixture.calls.get_conversation("general").messages;
    const undos = fixture.calls.list_change_undos("general");
    expect(undos.map((each) => each.state)).toEqual(["possible", "possible"]);

    fixture.calls.undo_change(events[1]!.id, remove!.id);
    expect(fixture.calls.list_contexts(false).map((context) => context.name).sort()).toEqual(["Garden", "Global", "Home", "Kitchen"]);
    expect(fixture.calls.get_context(kitchen).items.map((item) => item.title)).toEqual(["Tiles"]);
    fixture.calls.undo_change(events[0]!.id, add!.id);
    expect(fixture.calls.list_contexts(false).map((context) => context.name).sort()).toEqual(["Global", "Home", "Kitchen"]);
  });

  it("says a change History keeps nothing of, such as a refresh, cannot be undone", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("refresh_items", "auto");
    const records: Pick<ToolCallRecord, "undo">[] = [];
    const context: ToolContext = { ...tools_of(fixture).context, on_decided: (_name, record) => void records.push(record) };
    await engine_tools(context).call("refresh_items", {});
    expect(records).toMatchObject([{ undo: { summary: "Ask the apps what became of the items in every context.", steps: [] } }]);
    // The call kept on an answer, as a run keeps it, beside one kept before undoing was recorded.
    const call = { id: "r1", name: "refresh_items", arguments: {}, result: "", is_error: false, outcome: "ran" as const, applied_by: "engine_auto" as const, undo: records[0]!.undo! };
    const message = add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Refreshed.", tool_calls: [call, { ...call, id: "r0", undo: undefined }], sources: [] });
    expect(fixture.calls.list_change_undos("general")).toEqual([
      { message_id: message.id, call_id: "r1", state: "impossible", reason: "It changed nothing History keeps, such as what a refresh found, so it cannot be undone." },
      { message_id: message.id, call_id: "r0", state: "impossible", reason: "Made before undoing was recorded; History keeps its versions to restore by hand." },
    ]);
  });

  it("is the user's alone: never offered to an engine", () => {
    expect(changing_calls()).not.toContain("undo_change");
    expect(changing_calls()).not.toContain("list_change_undos");
  });
});

describe("a proposal's evidence", () => {
  it("names the message that asked, the run, and what the run read before proposing, with excerpts only where marks allow", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const tiles = fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles from the shop" });
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "list_contexts", arguments: {} };
      yield { type: "tool_result", id: "t1", ...(await request.tools.call("list_contexts", {})) };
      yield { type: "tool_call", id: "t2", name: "get_item", arguments: { id: tiles } };
      yield { type: "tool_result", id: "t2", ...(await request.tools.call("get_item", { id: tiles })) };
      yield { type: "tool_call", id: "t3", name: "rename_context", arguments: { id: kitchen, name: "Tiling" } };
      yield { type: "tool_result", id: "t3", ...(await request.tools.call("rename_context", { id: kitchen, name: "Tiling" })) };
      yield { type: "done", text: "Proposed." };
    });

    const { conversation_id, run_id } = await fixture.calls.send_message(kitchen, "Name this after its tiles");
    await wait_for_runs();
    const conversation = fixture.calls.get_conversation(conversation_id);
    const [proposal] = conversation.proposals;

    expect(proposal!.evidence.asked_by).toBe(conversation.messages[0]!.id);
    expect(proposal!.evidence.run_id).toBe(run_id);
    expect(proposal!.evidence.reads.map((read) => [read.call_id, read.name, read.sources])).toEqual([
      ["t1", "list_contexts", []],
      ["t2", "get_item", ["links"]],
    ]);
    // The user's own words may be quoted; Web links is not marked to leave this computer, so its read is named, not quoted.
    expect(proposal!.evidence.reads[0]!.excerpt).toContain("Kitchen");
    expect(proposal!.evidence.reads[1]!.excerpt).toBe("");
    expect(proposal!.summary).toBe("Rename the context “Kitchen” to “Tiling”.");

    fixture.calls.set_source_mark("codex.links", "send_to_hosted", true);
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "u1", name: "get_item", arguments: { id: tiles } };
      yield { type: "tool_result", id: "u1", ...(await request.tools.call("get_item", { id: tiles })) };
      yield { type: "tool_call", id: "u2", name: "rename_context", arguments: { id: kitchen, name: "Tiles" } };
      yield { type: "tool_result", id: "u2", ...(await request.tools.call("rename_context", { id: kitchen, name: "Tiles" })) };
      yield { type: "done", text: "Proposed." };
    });
    await fixture.calls.send_message(kitchen, "Or just Tiles", conversation_id);
    await wait_for_runs();
    const marked = fixture.calls.get_conversation(conversation_id).proposals.at(-1)!;
    expect(marked.evidence.reads).toMatchObject([{ call_id: "u1", name: "get_item", sources: ["links"] }]);
    expect(marked.evidence.reads[0]!.excerpt).toContain("Tiles from the shop");
    // Its instructions listed the context's items, so their source was in front of it as well as read.
    expect(marked.evidence.seen).toEqual(["links"]);
  });

  it("names as where it came from only the sources a run had in front of it, none when it had none", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const garden = fixture.calls.add_context("Garden");
    const tiles = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles from the shop" });
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "add_item_to_contexts", arguments: { item_id: tiles, context_ids: [kitchen] } };
      yield { type: "tool_result", id: "t1", ...(await request.tools.call("add_item_to_contexts", { item_id: tiles, context_ids: [kitchen] })) };
      yield { type: "done", text: "Proposed." };
    });

    // Kitchen holds nothing, so its instructions list no item, and the run reads nothing before proposing an item it names.
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Put the tiles link here");
    await wait_for_runs();
    const [proposal] = fixture.calls.get_conversation(conversation_id).proposals;

    expect(proposal!.evidence).toMatchObject({ reads: [], seen: [] });
    expect(proposal!.sources).toContain("links");
  });
});
