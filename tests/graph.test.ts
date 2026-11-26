import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { engine_tools, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { node_key, parse_node_key } from "../src/shared/graph/model.ts";
import { addresses_in, normal_address, rule_link_id } from "../src/shared/graph/rules.ts";
import { most_similar_per_item, propose_similar, similarity_link_id } from "../src/shared/graph/similarity.ts";
import { suggest_links_message } from "../src/shared/graph/store.ts";
import { changing_calls, offered_api } from "../src/shared/policy/policy.ts";
import { open_screen } from "../src/shared/privacy/screen.ts";
import { after_pass, index_now, open_index, settle_index, sync_documents, use_search_index, type IndexPass } from "../src/shared/search/indexer.ts";
import { search } from "../src/shared/search/search.ts";
import { to_blob, unit } from "../src/shared/search/text.ts";
import { after_index_change, page_only, sync_engine } from "../src/shared/store.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
  use_search_index(null);
});

// A garden with a task, a web link whose snippet holds the task's address, and a note.
function garden_of(fixture: Fixture) {
  const garden = fixture.calls.add_context("Garden");
  const seeds = fixture.calls.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" });
  const shop = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop", uri: "https://example.org/seeds", snippet: "For x-tasks://task/t1." });
  return { garden, seeds, shop };
}

// The tools a run gets, with the screen for a hosted or local engine, as an engine named "fake" answering with "fake-model".
async function tools_of(fixture: Fixture, hosted = false): Promise<{ context: ToolContext; tools: ReturnType<typeof engine_tools> }> {
  add_conversation_record(fixture.database, null, "general");
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id: "general",
    presence: "conversation",
    has_outside_content: false,
    screen: await open_screen(fixture.database, hosted),
    maker: { engine: "fake", model: "fake-model" },
  };
  return { context, tools: engine_tools(context) };
}

function index_of(fixture: Fixture): DatabaseSync {
  const index = new DatabaseSync(":memory:");
  open_index(index);
  use_search_index({ database: () => fixture.database, index: () => index });
  return index;
}

// Brings the index in step and runs what follows a pass, as the indexer does.
async function index_pass(fixture: Fixture, index: DatabaseSync, extra: Partial<IndexPass> = {}): Promise<boolean> {
  const synced = await sync_documents(fixture.database, index);
  return after_pass(fixture.database, index, { written: synced.written_keys, all: synced.was_empty, embedded: [], embedder: null, ...extra });
}

