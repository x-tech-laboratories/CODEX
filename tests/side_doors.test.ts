// Withheld content cannot reach a hosted engine or embedder another way: through earlier answers, the plain-words
// summaries of proposals in events, or messages found by search.

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { engine_tools, turns_of, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { open_screen } from "../src/shared/privacy/screen.ts";
import { index_now, open_index, settle_index, use_search_index } from "../src/shared/search/indexer.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await settle_index();
  await wait_for_runs();
  use_search_index(null);
  use_assistant_host(null);
});

// A kitchen holding a web link, whose source is not marked for hosted engines.
function kitchen_of(fixture: Fixture): { kitchen: string; link: string } {
  const kitchen = fixture.calls.add_context("Kitchen");
  const link = fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/grout", kind: "link", title: "Grout guide" });
  return { kitchen, link };
}

describe("earlier answers", () => {
  it("written while a local engine read an unmarked source are withheld once a hosted engine takes over, and counted", async () => {
    const fixture = start_fixture();
    const { kitchen, link } = kitchen_of(fixture);
    fixture.set_script(async function* (request) {
      const read = await request.tools.call("get_item", { id: link });
      yield { type: "done", text: read.result.includes("Grout guide") ? "The Grout guide is here." : "Nothing." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "What is the link?");
    await wait_for_runs();
    const [question, answer] = fixture.calls.get_conversation(conversation_id).messages;
    expect([question!.sources, answer!.sources, answer!.text]).toEqual([[], ["links"], "The Grout guide is here."]);

    fixture.set_hosted(true);
    fixture.set_script(async function* () {
      yield { type: "done", text: "Hosted." };
    });
    await fixture.calls.send_message(kitchen, "And again?");
    await wait_for_runs();
    const sent = fixture.requests.at(-1)!;
    expect(sent.conversation.map((turn) => turn.text)).toEqual([
      "What is the link?",
      "[An earlier answer is withheld from this hosted engine: it drew on Web links, which the user has not marked “May be sent to a hosted engine”.]",
      "And again?",
    ]);
    expect(JSON.stringify(sent)).not.toContain("Grout");
    const [send] = fixture.calls.list_hosted_sends();
    expect(send!.withheld).toEqual([{ collector: "links", label: "Web links", count: 2 }]);
    // The hosted answer read nothing from other apps.
    expect(fixture.calls.get_conversation(conversation_id).messages.at(-1)!.sources).toEqual([]);

    fixture.calls.set_source_mark("codex.links", "send_to_hosted", true);
    expect(turns_of(fixture.database, conversation_id, await open_screen(fixture.database, true))[1]!.text).toBe("The Grout guide is here.");
  });

  it("kept before sources were recorded are withheld from a hosted engine, while the user's own messages are sent", async () => {
    const fixture = start_fixture({ hosted: true });
    add_message(fixture.database, { conversation_id: "general", role: "user", text: "Old question" });
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Old answer quoting a note" });
    const screen = await open_screen(fixture.database, true);
    const turns = turns_of(fixture.database, "general", screen);
    expect(turns.map((turn) => turn.text)).toEqual(["Old question", expect.stringContaining("it drew on sources not recorded (kept before 2026-11-26)")]);
    expect([...screen.withheld.keys()]).toEqual(["*"]);
    // A local engine reads them whole.
    expect(turns_of(fixture.database, "general").map((turn) => turn.text)).toEqual(["Old question", "Old answer quoting a note"]);
  });

  it("carry the sources of the answers they were written over, so a local answer echoing one is withheld too", async () => {
    const fixture = start_fixture();
    add_conversation_record(fixture.database, null, "general");
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "From a note.", sources: ["links"] });
    fixture.set_script(async function* () {
      yield { type: "done", text: "Echo." };
    });
    await fixture.calls.send_message(null, "Say it again", "general");
    await wait_for_runs();
    expect(fixture.calls.get_conversation("general").messages.at(-1)!.sources).toEqual(["links"]);
  });

  it("drawn on a source not marked trusted taint the run they are replayed to, so its changes wait, as reading that source again would", async () => {
    const fixture = start_fixture();
    // A context holding nothing from other apps, so only the replayed answer can taint the run.
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "auto");
    add_conversation_record(fixture.database, kitchen, "c1");
    add_message(fixture.database, { conversation_id: "c1", role: "user", text: "What is the link?", sources: [] });
    add_message(fixture.database, { conversation_id: "c1", role: "assistant", text: "The Grout guide.", sources: ["links"] });
    fixture.set_script(async function* (request) {
      const outcome = await request.tools.call("rename_context", { id: kitchen, name: "Grout" });
      yield { type: "done", text: outcome.result };
    });

    await fixture.calls.send_message(kitchen, "Rename the kitchen", "c1");
    await wait_for_runs();
    expect(fixture.calls.list_proposals("c1")).toMatchObject([{ method: "rename_context", reason: "outside content", status: "waiting" }]);
    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");

    // Once that source is trusted, the same replay leaves the change at its own level.
    fixture.calls.set_source_mark("codex.links", "trusted", true);
    await fixture.calls.send_message(kitchen, "Rename it now", "c1");
    await wait_for_runs();
    expect(fixture.calls.get_context(kitchen).name).toBe("Grout");
  });

  it("withheld from a hosted engine taint nothing, since it never reads them", async () => {
    const fixture = start_fixture({ hosted: true });
    const { kitchen } = kitchen_of(fixture);
    fixture.calls.set_action_level("rename_context", "auto");
    add_conversation_record(fixture.database, kitchen, "c1");
    add_message(fixture.database, { conversation_id: "c1", role: "assistant", text: "The Grout guide.", sources: ["links"] });
    fixture.set_script(async function* (request) {
      const outcome = await request.tools.call("rename_context", { id: kitchen, name: "Tiles" });
      yield { type: "done", text: outcome.result };
    });
    await fixture.calls.send_message(kitchen, "Rename the kitchen", "c1");
    await wait_for_runs();
    // The open context's instructions hold the unmarked link, withheld too, so nothing outside was read.
    expect(fixture.calls.get_context(kitchen).name).toBe("Tiles");
  });
});

