import { afterEach, describe, expect, it } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { engine_tools, max_result_chars, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { brings_outside_content, changing_calls, decide } from "../src/shared/policy/policy.ts";
import { summarize_call } from "../src/shared/policy/summaries.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

// The tools a conversation run gets, calling the fixture's store as the host does.
function tools_of(fixture: Fixture, conversation_id = "general"): { context: ToolContext; tools: ReturnType<typeof engine_tools>; decided: string[] } {
  const decided: string[] = [];
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id,
    presence: "conversation",
    has_outside_content: false,
    on_decided: (name, record) => decided.push(`${name}:${record.outcome}${record.applied_by ? `:${record.applied_by}` : ""}`),
  };
  return { context, tools: engine_tools(context), decided };
}

describe("the levels", () => {
  it("start every change at proposal, and keep a level set for one call", () => {
    const fixture = start_fixture();
    const policy = fixture.calls.get_action_policy();

    expect(policy.map((entry) => entry.method)).toEqual(changing_calls());
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
  "add_manual_item",
  "follow_feed",
  "get_context",
  "get_item",
  "list_collector_feeds",
  "list_collectors",
  "list_contexts",
  "list_feed_group_news",
  "move_context",
  "refresh_items",
  "remove_context",
  "remove_item",
  "rename_context",
  "search_collector",
  "search_index",
  "search_kept_items",
  "set_context_archived",
  "set_context_notes",
  "set_item_note",
  "stop_feed_group_news",
  "unfollow_feed",
];

describe("a run's tools", () => {
  it("are exactly the allowed calls, and never settings, plugins, the policy, marks or anything only the page may call", () => {
    const fixture = start_fixture();
    const { tools } = tools_of(fixture);
    expect(tools.definitions.map((tool) => tool.name).sort()).toEqual(allowed_tools);
    for (const never of ["set_setting", "get_settings", "set_action_level", "resolve_proposal", "set_source_mark", "rebuild_index", "import_contexts", "send_message", "clear_conversation"]) {
      expect(allowed_tools).not.toContain(never);
    }
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

  it("cut a long result short", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("x".repeat(max_result_chars));
    const { tools } = tools_of(fixture);
    const listed = await tools.call("list_contexts", {});
    expect(listed.result.length).toBe(max_result_chars);
    expect(listed.result.endsWith("[Cut short to fit.]")).toBe(true);
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

    await fixture.calls.send_message(kitchen, "Rename this to Cooking");
    await wait_for_runs();
    const conversation = fixture.calls.get_conversation(kitchen);
    const [proposal] = conversation.proposals;
    expect(proposal).toMatchObject({ conversation_id: kitchen, method: "rename_context", status: "waiting", summary: "Rename the context “Kitchen” to “Cooking”." });
    expect(conversation.messages[1]!.tool_calls).toMatchObject([{ id: "t1", outcome: "proposed", proposal_id: proposal!.id }]);
    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");

    const approved = await fixture.calls.resolve_proposal(proposal!.id, "approve");

    expect(approved).toMatchObject({ status: "approved", result: "Done." });
    expect(approved.resolved_at).not.toBe("");
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    const event = fixture.calls.get_conversation(kitchen).messages.at(-1)!;
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
    const events = fixture.calls.get_conversation(null).messages.map((message) => [message.role, message.text.split(":")[0]]);
    expect(events).toEqual([
      ["event", "Rejected"],
      ["event", "Approved and done"],
      ["event", "Approved, but it failed"],
    ]);
    await expect(fixture.calls.resolve_proposal("nothing", "approve")).rejects.toThrow("There is no proposal nothing.");
    await expect(fixture.calls.resolve_proposal(rename!.id, "maybe" as never)).rejects.toThrow("already rejected");
  });

  it("can remove the context whose conversation proposed it, taking that conversation with it", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { tools } = tools_of(fixture, kitchen);
    await tools.call("remove_context", { id: kitchen });
    const [remove] = fixture.calls.list_proposals(kitchen);

    expect(await fixture.calls.resolve_proposal(remove!.id, "approve")).toMatchObject({ status: "approved" });
    expect(fixture.calls.list_contexts()).toEqual([]);
    expect(fixture.calls.get_conversation(kitchen)).toMatchObject({ messages: [], proposals: [] });
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