describe("links and entities the user makes", () => {
  it("are accepted at once, change, close and go", () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const link = fixture.calls.add_graph_link(seeds, shop, "depends_on", "needs", "2026-11-01");
    expect(fixture.calls.get_node_links(seeds).links).toMatchObject([{ id: link, type: "depends_on", label: "needs", status: "accepted", made_by: "user", direction: "out", valid_from: "2026-11-01T00:00:00.000Z", other: { key: node_key("item", shop), label: "Seed shop" } }]);
    expect(() => fixture.calls.add_graph_link(seeds, shop, "depends_on")).toThrow("already linked");
    expect(() => fixture.calls.add_graph_link(seeds, seeds, "related_to")).toThrow("two different nodes");
    expect(() => fixture.calls.add_graph_link(seeds, "nowhere", "related_to")).toThrow("There is no context, item or entity nowhere.");
    expect(() => fixture.calls.add_graph_link(seeds, shop, "likes" as never)).toThrow("A link's type is one of");
    expect(() => fixture.calls.add_graph_link(seeds, garden, "same_as")).toThrow("same_as joins two entities");

    fixture.calls.change_graph_link(link, { type: "about", label: "", valid_until: "2026-12-01" });
    expect(fixture.calls.get_node_links(seeds).links[0]).toMatchObject({ type: "about", label: "", valid_until: "2026-12-01T00:00:00.000Z" });
    expect(() => fixture.calls.change_graph_link(link, { valid_until: "2026-10-01" })).toThrow("before it became true");
    expect(() => fixture.calls.change_graph_link(link, { valid_from: "soon" })).toThrow("is a date or moment");
    expect(() => fixture.calls.change_graph_link(link, { type: "same_as" })).toThrow("same_as joins two entities");
    fixture.calls.change_graph_link(link, {});
    fixture.calls.change_graph_link(link, { valid_until: "" });
    fixture.calls.close_graph_link(link);
    expect(fixture.calls.get_node_links(seeds).links[0]!.valid_until).not.toBe("");
    expect(() => fixture.calls.close_graph_link(link)).toThrow("already closed");
    // A closed link stays known, but is not drawn unless asked for.
    expect(fixture.calls.get_graph(garden).links).toHaveLength(0);
    expect(fixture.calls.get_graph(garden, { include_closed: true }).links).toHaveLength(1);

    fixture.calls.remove_graph_link(link);
    expect(fixture.calls.get_node_links(seeds).links).toEqual([]);
    expect(() => fixture.calls.remove_graph_link(link)).toThrow(`There is no link ${link}.`);
  });

  it("add, rename and remove entities, taking their links along", () => {
    const fixture = start_fixture();
    const { seeds } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", " Ada  Lovelace ", ["Ada", "ada lovelace", ""]);
    expect(() => fixture.calls.add_entity("person", "ada lovelace")).toThrow("There is already a person named ada lovelace");
    expect(() => fixture.calls.add_entity("robot" as never, "R2")).toThrow("An entity is one of person, organisation, topic, place, other.");
    expect(() => fixture.calls.add_entity("person", "  ")).toThrow("Give the entity a name.");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    expect(fixture.calls.get_node_links(ada).node).toMatchObject({ key: `entity:${ada}`, kind: "entity", type: "person", label: "Ada Lovelace", alt_names: ["Ada"], status: "accepted", link_count: 1 });

    fixture.calls.rename_entity(ada, "Augusta Ada King", ["Ada Lovelace"], "person");
    fixture.calls.rename_entity(ada, "Augusta Ada King");
    expect(fixture.calls.get_node_links(ada).node).toMatchObject({ label: "Augusta Ada King", alt_names: ["Ada Lovelace"] });
    expect(() => fixture.calls.rename_entity("nobody", "X")).toThrow("There is no entity nobody.");

    fixture.calls.remove_entity(ada);
    expect(fixture.calls.get_node_links(seeds).links).toEqual([]);
    expect(() => fixture.calls.remove_entity(ada)).toThrow(`There is no entity ${ada}.`);
  });

  it("join two entities found to be one without merging them, read as one until the join is undone", () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const first = fixture.calls.add_entity("organisation", "Seed Co");
    const second = fixture.calls.add_entity("organisation", "The Seed Company", ["SeedCo"]);
    fixture.calls.add_graph_link(seeds, `entity:${first}`, "mentions");
    fixture.calls.add_graph_link(shop, `entity:${second}`, "about");
    const join = fixture.calls.join_entities(second, first);
    expect(() => fixture.calls.join_entities(first, second)).toThrow("two different nodes");

    // The one made first stands for both, with the other's names and links.
    const joined = fixture.calls.get_node_links(second);
    expect(joined.node).toMatchObject({ key: `entity:${first}`, label: "Seed Co", alt_names: ["The Seed Company", "SeedCo"], joined: [{ id: second, name: "The Seed Company", link_id: join }] });
    expect(joined.links.map((link) => link.other.label).sort()).toEqual(["Order seeds", "Seed shop"]);
    const whole = fixture.calls.get_graph(null, { node_types: ["entity"] });
    expect(whole.nodes.map((node) => node.label)).toEqual(["Seed Co"]);

    fixture.calls.remove_graph_link(join);
    expect(fixture.calls.get_graph(null, { node_types: ["entity"] }).nodes.map((node) => node.label).sort()).toEqual(["Seed Co", "The Seed Company"]);
    expect(fixture.calls.get_node_links(first).node.joined).toEqual([]);
  });
});