describe("proposals", () => {
  it("record the sources their summary names, and their events are withheld from a hosted engine", async () => {
    const fixture = start_fixture({ hosted: true });
    const { kitchen, link } = kitchen_of(fixture);
    fixture.set_script(async function* (request) {
      // A hosted engine that knows the id but was never sent the title.
      await request.tools.call("set_item_note", { context_id: kitchen, item_id: link, note: "floor" });
      yield { type: "done", text: "Proposed." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Note it");
    await wait_for_runs();
    const [proposal] = fixture.calls.list_proposals(conversation_id);
    expect(proposal!.summary).toContain("Grout guide");
    expect(proposal!.sources).toEqual(["links"]);
    expect(JSON.stringify(fixture.requests.at(-1))).not.toContain("Grout");

    await fixture.calls.resolve_proposal(proposal!.id, "reject");
    expect(fixture.calls.get_conversation(conversation_id).messages.at(-1)).toMatchObject({ role: "event", sources: ["links"] });
    fixture.set_script(async function* () {
      yield { type: "done", text: "Ok." };
    });
    await fixture.calls.send_message(kitchen, "Next");
    await wait_for_runs();
    const last_turn = fixture.requests.at(-1)!.conversation.at(-1)!.text;
    expect(last_turn).toContain("[An earlier event is withheld from this hosted engine: it drew on Web links");
    expect(last_turn).not.toContain("Grout");
  });
});

describe("search", () => {
  async function indexed(options: { hosted_embedder?: boolean } = {}) {
    const calls: string[][] = [];
    const embedder = define_plugin<ContextPluginApi>({
      id: "tests.fake-embedder",
      name: "Fake embedder",
      version: "1.0.0",
      start: (context) =>
        context.provide("embedder", "fake-embedder", {
          label: "Fake embedder",
          model: () => "m",
          dimensions: () => 4,
          is_local: () => options.hosted_embedder !== true,
          embed: async (texts) => (calls.push(texts), texts.map(() => [1, 0, 0, 0])),
        }),
    });
    const fixture = start_fixture({ plugins: [embedder] });
    const index = new DatabaseSync(":memory:");
    open_index(index);
    use_search_index({ database: () => fixture.database, index: () => index });
    fixture.calls.set_setting("embedder", "fake-embedder");
    add_message(fixture.database, { conversation_id: "general", role: "user", text: "Mine: grout colour", sources: [] });
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "From the link: grout guide", sources: ["links"] });
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Old: grout in the shed" });
    add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Plain: grout is cheap", sources: [] });
    await index_now();
    return { fixture, calls };
  }

  it("withholds from a hosted engine the answers that drew on unmarked or unrecorded sources, and taints by them", async () => {
    const { fixture } = await indexed();
    const tools_for = async (hosted: boolean) => {
      const context: ToolContext = {
        database: () => fixture.database,
        call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
        conversation_id: "general",
        presence: "conversation",
        has_outside_content: false,
        screen: await open_screen(fixture.database, hosted),
      };
      return { context, tools: engine_tools(context) };
    };
    const hits = await fixture.calls.search_index("grout");
    expect(Object.fromEntries(hits.map((hit) => [hit.excerpt, hit.sources]))).toEqual({ "Mine: grout colour": [], "From the link: grout guide": ["links"], "Old: grout in the shed": ["*"], "Plain: grout is cheap": [] });

    const hosted = await tools_for(true);
    const found = await hosted.tools.call("search_index", { query: "grout" });
    expect(found.result).toContain("Mine: grout colour");
    expect(found.result).toContain("Plain: grout is cheap");
    expect(found.result).not.toContain("From the link");
    expect(found.result).not.toContain("shed");
    // What was withheld is said for what it was: messages, not items.
    expect(found.result).toContain("[Withheld: 2 messages (1 from sources not recorded (kept before 2026-11-26), 1 from Web links)");
    expect(hosted.context.has_outside_content).toBe(false);

    const local = await tools_for(false);
    expect((await local.tools.call("search_index", { query: "grout" })).result).toContain("From the link");
    // An answer that drew on an untrusted source taints a run that reads it.
    expect(local.context.has_outside_content).toBe(true);
  });

  it("never sends a hosted embedder an answer that drew on an unmarked or unrecorded source", async () => {
    const { calls } = await indexed({ hosted_embedder: true });
    const sent = calls.flat().join(" | ");
    expect(sent).toContain("Mine: grout colour");
    expect(sent).toContain("Plain: grout is cheap");
    expect(sent).not.toContain("From the link");
    expect(sent).not.toContain("shed");
  });
});
