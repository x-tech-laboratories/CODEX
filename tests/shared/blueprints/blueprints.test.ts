import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { content_words, matches_by_words, recall_blueprints, recall_caps, recalled_part, shared_words } from "../../../src/shared/blueprints/recall.ts";
import { blueprint_item_id } from "../../../src/shared/blueprints/model.ts";
import { save_as_blueprint_message } from "../../../src/shared/blueprints/store.ts";
import type { ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { add_conversation_record } from "../../../src/shared/conversations/records.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { engine_tools, type ToolContext } from "../../../src/shared/conversations/tools.ts";
import { page_only_methods } from "../../../src/shared/store.ts";
import { open_screen } from "../../../src/shared/privacy/screen.ts";
import { embed_pending, open_index, sync_documents, use_search_index } from "../../../src/shared/search/indexer.ts";
import { search } from "../../../src/shared/search/search.ts";
import { text_hash } from "../../../src/shared/search/text.ts";
import { bind_methods, context_api } from "../../../src/shared/store.ts";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
  use_search_index(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const sorting = {
  title: "Sort the mail",
  applies_when: "When the user asks to sort, triage or file their email inbox.",
  body: "1. Read the inbox with search_index.\n2. File receipts under Taxes.\n3. Flag anything from the landlord.",
};

// The tools a run gets in a conversation, as an engine named "fake" answering with "fake-model".
async function tools_of(fixture: Fixture, hosted = false, conversation_id = "talk"): Promise<{ context: ToolContext; tools: ReturnType<typeof engine_tools> }> {
  add_conversation_record(fixture.database, null, conversation_id);
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id,
    presence: "conversation",
    has_outside_content: false,
    screen: await open_screen(fixture.database, hosted),
    maker: { engine: "fake", model: "fake-model" },
    run_id: "run-1",
  };
  return { context, tools: engine_tools(context) };
}

// ── The user's own ───────────────────────────────────────────────────────────

describe("blueprints the user writes", () => {
  it("are active at once, items of their context, listed where they apply, and edited, retired, placed and removed", () => {
    const fixture = start_fixture();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen", home);
    const garden = fixture.calls.add_context("Garden", home);
    const in_home = fixture.calls.add_blueprint(sorting.title, sorting.applies_when, sorting.body, home);
    const everywhere = fixture.calls.add_blueprint("Weekly review", "When the user asks for the weekly review.", "1. List open tasks.", null);
    const in_garden = fixture.calls.add_blueprint("Plant out", "When planting seedlings out.", "1. Harden them off.", garden);

    expect(fixture.calls.get_blueprint(in_home)).toMatchObject({ status: "active", made_by: "user", contexts: [{ id: home, name: "Home" }], sources: [], link: `codex://blueprint/${in_home}` });
    expect(fixture.calls.get_context(home).items).toMatchObject([{ id: blueprint_item_id(in_home), kind: "blueprint", title: "Sort the mail", snippet: sorting.applies_when, status: "", uri: `codex://blueprint/${in_home}` }]);
    expect(fixture.calls.list_blueprints(kitchen).map((each) => each.id).sort()).toEqual([in_home, everywhere].sort());
    expect(fixture.calls.list_blueprints(null).map((each) => each.id)).toEqual([everywhere]);
    expect(fixture.calls.list_blueprints().map((each) => each.title)).toEqual(["Plant out", "Sort the mail", "Weekly review"]);
    expect(fixture.calls.list_blueprints(undefined, "retired")).toEqual([]);
    expect(() => fixture.calls.list_blueprints(undefined, "lost" as never)).toThrow("status is one of");

    fixture.calls.change_blueprint(in_home, { body: "1. Read the inbox.\n2. File receipts." });
    expect(fixture.calls.get_blueprint(in_home)).toMatchObject({ title: "Sort the mail", body: "1. Read the inbox.\n2. File receipts." });
    expect(() => fixture.calls.change_blueprint(in_home, { title: " " })).toThrow("needs a title");
    expect(() => fixture.calls.add_blueprint("x".repeat(200), "a", "b")).toThrow("at most 120");
    expect(() => fixture.calls.add_blueprint("A", "b", "c", "nowhere")).toThrow("There is no context nowhere");

    fixture.calls.retire_blueprint(in_garden);
    expect(fixture.calls.get_context(garden).items[0]).toMatchObject({ status: "retired" });
    expect(() => fixture.calls.restore_blueprint(in_home)).toThrow("Only a retired blueprint");
    fixture.calls.restore_blueprint(in_garden);
    expect(fixture.calls.get_blueprint(in_garden).status).toBe("active");

    fixture.calls.place_blueprint(in_garden, null);
    expect(fixture.calls.get_blueprint(in_garden).contexts).toEqual([{ id: "global", name: "Global" }]);
    fixture.calls.place_blueprint(in_garden, kitchen);
    expect(fixture.calls.get_blueprint(in_garden).contexts).toEqual([{ id: kitchen, name: "Kitchen" }]);

    // Leaving it in no context would make it apply everywhere, which only place_blueprint does.
    expect(() => fixture.calls.remove_item(kitchen, blueprint_item_id(in_garden))).toThrow("last context holding that blueprint");
    expect(() => fixture.calls.add_item([kitchen], "blueprint", { source_id: "x", kind: "blueprint", title: "x" })).toThrow("written with add_blueprint");
    fixture.calls.move_item(kitchen, blueprint_item_id(in_garden), garden);
    expect(fixture.calls.get_blueprint(in_garden).contexts).toEqual([{ id: garden, name: "Garden" }]);

    fixture.calls.remove_blueprint(in_garden);
    expect(() => fixture.calls.get_blueprint(in_garden)).toThrow("There is no blueprint");
    expect(fixture.calls.get_item(blueprint_item_id(in_garden)).status).toBe("missing");
    expect(() => fixture.calls.add_item_to_contexts(blueprint_item_id(in_garden), [kitchen])).toThrow("That blueprint was deleted.");
  });

  it("go with a removed context rather than come to apply everywhere, and History brings one back where it was", () => {
    const fixture = start_fixture();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_blueprint(sorting.title, sorting.applies_when, sorting.body, kitchen);
    fixture.calls.change_blueprint(id, { title: "Sort the post" });
    const versions = fixture.calls.list_item_history("blueprint", id);
    expect(versions.map((version) => [version.change, version.item_name])).toEqual([
      ["edited", "Sort the post"],
      ["created", "Sort the mail"],
    ]);
    expect(versions[1]!.summary).toBe("active, in 1 context");

    fixture.calls.restore_item_version("blueprint", versions[1]!.id);
    expect(fixture.calls.get_blueprint(id).title).toBe("Sort the mail");

    fixture.calls.remove_context(kitchen);
    expect(fixture.calls.list_blueprints()).toEqual([]);
    const deleted = fixture.calls.list_item_history("blueprint", id)[0]!;
    expect(deleted.change).toBe("deleted");
    fixture.calls.restore_item_version("context", fixture.calls.list_item_history("context", kitchen)[0]!.id);
    fixture.calls.restore_item_version("blueprint", fixture.calls.list_item_history("blueprint", id)[1]!.id);
    expect(fixture.calls.get_blueprint(id)).toMatchObject({ title: "Sort the mail", contexts: [{ id: kitchen, name: "Kitchen" }] });
    expect(fixture.calls.get_context(kitchen).items.map((item) => item.status)).toEqual([""]);
    expect(home).toBeTruthy();
  });

  it("are answered for by the item calls, found and read like CODEX's other items", async () => {
    const fixture = start_fixture();
    const id = fixture.calls.add_blueprint(sorting.title, sorting.applies_when, sorting.body);
    expect(await fixture.calls.get_items([`blueprint:${id}`])).toMatchObject([{ id: `blueprint:${id}`, kind: "blueprint", title: "Sort the mail", snippet: sorting.applies_when, link: `codex://blueprint/${id}`, status: "active" }]);
    expect((await fixture.calls.search_items("landlord")).map((item) => item.id)).toEqual([`blueprint:${id}`]);
    expect((await fixture.calls.list_item_changes(null)).map((item) => item.id)).toContain(`blueprint:${id}`);
  });
});

// ── Proposals ────────────────────────────────────────────────────────────────

describe("blueprints an engine or a program writes", () => {
  it("are only proposed, carrying the run's sources, and only the user at the page accepts or rejects them", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { tools } = await tools_of(fixture);
    const outcome = await tools.call("propose_blueprint", { ...sorting, context_id: kitchen });
    expect(outcome.is_error).toBe(false);
    const [proposed] = fixture.calls.list_blueprint_proposals("talk");
    expect(proposed).toMatchObject({ kind: "new", title: "Sort the mail", body: sorting.body, before: null, made_by: "engine", engine: "fake", model: "fake-model", conversation_id: "talk" });
    expect(fixture.calls.get_blueprint(proposed!.id).status).toBe("proposed");
    expect(fixture.calls.get_context(kitchen).items[0]).toMatchObject({ status: "proposed" });
    expect(fixture.calls.list_blueprint_proposals("elsewhere")).toEqual([]);

    expect(fixture.calls.accept_blueprint_proposals([proposed!.id])).toEqual({ decided: [proposed!.id], skipped: [] });
    expect(fixture.calls.get_blueprint(proposed!.id)).toMatchObject({ status: "active", sources: [], made_by: "engine" });
    expect(fixture.calls.accept_blueprint_proposals([proposed!.id, "nothing"]).skipped).toEqual([
      { id: proposed!.id, reason: "That blueprint is not waiting for you." },
      { id: "nothing", reason: "There is no proposed blueprint or change nothing." },
    ]);
    expect(() => fixture.calls.accept_blueprint_proposals([])).toThrow("Give the ids");

    await tools.call("propose_blueprint", { title: "Bad idea", applies_when: "Never.", body: "Do nothing." });
    const bad = fixture.calls.list_blueprint_proposals()[0]!;
    fixture.calls.reject_blueprint_proposals([bad.id]);
    expect(() => fixture.calls.get_blueprint(bad.id)).toThrow("There is no blueprint");

    // Every deciding call is the user's alone: marked page-only, and never a tool.
    for (const name of ["accept_blueprint_proposals", "reject_blueprint_proposals", "restore_blueprint", "place_blueprint"]) {
      expect(page_only_methods.has(name)).toBe(true);
      expect((context_api as Record<string, { page_only?: boolean }>)[name]!.page_only).toBe(true);
      expect(tools.definitions.map((tool) => tool.name)).not.toContain(name);
    }
  });

  it("propose a change with why, shown beside the blueprint as it reads, which accepting puts in place", async () => {
    const fixture = start_fixture();
    const id = fixture.calls.add_blueprint(sorting.title, sorting.applies_when, sorting.body);
    const { tools } = await tools_of(fixture);
    const same = await tools.call("propose_blueprint_change", { id, body: sorting.body, reason: "No reason." });
    expect(same.result).toContain("nothing would change");
    await tools.call("propose_blueprint_change", { id, body: `${sorting.body}\n4. Archive newsletters.`, reason: "The user asked to archive newsletters too." });
    const [change] = fixture.calls.list_blueprint_proposals();
    expect(change).toMatchObject({ kind: "change", blueprint_id: id, title: "Sort the mail", reason: "The user asked to archive newsletters too.", before: { body: sorting.body } });
    expect(fixture.calls.get_blueprint(id)).toMatchObject({ waiting_changes: 1, changes: [{ id: change!.id, status: "waiting" }] });

    fixture.calls.accept_blueprint_proposals([change!.id]);
    expect(fixture.calls.get_blueprint(id)).toMatchObject({ body: `${sorting.body}\n4. Archive newsletters.`, waiting_changes: 0, changes: [{ status: "accepted" }] });
    expect(fixture.calls.accept_blueprint_proposals([change!.id]).skipped[0]!.reason).toBe("That change was already accepted.");

    await tools.call("propose_blueprint_change", { id, body: "Nothing.", reason: "Shorter." });
    const second = fixture.calls.list_blueprint_proposals()[0]!;
    fixture.calls.reject_blueprint_proposals([second.id]);
    expect(fixture.calls.get_blueprint(id).body).toContain("Archive newsletters");

    await tools.call("propose_blueprint", { title: "New", applies_when: "Now.", body: "Go." });
    const waiting = fixture.calls.list_blueprint_proposals()[0]!;
    expect((await tools.call("propose_blueprint_change", { id: waiting.id, body: "Other.", reason: "x" })).result).toContain("still waits for the user");
  });

  it("are a program's proposals through a token or MCP, while the user's own edit makes a proposed one active", async () => {
    const fixture = start_fixture();
    const program = bind_methods(() => fixture.database, () => undefined, "program");
    const id = program.add_blueprint(sorting.title, sorting.applies_when, sorting.body);
    expect(fixture.calls.get_blueprint(id)).toMatchObject({ status: "proposed", made_by: "program" });
    const change = program.change_blueprint(id, { title: "Sort the post" });
    expect(change).not.toBe(id);
    expect(fixture.calls.get_blueprint(id).title).toBe("Sort the mail");
    expect(program.propose_blueprint("By program", "When asked.", "Do it.")).toMatchObject({ outcome: "proposed" });
    expect(fixture.calls.list_blueprints(undefined, "proposed").find((each) => each.title === "By program")!.made_by).toBe("program");

    fixture.calls.change_blueprint(id, { applies_when: "When sorting the inbox." });
    expect(fixture.calls.get_blueprint(id)).toMatchObject({ status: "active", applies_when: "When sorting the inbox.", sources: [] });
  });

  it("withhold a proposed blueprint from a hosted engine until the user makes it theirs, then send it whole", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const local = await tools_of(fixture, false, "first");
    // A run that read the unmarked links collector proposes a blueprint, which carries that source.
    local.context.screen!.included.set("links", new Set(["item:links:a"]));
    await local.tools.call("propose_blueprint", { ...sorting, context_id: kitchen });
    const [proposed] = fixture.calls.list_blueprint_proposals();
    expect(proposed!.sources).toEqual(["links"]);

    const hosted = await tools_of(fixture, true, "second");
    const listed = await hosted.tools.call("list_blueprints", {});
    expect(listed.result).toContain("[]");
    expect(listed.result).toContain("Withheld: 1 blueprint");
    const read = await hosted.tools.call("get_blueprint", { id: proposed!.id });
    expect(read.result).toContain('"withheld":true');
    const context = await hosted.tools.call("get_context", { id: kitchen });
    expect(context.result).not.toContain("Sort the mail");

    fixture.calls.accept_blueprint_proposals([proposed!.id]);
    const after = await hosted.tools.call("get_blueprint", { id: proposed!.id });
    expect(after.result).toContain("Sort the mail");
    expect(after.result).not.toContain("<untrusted-data>");
    expect(hosted.context.has_outside_content).toBe(false);
  });
});