describe("the graph as drawn", () => {
  it("holds a context, the contexts inside it, their items and the entities linked to them, with where each sits", () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const beds = fixture.calls.add_context("Beds", garden);
    const soil = fixture.calls.add_item([beds], "links", { source_id: "https://example.org/soil", kind: "link", title: "Soil" });
    const kitchen = fixture.calls.add_context("Kitchen");
    const tiles = fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    const ada = fixture.calls.add_entity("person", "Ada");
    const bob = fixture.calls.add_entity("person", "Bob");
    fixture.calls.add_entity("topic", "Unlinked");
    fixture.calls.add_graph_link(soil, `entity:${ada}`, "mentions");
    fixture.calls.add_graph_link(`entity:${ada}`, `entity:${bob}`, "related_to");
    fixture.calls.add_graph_link(seeds, tiles, "related_to");
    fixture.calls.add_graph_link(seeds, `entity:${bob}`, "mentions");

    // Entities linked to what the garden holds, and the links among them; the kitchen's tiles stay out.
    const view = fixture.calls.get_graph(garden);
    expect(view.nodes.map((node) => node.label)).toEqual(["Garden", "Beds", "Order seeds", "Soil", "Seed shop", "Ada", "Bob"]);
    expect(view.structure).toEqual(expect.arrayContaining([{ from: `context:${garden}`, to: `context:${beds}` }, { from: `context:${beds}`, to: `item:${soil}` }, { from: `context:${garden}`, to: `item:${seeds}` }]));
    expect(view.links.map((link) => [link.from, link.to])).toEqual(expect.arrayContaining([[`item:${soil}`, `entity:${ada}`], [`entity:${ada}`, `entity:${bob}`], [`item:${seeds}`, `entity:${bob}`]]));
    expect(view.links).toHaveLength(3);
    expect(view.nodes.find((node) => node.label === "Ada")!.link_count).toBe(2);
    expect(view.nodes.find((node) => node.label === "Garden")).toMatchObject({ kind: "context", uri: `codex://context/${garden}` });
    expect(view.nodes.find((node) => node.label === "Order seeds")).toMatchObject({ kind: "item", type: "task", uri: "x-tasks://task/t1", sources: ["x-tasks"] });

    const whole = fixture.calls.get_graph();
    expect(whole.nodes.map((node) => node.label).sort()).toEqual(["Ada", "Beds", "Bob", "Garden", "Kitchen", "Order seeds", "Seed shop", "Soil", "Tiles", "Unlinked"]);
    expect(whole.links).toHaveLength(4);
    expect(() => fixture.calls.get_graph("nowhere")).toThrow("There is no context nowhere.");
    expect(shop).toBeTruthy();
  });

  it("filters by kind of node, type and status of link, and caps the nodes with how many more there are", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", "Ada");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    const { tools } = await tools_of(fixture);
    await tools.call("propose_link", { from: seeds, to: shop, type: "depends_on" });

    expect(fixture.calls.get_graph(garden, { link_types: ["mentions"] }).links.map((link) => link.type)).toEqual(["mentions"]);
    expect(fixture.calls.get_graph(garden, { statuses: ["proposed"] }).links.map((link) => link.type)).toEqual(["depends_on"]);
    expect(fixture.calls.get_graph(garden, { node_types: ["task", "person"] }).nodes.map((node) => node.label)).toEqual(["Order seeds", "Ada"]);
    const capped = fixture.calls.get_graph(garden, { limit: 2 });
    expect(capped.nodes.map((node) => node.label)).toEqual(["Garden", "Order seeds"]);
    expect([capped.hidden_nodes, capped.hidden_links]).toEqual([2, 2]);
    expect(capped.structure).toEqual([{ from: `context:${garden}`, to: `item:${seeds}` }]);
    expect(fixture.calls.list_link_counts(garden)).toEqual({ [`context:${garden}`]: 0, [`item:${seeds}`]: 2, [`item:${shop}`]: 1 });
  });

  it("never keeps a link to nothing: a removed context or deleted conversation takes its links, an item in no context keeps them", () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    const talk = add_conversation_record(fixture.database, kitchen);
    fixture.calls.add_graph_link(`item:conversation:${talk}`, seeds, "about");
    fixture.calls.add_graph_link(kitchen, seeds, "related_to");
    fixture.calls.add_graph_link(shop, seeds, "related_to");
    expect(fixture.calls.get_node_links(seeds).links).toHaveLength(3);

    fixture.calls.delete_conversation(talk);
    expect(fixture.calls.get_node_links(seeds).links.map((link) => link.other.label).sort()).toEqual(["Kitchen", "Seed shop"]);
    fixture.calls.remove_context(kitchen);
    expect(fixture.calls.get_node_links(seeds).links.map((link) => link.other.label)).toEqual(["Seed shop"]);
    fixture.calls.remove_item(garden, shop);
    expect(fixture.calls.get_node_links(seeds).links.map((link) => link.other.label)).toEqual(["Seed shop"]);
    expect(fixture.calls.get_graph(garden).links).toEqual([]);
    fixture.calls.add_item_to_contexts(shop, [garden]);
    expect(fixture.calls.get_graph(garden).links).toHaveLength(1);
  });
});

describe("proposals", () => {
  it("are made by an engine's two tools without approval, outside the action policy, and wait for the user", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const { tools } = await tools_of(fixture);
    expect(changing_calls()).not.toContain("propose_link");
    expect(changing_calls()).not.toContain("propose_entity");
    expect(Object.keys(offered_api)).toEqual(expect.arrayContaining(["get_node_links", "propose_entity", "propose_link"]));

    const entity = JSON.parse((await tools.call("propose_entity", { kind: "organisation", name: "Seed Co", evidence: { item_id: shop, excerpt: "Seeds   from Seed Co" } })).result) as { outcome: string; id: string };
    expect(entity.outcome).toBe("proposed");
    const link = JSON.parse((await tools.call("propose_link", { from: shop, to: entity.id, type: "about", label: "sold by" })).result) as { outcome: string; id: string };
    expect(link.outcome).toBe("proposed");
    expect(fixture.calls.list_proposals()).toEqual([]);

    const waiting = fixture.calls.list_graph_proposals(garden);
    expect(waiting.entities).toMatchObject([{ id: entity.id, name: "Seed Co", status: "proposed", made_by: "engine", engine: "fake", model: "fake-model", evidence: { ref: `item:${shop}`, label: "Seed shop" }, sources: ["links"] }]);
    // A local engine's evidence keeps its excerpt only when the source may leave this computer, which links may not yet.
    expect(waiting.entities[0]!.evidence.excerpt).toBe("");
    expect(waiting.links).toMatchObject([{ id: link.id, type: "about", label: "sold by", made_by: "engine", from_node: { label: "Seed shop" }, to_node: { label: "Seed Co", status: "proposed" } }]);
    expect(fixture.calls.list_graph_proposals().links).toHaveLength(1);
    expect(fixture.calls.get_graph(garden).links.map((each) => each.status)).toEqual(["proposed"]);

    // The same again is given back, and an entity of the same name is the one already known, never a second.
    expect(JSON.parse((await tools.call("propose_entity", { kind: "organisation", name: "seed co" })).result)).toMatchObject({ outcome: "exists", id: entity.id });
    expect(JSON.parse((await tools.call("propose_link", { from: shop, to: `entity:${entity.id}`, type: "about" })).result)).toMatchObject({ outcome: "exists", id: link.id });
    expect((await tools.call("propose_link", { from: seeds, to: "nowhere", type: "about" })).result).toContain("There is no context, item or entity nowhere.");
    expect((await tools.call("propose_entity", { kind: "person", name: "X", evidence: { item_id: "nothing" } })).result).toContain("There is no item nothing");
    expect((await tools.call("propose_entity", { kind: "person", name: "X", evidence: { message_id: "nothing" } })).result).toContain("There is no message nothing");
  });

  it("keep an excerpt only when its source is marked to leave this computer, and carry what the run read", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    fixture.calls.set_source_mark("codex.links", "send_to_hosted", true);
    const { tools } = await tools_of(fixture);
    const answer = add_message(fixture.database, { conversation_id: "general", role: "assistant", text: "Seeds are sold by Seed Co.", sources: ["x-tasks"] });
    const mine = add_message(fixture.database, { conversation_id: "general", role: "user", text: "Ada ordered them.", sources: [] });
    await tools.call("get_item", { id: seeds });

    const marked = JSON.parse((await tools.call("propose_entity", { kind: "organisation", name: "Seed Co", evidence: { item_id: shop, excerpt: "Seeds from Seed Co" } })).result) as { id: string };
    const from_answer = JSON.parse((await tools.call("propose_entity", { kind: "topic", name: "Seeds", evidence: { message_id: answer.id, excerpt: "sold by Seed Co" } })).result) as { id: string };
    const from_user = JSON.parse((await tools.call("propose_entity", { kind: "person", name: "Ada", evidence: { message_id: mine.id, excerpt: "Ada ordered them." } })).result) as { id: string };
    const entities = new Map(fixture.calls.list_graph_proposals().entities.map((each) => [each.id, each]));
    expect(entities.get(marked.id)).toMatchObject({ evidence: { excerpt: "Seeds from Seed Co" }, sources: ["links", "x-tasks"] });
    expect(entities.get(from_answer.id)).toMatchObject({ evidence: { ref: `message:${answer.id}`, excerpt: "", label: "An answer of the assistant" } });
    expect(entities.get(from_user.id)).toMatchObject({ evidence: { excerpt: "Ada ordered them.", label: "Your message" } });
  });

  it("are accepted or rejected by the user alone, a rejection remembered so it is never proposed again", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const { tools } = await tools_of(fixture);
    const entity = JSON.parse((await tools.call("propose_entity", { kind: "person", name: "Ada" })).result) as { id: string };
    const mentions = JSON.parse((await tools.call("propose_link", { from: seeds, to: `entity:${entity.id}`, type: "mentions" })).result) as { id: string };
    const related = JSON.parse((await tools.call("propose_link", { from: seeds, to: shop, type: "related_to" })).result) as { id: string };
    const other = JSON.parse((await tools.call("propose_entity", { kind: "person", name: "Bob" })).result) as { id: string };
    const about = JSON.parse((await tools.call("propose_link", { from: shop, to: `entity:${other.id}`, type: "about" })).result) as { id: string };

    expect(fixture.calls.accept_graph_proposals([mentions.id, "nothing"])).toEqual({ accepted: 1, rejected: 0, skipped: ["nothing"] });
    // Accepting a link accepts the entity it was proposed with.
    expect(fixture.calls.get_node_links(entity.id).node.status).toBe("accepted");
    expect(fixture.calls.reject_graph_proposals([related.id, mentions.id])).toEqual({ accepted: 0, rejected: 1, skipped: [mentions.id] });
    // A rejected entity takes the links proposed to it along.
    expect(fixture.calls.reject_graph_proposals([other.id])).toEqual({ accepted: 0, rejected: 2, skipped: [] });
    expect(fixture.calls.get_node_links(shop).links.find((link) => link.id === about.id)!.status).toBe("rejected");
    expect(() => fixture.calls.accept_graph_proposals([])).toThrow("Pick at least one proposal.");

    expect(JSON.parse((await tools.call("propose_link", { from: shop, to: seeds, type: "related_to" })).result)).toMatchObject({ outcome: "refused" });
    expect(JSON.parse((await tools.call("propose_entity", { kind: "person", name: "bob" })).result)).toMatchObject({ outcome: "refused" });
    expect(JSON.parse((await tools.call("propose_link", { from: seeds, to: other.id, type: "about" })).result)).toMatchObject({ outcome: "refused" });
    expect(fixture.calls.list_graph_proposals()).toEqual({ links: [], entities: [] });
    // Rejected links are kept, and drawn only when asked for.
    expect(fixture.calls.get_graph(null, { statuses: ["rejected"] }).links.map((link) => link.id).sort()).toEqual([about.id, related.id].sort());

    expect(fixture.calls.list_graph_decision_counts()).toEqual([{ made_by: "engine", rule: "", engine: "fake", model: "fake-model", accepted: 2, rejected: 3 }]);
    // The user may still make a link they rejected, which accepts it.
    expect(fixture.calls.add_graph_link(seeds, shop, "related_to")).toBe(related.id);
  });

  it("are accepted and rejected only at the page: never by a token, MCP or an engine", () => {
    for (const method of ["accept_graph_proposals", "reject_graph_proposals"]) {
      expect(page_only.is_page_only(method)).toBe(true);
      expect(Object.keys(offered_api)).not.toContain(method);
    }
    expect(page_only.is_page_only("propose_link")).toBe(false);
  });

  it("on removing an engine's link are kept as rejected, so a rule or engine never makes it again", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const { tools } = await tools_of(fixture);
    const link = JSON.parse((await tools.call("propose_link", { from: seeds, to: shop, type: "about" })).result) as { id: string };
    fixture.calls.accept_graph_proposals([link.id]);
    fixture.calls.remove_graph_link(link.id);
    fixture.calls.remove_graph_link(link.id);
    expect(fixture.calls.get_node_links(seeds).links).toMatchObject([{ id: link.id, status: "rejected" }]);
    expect(fixture.calls.list_graph_decision_counts()).toMatchObject([{ accepted: 1, rejected: 1 }]);
  });

  it("start from Suggest links, an ordinary conversation in the context asking the engine to propose", async () => {
    const fixture = start_fixture();
    const { garden } = garden_of(fixture);
    const started = await fixture.calls.suggest_links(garden);
    await wait_for_runs();
    const conversation = fixture.calls.get_conversation(started.conversation_id);
    expect(conversation.contexts.map((each) => each.id)).toEqual([garden]);
    expect(conversation.messages[0]).toMatchObject({ role: "user", text: suggest_links_message });
    const names = fixture.requests[0]!.tools.definitions.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["get_node_links", "propose_entity", "propose_link"]));
    expect(fixture.requests[0]!.instructions).toContain("propose_link only propose");
  });

  it("from a hosted engine's run, see a node's links screened by source", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", "Ada");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    fixture.calls.add_graph_link(shop, `entity:${ada}`, "mentions");
    fixture.calls.add_graph_link(garden, `entity:${ada}`, "about");
    fixture.calls.set_source_mark("codex.x-tasks", "send_to_hosted", true);
    const { context, tools } = await tools_of(fixture, true);

    const read = await tools.call("get_node_links", { node: `entity:${ada}` });
    expect(read.result).toContain("Order seeds");
    expect(read.result).toContain("Garden");
    expect(read.result).not.toContain("Seed shop");
    expect(read.result).toContain("[Withheld: 1 link (1 from Web links)");
    expect(context.has_outside_content).toBe(true);
    const withheld = await tools.call("get_node_links", { node: shop });
    expect(withheld.result).toContain('"withheld":true');
    expect(withheld.result).not.toContain("Seed shop");
  });
});