// ── Recall ───────────────────────────────────────────────────────────────────

describe("recall", () => {
  it("matches by enough shared words, ignoring words that say nothing of a task", () => {
    expect(content_words("Can you please sort my mail?")).toEqual(["sort", "mail"]);
    expect(content_words("Sorting the émails")).toEqual(["sort", "email"]);
    const blueprint = content_words(`${sorting.title} ${sorting.applies_when}`);
    expect(shared_words(["sort", "mail"], blueprint)).toBe(2);
    expect(matches_by_words(content_words("sort my mail"), blueprint)).toBe(true);
    expect(matches_by_words(content_words("please file this task under the kitchen"), blueprint)).toBe(false);
    expect(matches_by_words(content_words("What is on my calendar?"), blueprint)).toBe(false);
    expect(matches_by_words(content_words("taxes"), content_words("Taxes"))).toBe(true);
    expect(matches_by_words(content_words("sort out the taxes for 2025 and what is missing"), content_words("Taxes"))).toBe(true);
  });

  it("puts the matching active blueprints that apply here in the instructions, unfenced, notes each use, and never a proposed or retired one", async () => {
    const fixture = start_fixture();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen", home);
    const garden = fixture.calls.add_context("Garden");
    const sort = fixture.calls.add_blueprint(sorting.title, sorting.applies_when, sorting.body, home);
    fixture.calls.add_blueprint("Sort the seeds", "When the user asks to sort the seed packets by sowing month.", "1. Group by month.", garden);
    const retired = fixture.calls.add_blueprint("Sort the mail, old way", "When sorting mail.", "1. Old.");
    fixture.calls.retire_blueprint(retired);
    const { tools } = await tools_of(fixture);
    await tools.call("propose_blueprint", { title: "Sort the mail faster", applies_when: "When sorting mail.", body: "1. Skip." });

    const { conversation_id } = await fixture.calls.send_message(kitchen, "Please sort my mail");
    await wait_for_runs();
    const instructions = fixture.requests[0]!.instructions;
    expect(instructions).toContain("Blueprints to follow.");
    expect(instructions).toContain(`Blueprint “Sort the mail” (id ${sort})\nApplies when: ${sorting.applies_when}\n${sorting.body}`);
    expect(instructions).toContain("begin your answer by saying which blueprint you are following");
    expect(instructions).not.toContain("Sort the seeds");
    expect(instructions).not.toContain("old way");
    expect(instructions).not.toContain("Skip.");
    expect(instructions.slice(instructions.indexOf("Blueprints to follow."))).not.toContain("<untrusted-data>");
    expect(instructions).toContain("offer to save them as a blueprint");

    const answer = fixture.calls.get_conversation(conversation_id).messages[1]!;
    expect(answer.notices).toEqual(["Recalled the blueprint “Sort the mail” for this message."]);
    expect(fixture.events.some((event) => event.type === "notice" && event.text.includes("Sort the mail"))).toBe(true);
    expect(fixture.calls.get_blueprint(sort)).toMatchObject({ use_count: 1 });
    expect(fixture.calls.get_blueprint(sort).last_used_at).not.toBe("");

    // A change it proposes is not tainted by having followed the blueprint.
    fixture.set_script(async function* (request) {
      await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      yield { type: "done", text: "Following “Sort the mail”." };
    });
    fixture.calls.set_action_level("rename_context", "auto");
    await fixture.calls.send_message(kitchen, "sort the mail again", conversation_id);
    await wait_for_runs();
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");

    await fixture.calls.send_message(garden, "What is on my calendar?");
    await wait_for_runs();
    expect(fixture.requests.at(-1)!.instructions).not.toContain("Blueprints to follow.");
  });

  it("is capped by count and by characters, cutting the last one short", async () => {
    const fixture = start_fixture();
    for (let at = 0; at < 5; at++) fixture.calls.add_blueprint(`Sort mail ${at}`, "When sorting mail.", `${"Step. ".repeat(400)}`);
    const recalled = await recall_blueprints(fixture.database, null, "sort the mail");
    expect(recalled.length).toBeLessThanOrEqual(recall_caps.most);
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled_part(recalled).length).toBeLessThan(recall_caps.chars + 1000);
    expect(recalled.at(-1)!.body).toContain("[Cut short to fit; get_blueprint gives the whole of it.]");
    expect(recalled_part([])).toBe("");
    expect(await recall_blueprints(fixture.database, null, "   ")).toEqual([]);
  });

  it("matches by meaning through the index when an embedder stands one out, and words alone without one", async () => {
    const same: Record<string, string> = { correspondence: "mail", letters: "mail", organise: "sort", tidy: "sort" };
    const vector_of = (text: string) => {
      const vector = Array.from({ length: 256 }, () => 0);
      for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) vector[Number.parseInt(text_hash(same[raw] ?? raw), 16) % 256]! += 1;
      return vector;
    };
    const embedder = define_plugin<ContextPluginApi>({
      id: "tests.embedder",
      name: "Embedder",
      version: "1.0.0",
      start: (context) => context.provide("embedder", "fake-embedder", { label: "Fake embedder", model: () => "words", dimensions: () => 256, is_local: () => true, embed: async (texts) => texts.map(vector_of) }),
    });
    const fixture = start_fixture({ plugins: [embedder] });
    const index = new DatabaseSync(":memory:");
    open_index(index);
    use_search_index({ database: () => fixture.database, index: () => index });
    const sort = fixture.calls.add_blueprint("Mail", "Mail mail sort sort.", "Sort mail.");
    for (const name of ["Garden", "Kitchen", "Taxes", "Holidays", "Car", "Books", "Music", "Health", "Bank"]) fixture.calls.add_context(name);

    expect((await recall_blueprints(fixture.database, null, "tidy correspondence letters")).map((each) => each.row.id)).toEqual([]);
    fixture.calls.set_setting("embedder", "fake-embedder");
    await sync_documents(fixture.database, index);
    await embed_pending(fixture.database, index, new AbortController().signal, 0);
    const recalled = await recall_blueprints(fixture.database, null, "tidy correspondence letters");
    expect(recalled.map((each) => [each.row.id, each.matched_by])).toEqual([[sort, ["meaning"]]]);
    expect((await search(fixture.database, index, "landlord")).length).toBe(0);
    expect((await search(fixture.database, index, "Mail")).map((hit) => hit.id)).toContain(blueprint_item_id(sort));
  });
});

// ── Saving ───────────────────────────────────────────────────────────────────

describe("save as blueprint", () => {
  it("asks the engine, in the conversation, to propose one from what was done there", async () => {
    const fixture = start_fixture();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Sort my mail: receipts to Taxes first, then flag the landlord.");
    await wait_for_runs();
    fixture.set_script(async function* (request) {
      await request.tools.call("propose_blueprint", { ...sorting, context_id: kitchen });
      yield { type: "done", text: "I proposed the blueprint “Sort the mail”." };
    });
    const started = await fixture.calls.save_as_blueprint(conversation_id);
    await wait_for_runs();
    expect(started.conversation_id).toBe(conversation_id);
    const conversation = fixture.calls.get_conversation(conversation_id);
    expect(conversation.messages[2]!.text).toBe(save_as_blueprint_message);
    expect(fixture.calls.list_blueprint_proposals(conversation_id)).toMatchObject([{ title: "Sort the mail", conversation_id }]);
  });
});