describe("rules on exact keys", () => {
  it("link an item whose text holds another's address or an app link, and a task to its parent, accepted", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const sow = fixture.calls.add_item([garden], "x-tasks", { source_id: "t2", kind: "task", title: "Sow", uri: "x-tasks://task/t2", detail: { parent: "t1" } });
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_context_notes(kitchen, `See codex://context/${garden}. And x-tasks://task/t2, then codex://conversation/none.`);
    const index = index_of(fixture);
    expect(await index_pass(fixture, index)).toBe(true);

    const links = fixture.calls.get_graph().links.map((link) => [link.from, link.to, link.type, link.label, link.made_by, link.rule, link.status]);
    expect(links).toEqual(
      expect.arrayContaining([
        [`item:${shop}`, `item:${seeds}`, "related_to", "links to", "rule", "links_to", "accepted"],
        [`item:${sow}`, `item:${seeds}`, "part_of", "", "rule", "parent", "accepted"],
        [`context:${kitchen}`, `context:${garden}`, "related_to", "links to", "rule", "app_link", "accepted"],
        [`context:${kitchen}`, `item:${sow}`, "related_to", "links to", "rule", "links_to", "accepted"],
      ]),
    );
    expect(links).toHaveLength(4);
    expect(fixture.calls.get_node_links(shop).links[0]!.id).toBe(rule_link_id("links_to", `item:${shop}`, `item:${seeds}`));
    // Nothing changed, so nothing is made again.
    expect(await index_pass(fixture, index)).toBe(false);
  });

  it("run again only for what changed, closing a link no longer found and opening it when it comes back", async () => {
    const fixture = start_fixture();
    const { garden, seeds } = garden_of(fixture);
    const index = index_of(fixture);
    await index_pass(fixture, index);
    const note = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/plan", kind: "link", title: "Plan", snippet: "Start with x-tasks://task/t1." });
    expect(await index_pass(fixture, index)).toBe(true);
    const id = rule_link_id("links_to", `item:${note}`, `item:${seeds}`);
    expect(fixture.calls.get_node_links(note).links.map((link) => link.id)).toEqual([id]);

    fixture.calls.add_item([garden], "links", { source_id: "https://example.org/plan", kind: "link", title: "Plan", snippet: "Nothing linked." });
    expect(await index_pass(fixture, index)).toBe(true);
    expect(fixture.calls.get_node_links(note).links[0]!.valid_until).not.toBe("");
    fixture.calls.add_item([garden], "links", { source_id: "https://example.org/plan", kind: "link", title: "Plan", snippet: "Back to x-tasks://task/t1!" });
    await index_pass(fixture, index);
    expect(fixture.calls.get_node_links(note).links[0]).toMatchObject({ id, valid_until: "" });

    // A new item an older one already pointed at is found from the other side.
    fixture.calls.add_item([garden], "links", { source_id: "https://example.org/old", kind: "link", title: "Old", snippet: "see https://example.org/later." });
    await index_pass(fixture, index);
    const later = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/later", kind: "link", title: "Later", uri: "https://example.org/later" });
    await index_pass(fixture, index);
    expect(fixture.calls.get_node_links(later).links.map((link) => link.other.label)).toEqual(["Old"]);
    // A parent added after its child is found from the child.
    const child = fixture.calls.add_item([garden], "x-tasks", { source_id: "t9", kind: "task", title: "Child", detail: { parent: "t8" } });
    await index_pass(fixture, index);
    const parent = fixture.calls.add_item([garden], "x-tasks", { source_id: "t8", kind: "task", title: "Parent" });
    await index_pass(fixture, index);
    expect(fixture.calls.get_node_links(child).links.map((link) => [link.type, link.other.id])).toEqual([["part_of", parent]]);
  });

  it("leave alone a link the user rejected, or one someone else already made", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    fixture.calls.add_graph_link(shop, seeds, "related_to", "for");
    const index = index_of(fixture);
    await index_pass(fixture, index);
    expect(fixture.calls.get_node_links(shop).links.map((link) => link.made_by)).toEqual(["user"]);
  });

  it("run in the index's own passes, which record History and tell the pages when they made links", async () => {
    const fixture = start_fixture();
    const { shop } = garden_of(fixture);
    const index = new DatabaseSync(":memory:");
    open_index(index);
    let told = 0;
    use_search_index({ database: () => fixture.database, index: () => index, on_change: () => (after_index_change(fixture.database), (told += 1)) });
    await index_now();
    await settle_index();
    expect(told).toBe(1);
    const [link] = fixture.calls.get_node_links(shop).links;
    expect(fixture.calls.list_item_history("link", link!.id).map((version) => version.change)).toEqual(["created"]);
    expect(fixture.announced()).toBeGreaterThan(0);
  });

  it("read addresses out of text, without trailing punctuation", () => {
    expect(addresses_in("See https://example.org/a, and (mid:abc@example.org). Or x-tasks://task/t1! a:b")).toEqual(["https://example.org/a", "mid:abc@example.org", "x-tasks://task/t1"]);
    expect(normal_address("https://example.org/")).toBe("https://example.org");
  });
});

describe("similarity", () => {
  // Gives each item in the index a vector, as an embedder would.
  function embed(index: DatabaseSync, vectors: Record<string, number[]>): void {
    const insert = index.prepare("INSERT OR REPLACE INTO vectors (key, seq, embedder, model, vector) VALUES (?, 0, 'fake', 'm1', ?)");
    for (const [id, vector] of Object.entries(vectors)) insert.run(`item:${id}`, to_blob(unit(vector)));
  }

  it("proposes an item's nearest above the threshold, a few per item, never twice or between items already linked", async () => {
    const fixture = start_fixture();
    const garden = fixture.calls.add_context("Garden");
    const ids = ["a", "b", "c", "d", "e", "f"].map((name) => fixture.calls.add_item([garden], "links", { source_id: `https://example.org/${name}`, kind: "link", title: name.toUpperCase() }));
    const [a, b, c, d, e, f] = ids as [string, string, string, string, string, string];
    fixture.calls.add_graph_link(a, f, "about");
    const index = index_of(fixture);
    await index_pass(fixture, index);
    embed(index, { [a]: [1, 0, 0], [b]: [0.98, 0.2, 0], [c]: [0.95, 0.3, 0], [d]: [0.9, 0.4, 0.1], [e]: [0.92, 0.35, 0.05], [f]: [1, 0.01, 0] });
    embed(index, {});
    const pass = { written: [], all: false, embedded: [`item:${a}`], embedder: { id: "fake", model: "m1" } };
    expect(propose_similar(fixture.database, index, pass)).toBe(true);

    const proposed = fixture.calls.list_graph_proposals().links;
    expect(proposed).toHaveLength(most_similar_per_item);
    expect(proposed.map((link) => [link.made_by, link.engine, link.model, link.type, link.label])).toEqual(Array.from({ length: 3 }, () => ["similarity", "fake", "m1", "related_to", "similar"]));
    expect(proposed.map((link) => (link.from === `item:${a}` ? link.to : link.from)).sort()).toEqual([`item:${b}`, `item:${c}`, `item:${e}`].sort());
    expect(proposed[0]!.id).toBe(similarity_link_id(proposed[0]!.from, proposed[0]!.to));
    expect(propose_similar(fixture.database, index, pass)).toBe(false);

    fixture.calls.reject_graph_proposals([similarity_link_id(`item:${a}`, `item:${b}`)]);
    expect(propose_similar(fixture.database, index, pass)).toBe(true);
    expect(fixture.calls.list_graph_proposals().links.some((link) => link.id === similarity_link_id(`item:${a}`, `item:${b}`))).toBe(false);
    expect(fixture.calls.list_graph_proposals().links.some((link) => link.id === similarity_link_id(`item:${a}`, `item:${d}`))).toBe(true);
    expect(propose_similar(fixture.database, index, { ...pass, embedder: null })).toBe(false);
    expect(propose_similar(fixture.database, index, { ...pass, embedded: [] })).toBe(false);
  });
});

describe("the search index", () => {
  it("holds entities by their names, placed in the contexts they are linked to", async () => {
    const fixture = start_fixture();
    const { garden, seeds } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", "Ada Lovelace", ["Countess"]);
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    const index = index_of(fixture);
    await index_pass(fixture, index);
    const hits = await search(fixture.database, index, "countess");
    expect(hits).toMatchObject([{ kind: "entity", id: ada, title: "Ada Lovelace", item_kind: "person", where: [{ id: garden, name: "Garden" }], sources: [] }]);
    expect(await search(fixture.database, index, "countess", garden)).toHaveLength(1);
  });
});

describe("sync between devices", () => {
  function push(from: Fixture, to: Fixture): void {
    const outgoing = sync_engine.collect_unpushed_changes(from.database);
    sync_engine.write_state(from.database, { pushed_seq: outgoing.up_to_seq });
    sync_engine.apply_changes(to.database, outgoing.changes);
  }

  it("carries entities, links and decisions, and a rule's link made on both devices is one link", async () => {
    const laptop = start_fixture();
    const { garden, seeds, shop } = garden_of(laptop);
    const ada = laptop.calls.add_entity("person", "Ada");
    laptop.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    const server = start_fixture();
    push(laptop, server);

    for (const fixture of [laptop, server]) await index_pass(fixture, index_of(fixture));
    push(server, laptop);
    push(laptop, server);
    for (const fixture of [laptop, server]) {
      const view = fixture.calls.get_graph(garden);
      expect(view.links.map((link) => link.made_by).sort()).toEqual(["rule", "user"]);
      expect(view.nodes.map((node) => node.label)).toContain("Ada");
    }
    expect(shop).toBeTruthy();
  });
});

describe("History", () => {
  it("keeps an entity with its links, so a removed one comes back with them", () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", "Ada");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    fixture.calls.rename_entity(ada, "Ada L");
    const versions = fixture.calls.list_item_history("entity", ada);
    expect(versions.map((version) => [version.change, version.item_name, version.kind_label])).toEqual([
      ["edited", "Ada L", "Entity"],
      ["edited", "Ada", "Entity"],
      ["created", "Ada", "Entity"],
    ]);
    expect(versions[0]!.summary).toBe("person, 1 link");

    fixture.calls.remove_entity(ada);
    const deleted = fixture.calls.list_recent_changes(10).find((change) => change.kind === "entity")!;
    expect(deleted).toMatchObject({ change: "deleted", item_name: "Ada L" });
    fixture.calls.restore_item_version("entity", deleted.id);
    expect(fixture.calls.get_node_links(ada).links.map((link) => link.other.label)).toEqual(["Order seeds"]);
    expect(shop).toBeTruthy();
  });

  it("keeps each link, which comes back only while both its ends exist", () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const link = fixture.calls.add_graph_link(seeds, shop, "depends_on", "needs");
    fixture.calls.remove_graph_link(link);
    const [removed] = fixture.calls.list_item_history("link", link);
    expect(removed).toMatchObject({ change: "deleted", item_name: "Order seeds → Seed shop", summary: "depends on (needs), accepted" });
    fixture.calls.restore_item_version("link", removed!.id);
    expect(fixture.calls.get_node_links(seeds).links.map((each) => each.id)).toEqual([link]);

    const kitchen = fixture.calls.add_context("Kitchen");
    const other = fixture.calls.add_graph_link(kitchen, seeds, "related_to");
    fixture.calls.remove_context(kitchen);
    const [gone] = fixture.calls.list_item_history("link", other);
    expect(gone!.change).toBe("deleted");
    expect(() => fixture.calls.restore_item_version("link", gone!.id)).toThrow("One end of this link no longer exists");
    expect(garden).toBeTruthy();
  });
});

describe("node keys", () => {
  it("name a context, item or entity, and nothing else", () => {
    expect(parse_node_key("item:x-tasks:t1")).toEqual({ kind: "item", id: "x-tasks:t1" });
    expect(parse_node_key("thing:1")).toBeNull();
  });
});
