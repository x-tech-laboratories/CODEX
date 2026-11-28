import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import type { ToolCallRecord } from "../src/shared/conversations/model.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { engine_tools, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { run_direct, type ChatModel } from "../src/shared/engines/direct.ts";
import { node_key, parse_node_key } from "../src/shared/graph/model.ts";
import { addresses_in, normal_address, rule_link_id, run_rules } from "../src/shared/graph/rules.ts";
import { most_similar_per_item, propose_similar, similarity_link_id, standing_out } from "../src/shared/graph/similarity.ts";
import { proposals_note, suggest_links_message, suggest_rounds, suggest_tools } from "../src/shared/graph/store.ts";
import { approval_only_calls, brings_outside_content, changing_calls, core_tools, offered_api, proposable_spec, proposing_calls } from "../src/shared/policy/policy.ts";
import { open_screen } from "../src/shared/privacy/screen.ts";
import { count_changed, open_index, sync_documents, use_search_index, type IndexPass } from "../src/shared/search/indexer.ts";
import { run_maintenance_job } from "../src/shared/maintenance/loop.ts";
import { search } from "../src/shared/search/search.ts";
import { to_blob, unit } from "../src/shared/search/text.ts";
import { after_index_change, bind_methods, page_only, sync_engine } from "../src/shared/store.ts";
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

// Brings the index in step and runs the rules and similarity on what it wrote, as the maintenance jobs do.
async function index_pass(fixture: Fixture, index: DatabaseSync, extra: Partial<IndexPass> = {}): Promise<boolean> {
  const synced = await sync_documents(fixture.database, index);
  const pass = { written: synced.written_keys, all: synced.was_empty, embedded: [], embedder: null, ...extra };
  const by_rules = run_rules(fixture.database, index, pass);
  const by_similarity = propose_similar(fixture.database, index, pass);
  return by_rules || by_similarity;
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

describe("links and entities a program makes", () => {
  it("are proposed, made by a program, through a token or MCP; the page's stay the user's, accepted at once", async () => {
    const fixture = start_fixture();
    const { garden, seeds } = garden_of(fixture);
    const program = bind_methods(() => fixture.database, () => undefined, "program");

    const entity = program.add_entity("person", "Alex Gardener");
    const link = program.add_graph_link(node_key("item", seeds), node_key("entity", entity), "mentions");
    const proposals = fixture.calls.list_graph_proposals();
    expect(proposals.entities.map((each) => [each.id, each.status, each.made_by])).toEqual([[entity, "proposed", "program"]]);
    expect(proposals.links.map((each) => [each.id, each.status, each.made_by])).toEqual([[link, "proposed", "program"]]);
    // Asked again, the same proposal is given back rather than a second one.
    expect(program.add_entity("person", "Alex Gardener")).toBe(entity);
    expect(program.add_graph_link(node_key("item", seeds), node_key("entity", entity), "mentions")).toBe(link);
    // A proposal through MCP, with no engine behind it, is a program's too.
    await program.propose_entity("topic", "Seeds");
    expect(fixture.calls.list_graph_proposals().entities.find((each) => each.name === "Seeds")!.made_by).toBe("program");

    fixture.calls.reject_graph_proposals([link]);
    expect(() => program.add_graph_link(node_key("item", seeds), node_key("entity", entity), "mentions")).toThrow("rejected this link before");
    fixture.calls.reject_graph_proposals([entity]);
    expect(() => program.add_entity("person", "Alex Gardener")).toThrow("rejected the person Alex Gardener before");

    const own = fixture.calls.add_graph_link(node_key("context", garden), node_key("item", seeds), "about");
    expect(fixture.calls.get_node_links(node_key("item", seeds)).links.find((each) => each.id === own)).toMatchObject({ status: "accepted", made_by: "user" });
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
    expect(whole.nodes.map((node) => node.label).sort()).toEqual(["Ada", "Beds", "Bob", "Garden", "Global", "Kitchen", "Order seeds", "Seed shop", "Soil", "Tiles", "Unlinked"]);
    expect(fixture.calls.get_graph("global").nodes.length).toBe(whole.nodes.length);
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
    expect(fixture.calls.list_graph_proposals()).toEqual({ links: [], entities: [], left: 0 });
    // Rejected links are kept, and drawn only when asked for.
    expect(fixture.calls.get_graph(null, { statuses: ["rejected"] }).links.map((link) => link.id).sort()).toEqual([about.id, related.id].sort());

    expect(fixture.calls.list_graph_decision_counts()).toEqual([{ made_by: "engine", rule: "", engine: "fake", model: "fake-model", accepted: 2, rejected: 3 }]);
    // The user may still make a link they rejected, which accepts it.
    expect(fixture.calls.add_graph_link(seeds, shop, "related_to")).toBe(related.id);
  });

  it("are accepted and rejected only at the page: never by a token, MCP or an engine, which may only propose rejecting one", () => {
    for (const method of ["accept_graph_proposals", "reject_graph_proposals"]) expect(page_only.is_page_only(method)).toBe(true);
    expect(Object.keys(offered_api)).not.toContain("accept_graph_proposals");
    expect(approval_only_calls.has("reject_graph_proposals")).toBe(true);
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

  it("start from Suggest links, a conversation in the context with what it needs in its instructions, few tools and few rounds", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const ada = fixture.calls.add_entity("person", "Ada");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
    const started = await fixture.calls.suggest_links(garden);
    await wait_for_runs();
    const conversation = fixture.calls.get_conversation(started.conversation_id);
    expect(conversation.contexts.map((each) => each.id)).toEqual([garden]);
    expect(conversation.title).toBe("Suggest links");
    expect(conversation.messages[0]).toMatchObject({ role: "user", text: suggest_links_message });

    const request = fixture.requests[0]!;
    // Only the proposals and two reads, fully described, with read_tool_result, and fewer rounds than a conversation.
    expect(request.tools.definitions.map((tool) => tool.name).sort()).toEqual([...suggest_tools, "read_tool_result"].sort());
    expect(request.tools.core).toBeUndefined();
    expect(request.limits).toEqual({ max_rounds: suggest_rounds });
    // The items with kind, title and snippet, and the entities and links it has.
    expect(request.instructions).toContain(`[link] Seed shop; id: ${shop}; snippet: For x-tasks://task/t1.`);
    expect(request.instructions).toContain(`[task] Order seeds; id: ${seeds}`);
    expect(request.instructions).toContain(`"Ada" (person, id entity:${ada}, accepted)`);
    expect(request.instructions).toContain(`"Order seeds" (item:${seeds}) mentions "Ada" (entity:${ada}), accepted`);
    expect(suggest_links_message).toContain("at most three items");
    expect(conversation.messages[1]!.notices).toEqual(["Suggest links proposed nothing this time."]);
  });

  it("from Suggest links, cap the entities and links listed, saying how many more there are", async () => {
    const fixture = start_fixture();
    const { garden, seeds } = garden_of(fixture);
    for (let at = 0; at < 40; at += 1) fixture.calls.add_graph_link(seeds, `entity:${fixture.calls.add_entity("topic", `Topic number ${at}`)}`, "about");

    await fixture.calls.suggest_links(garden);
    await wait_for_runs();

    const { instructions } = fixture.requests[0]!;
    // Each listing is capped by its count and its characters, and says how many it left out.
    expect(instructions.match(/\n\d+ more are not listed here\./g)).toHaveLength(2);
    expect(instructions.match(/ about "Topic number/g)!.length).toBeLessThan(40);
  });

  it("from Suggest links, refuse a tool it is not offered and end with how many proposals it made", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const results: string[] = [];
    fixture.set_script(async function* (request) {
      for (const [name, args] of [
        ["get_context", { id: garden }],
        ["get_item", { id: shop }],
        ["propose_entity", { kind: "organisation", name: "Seed Co" }],
        ["propose_link", { from: seeds, to: shop, type: "related_to" }],
        ["propose_link", { from: seeds, to: shop, type: "related_to" }],
      ] as const) {
        yield { type: "tool_call", id: `${name}-${results.length}`, name, arguments: args };
        const outcome = await request.tools.call(name, args);
        results.push(outcome.result);
        yield { type: "tool_result", id: `${name}-${results.length - 1}`, ...outcome };
      }
      yield { type: "done", text: "Proposed Seed Co and a link." };
    });

    const started = await fixture.calls.suggest_links(garden);
    await wait_for_runs();

    expect(results[0]).toBe("There is no tool named get_context.");
    expect(results[1]).toContain("Seed shop");
    expect(fixture.calls.get_conversation(started.conversation_id).messages[1]!.notices).toEqual(["Suggest links proposed 1 entity and 1 link; they wait for you under Proposed links."]);
    expect(proposals_note([])).toBe("Suggest links proposed nothing this time.");
    expect(proposals_note([{ id: "a", name: "propose_link", arguments: {}, result: "not json", is_error: false, outcome: "ran" }])).toBe("Suggest links proposed nothing this time.");
  });

  it("from Suggest links on a small model that keeps reading, stop offering tools after its few rounds so it answers", async () => {
    const fixture = start_fixture();
    const { garden, shop } = garden_of(fixture);
    const offered: number[] = [];
    // A model that reads whenever it is offered a tool, and answers only when it is not.
    const model: ChatModel = {
      complete: async (request) => {
        offered.push(request.tools?.length ?? 0);
        if (request.tools) return { content: "", tool_calls: [{ id: `r${offered.length}`, name: "get_item", arguments: JSON.stringify({ id: shop }) }], finish_reason: "tool_calls" };
        request.on_text?.("Nothing to propose.");
        return { content: "Nothing to propose.", tool_calls: [], finish_reason: "stop" };
      },
    };
    fixture.set_script((request, signal) => run_direct(model, request, signal, { context_size: 8192, max_tokens: 1024, max_rounds: 20 }));

    const started = await fixture.calls.suggest_links(garden);
    await wait_for_runs();

    expect(offered).toEqual([7, 7, 7, 7, 7, 0]);
    const answer = fixture.calls.get_conversation(started.conversation_id).messages[1]!;
    expect(answer).toMatchObject({ text: "Nothing to propose.", error: "" });
    expect(answer.notices).toEqual(["Suggest links proposed nothing this time."]);
  });

  it("from Suggest links with a hosted engine, leave out of its instructions the entities and links of sources not marked for one", async () => {
    const fixture = start_fixture({ hosted: true });
    const { garden, seeds } = garden_of(fixture);
    fixture.calls.set_source_mark("codex.links", "send_to_hosted", true);
    const ada = fixture.calls.add_entity("person", "Ada");
    fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");

    await fixture.calls.suggest_links(garden);
    await wait_for_runs();

    const { instructions } = fixture.requests[0]!;
    expect(instructions).not.toContain("Order seeds");
    expect(instructions).toContain("It has no links yet.");
    expect(instructions).toMatch(/\[Withheld: [^\]]*1 link/);
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

describe("dropping links", () => {
  it("is proposing, offered with the graph's reads, and never closes, removes or rejects a link itself", () => {
    expect(proposing_calls.has("propose_link_drop")).toBe(true);
    expect(changing_calls()).not.toContain("propose_link_drop");
    expect(Object.keys(offered_api)).toEqual(expect.arrayContaining(["get_node_links", "list_graph_proposals", "propose_link_drop", "reject_graph_proposals"]));
    for (const never of ["close_graph_link", "remove_graph_link", "accept_graph_proposals"]) expect(Object.keys(offered_api)).not.toContain(never);
    // Rejecting a proposal is offered only as a proposal, so it has no level to raise.
    expect(changing_calls()).not.toContain("reject_graph_proposals");
    expect(page_only.is_page_only("reject_graph_proposals")).toBe(true);
    expect(Object.keys(core_tools)).toEqual(expect.arrayContaining(["get_node_links", "list_graph_proposals", "propose_link_drop", "reject_graph_proposals"]));
    expect(brings_outside_content("list_graph_proposals")).toBe(true);
    expect(brings_outside_content("get_node_links")).toBe(true);
    expect(proposable_spec("reject_graph_proposals")).toBeDefined();
    expect(page_only.is_page_only("propose_link_drop")).toBe(false);
  });

  it("of an accepted link proposes closing it, whatever the level, and approving closes it as what was once so", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const link = fixture.calls.add_graph_link(seeds, shop, "related_to", "for");
    fixture.calls.set_action_level("close_graph_link", "background");
    const { tools } = await tools_of(fixture);
    const answer = await tools.call("propose_link_drop", { id: link, reason: "The shop sells other seeds.", evidence: { item_id: shop, excerpt: "Tulips only" } });
    const outcome = JSON.parse(answer.result) as { outcome: string; id: string };
    expect(outcome.outcome).toBe("proposed");
    // Nothing changed yet.
    expect(fixture.calls.get_node_links(seeds).links).toMatchObject([{ id: link, valid_until: "" }]);
    const [proposal] = fixture.calls.list_proposals("general");
    expect(proposal).toMatchObject({
      id: outcome.id,
      method: "close_graph_link",
      arguments: { id: link },
      reason: "drop",
      status: "waiting",
      summary: "Close the link “Order seeds related to (for) Seed shop”, keeping it as what was once so: The shop sells other seeds.",
      sources: ["links", "x-tasks"],
      evidence: { proposed_by: { engine: "fake", model: "fake-model" } },
    });
    expect(fixture.calls.list_inbox().find((entry) => entry.id === outcome.id)).toMatchObject({ made_by: "the assistant, fake · fake-model", detail: expect.stringContaining("drop this link") });

    // The same again gives back the one waiting.
    expect(JSON.parse((await tools.call("propose_link_drop", { id: link, reason: "Again." })).result)).toMatchObject({ outcome: "exists", id: outcome.id });
    expect(fixture.calls.list_proposals("general")).toHaveLength(1);

    await fixture.calls.resolve_proposal(outcome.id, "approve");
    const closed = fixture.calls.get_node_links(seeds).links.find((each) => each.id === link)!;
    expect(closed.status).toBe("accepted");
    expect(closed.valid_until).not.toBe("");
    expect((await tools.call("propose_link_drop", { id: link, reason: "Gone." })).result).toContain("That link is already closed.");
  });

  it("of a proposed link proposes rejecting it, and approving rejects it so it is never proposed again", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    fixture.calls.set_source_mark("codex.links", "send_to_hosted", true);
    const { tools } = await tools_of(fixture);
    const link = JSON.parse((await tools.call("propose_link", { from: seeds, to: shop, type: "about" })).result) as { id: string };
    // What waits reads as other apps' text, fenced.
    expect((await tools.call("list_graph_proposals", {})).result).toMatch(new RegExp(`^<untrusted-data[\\s\\S]*${link.id}`));

    const outcome = JSON.parse((await tools.call("propose_link_drop", { id: link.id, reason: "Not about it.", evidence: { item_id: shop, excerpt: "Tulips only" } })).result) as { outcome: string; id: string };
    expect(outcome.outcome).toBe("proposed");
    expect(fixture.calls.list_proposals("general")).toMatchObject([{ method: "reject_graph_proposals", arguments: { ids: [link.id] }, summary: "Reject the proposed link “Order seeds about Seed shop”, so it is never proposed again: Not about it. From: “Tulips only”" }]);
    expect(fixture.calls.list_graph_proposals().links.map((each) => each.id)).toEqual([link.id]);

    await fixture.calls.resolve_proposal(outcome.id, "approve");
    expect(fixture.calls.list_proposals("general")[0]!.status).toBe("approved");
    expect(fixture.calls.get_node_links(seeds).links).toMatchObject([{ id: link.id, status: "rejected" }]);
    expect(JSON.parse((await tools.call("propose_link", { from: seeds, to: shop, type: "about" })).result)).toMatchObject({ outcome: "refused" });
    expect((await tools.call("propose_link_drop", { id: link.id, reason: "Again." })).result).toContain("already rejected");
  });

  it("lets an engine go through the proposals one at a time and propose rejecting one, which waits for the user whatever the level", async () => {
    const fixture = start_fixture();
    const { garden, seeds, shop } = garden_of(fixture);
    const { tools } = await tools_of(fixture);
    const first = JSON.parse((await tools.call("propose_link", { from: seeds, to: shop, type: "about" })).result) as { id: string };
    const second = JSON.parse((await tools.call("propose_link", { from: shop, to: garden, type: "part_of" })).result) as { id: string };
    const third = JSON.parse((await tools.call("propose_link", { from: seeds, to: garden, type: "part_of" })).result) as { id: string };

    // A page of one, then the next after it, then the last with nothing left.
    expect(fixture.calls.list_graph_proposals(null, 1)).toMatchObject({ links: [{ id: first.id }], entities: [], left: 2 });
    expect(fixture.calls.list_graph_proposals(null, 1, first.id)).toMatchObject({ links: [{ id: second.id }], left: 1 });
    expect(fixture.calls.list_graph_proposals(null, 5, second.id)).toMatchObject({ links: [{ id: third.id }], left: 0 });
    // Without a limit or an id every one comes, as the page and the Inbox read them.
    expect(fixture.calls.list_graph_proposals()).toMatchObject({ left: 0 });
    expect(fixture.calls.list_graph_proposals().links).toHaveLength(3);
    // An id not among them starts from the first.
    expect(fixture.calls.list_graph_proposals(null, 1, "gone")).toMatchObject({ links: [{ id: first.id }] });

    // A rejection has no level to raise: it only ever waits for the user, and approving it rejects the link.
    expect(() => fixture.calls.set_action_level("reject_graph_proposals", "auto")).toThrow("is not a change an engine is offered");
    const answer = await tools.call("reject_graph_proposals", { ids: [second.id] });
    expect(answer.result).toContain("waits for the user's approval");
    expect(fixture.calls.list_graph_proposals().links.map((each) => each.id)).toContain(second.id);
    const [proposal] = fixture.calls.list_proposals("general");
    expect(proposal).toMatchObject({ method: "reject_graph_proposals", arguments: { ids: [second.id] }, status: "waiting" });
    await fixture.calls.resolve_proposal(proposal!.id, "approve");
    expect(fixture.calls.list_graph_proposals().links.map((each) => each.id)).toEqual([first.id, third.id]);
  });

  it("is refused for an unknown link, without a reason, from a program, and once the user said no", async () => {
    const fixture = start_fixture();
    const { seeds, shop } = garden_of(fixture);
    const link = fixture.calls.add_graph_link(seeds, shop, "related_to");
    const { tools } = await tools_of(fixture);
    expect((await tools.call("propose_link_drop", { id: "nothing", reason: "Wrong." })).result).toContain("There is no link nothing.");
    expect((await tools.call("propose_link_drop", { id: link, reason: "  " })).result).toContain("Say why the link should go.");
    await expect(fixture.calls.propose_link_drop(link, "Wrong.")).rejects.toThrow("A drop is proposed from a conversation");

    const outcome = JSON.parse((await tools.call("propose_link_drop", { id: link, reason: "Wrong." })).result) as { id: string };
    await fixture.calls.resolve_proposal(outcome.id, "reject");
    expect(fixture.calls.get_node_links(seeds).links).toMatchObject([{ id: link, status: "accepted", valid_until: "" }]);
    expect(JSON.parse((await tools.call("propose_link_drop", { id: link, reason: "Really wrong." })).result)).toMatchObject({ outcome: "refused", id: outcome.id });
  });

  it("is counted in Suggest links' closing note, which lists each link's id", () => {
    const made = (name: string): ToolCallRecord => ({ id: name, name, arguments: {}, result: JSON.stringify({ outcome: "proposed" }), is_error: false, outcome: "ran" });
    expect(proposals_note([made("propose_link_drop")])).toBe("Suggest links proposed 0 entities and 0 links; they wait for you under Proposed links. It also asks to drop 1 link, in the conversation.");
    expect(suggest_tools).toEqual(expect.arrayContaining(["propose_link_drop", "list_graph_proposals"]));
    expect(suggest_links_message).toContain("propose_link_drop");
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

  it("run in their maintenance job on what the index wrote, which records History and tells the pages when it made links", async () => {
    const fixture = start_fixture();
    const { shop } = garden_of(fixture);
    const index = index_of(fixture);
    await sync_documents(fixture.database, index);
    expect(count_changed(index, "rules")).toBeGreaterThan(0);
    let told = 0;
    const outcome = await run_maintenance_job({ database: () => fixture.database, index: () => index, device: "Test laptop", kind: "desktop", now: () => Date.now(), on_change: () => (after_index_change(fixture.database), (told += 1)) }, "rules");
    expect(outcome).toMatchObject({ ran: true, done: { applied: ["The rules made 1 link."] } });
    expect(count_changed(index, "rules")).toBe(0);
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

  // A vector of 40 numbers whose cosine with the first axis is the score given, each on an axis of its own besides.
  const scored = (score: number, own_axis: number) => {
    const vector = Array.from({ length: 40 }, () => 0);
    vector[0] = score;
    vector[own_axis] = Math.sqrt(1 - score * score);
    return vector;
  };
  // Scores spread evenly from low to high, for the items unrelated to the one compared.
  const spread = (count: number, low: number, high: number) => Array.from({ length: count }, (_, at) => low + ((high - low) * at) / (count - 1));

  // Two embedders' scales: one whose right matches score 0.65 to 0.75 over unrelated text at 0.3 to 0.5, one whose
  // right matches score near 0.86 over unrelated text at 0.6 to 0.75.
  const scales = {
    "low-scoring": { related: [0.74, 0.72, 0.7, 0.68], linked: 0.73, unrelated: spread(30, 0.3, 0.5) },
    "high-scoring": { related: [0.89, 0.875, 0.86, 0.85], linked: 0.88, unrelated: spread(30, 0.6, 0.75) },
  };

  for (const [name, scale] of Object.entries(scales)) {
    it(`proposes an item's nearest standing clearly above the rest with a ${name} embedder, a few per item, never twice, between items linked or once rejected`, async () => {
      const fixture = start_fixture();
      const garden = fixture.calls.add_context("Garden");
      const add = (title: string) => fixture.calls.add_item([garden], "links", { source_id: `https://example.org/${title}`, kind: "link", title });
      const a = add("a");
      const [b, c, e, d] = scale.related.map((_, at) => add(`related-${at}`)) as [string, string, string, string];
      const f = add("linked");
      const others = scale.unrelated.map((_, at) => add(`unrelated-${at}`));
      fixture.calls.add_graph_link(a, f, "about");
      const index = index_of(fixture);
      await index_pass(fixture, index);
      let axis = 1;
      embed(index, {
        [a]: scored(1, 1),
        ...Object.fromEntries([b, c, e, d].map((id, at) => [id, scored(scale.related[at]!, ++axis)])),
        [f]: scored(scale.linked, ++axis),
        ...Object.fromEntries(others.map((id, at) => [id, scored(scale.unrelated[at]!, ++axis)])),
      });
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
      const after = fixture.calls.list_graph_proposals().links;
      expect(after.some((link) => link.id === similarity_link_id(`item:${a}`, `item:${b}`))).toBe(false);
      expect(after.some((link) => link.id === similarity_link_id(`item:${a}`, `item:${d}`))).toBe(true);
      expect(after.some((link) => link.id === similarity_link_id(`item:${a}`, `item:${f}`))).toBe(false);
      expect(after.some((link) => others.some((other) => link.id === similarity_link_id(`item:${a}`, `item:${other}`)))).toBe(false);
      expect(propose_similar(fixture.database, index, { ...pass, embedder: null })).toBe(false);
      expect(propose_similar(fixture.database, index, { ...pass, embedded: [] })).toBe(false);
    });
  }

  it("proposes nothing for an item when nothing stands out from what it scores against the rest", () => {
    const flat = spread(30, 0.3, 0.5).map((score, at) => ({ other: `o${at}`, score }));
    expect(standing_out(flat)).toEqual([]);
    expect(standing_out([{ other: "only", score: 0.9 }])).toEqual([]);
    for (const scale of Object.values(scales)) {
      const items = [...scale.related, ...scale.unrelated].map((score, at) => ({ other: `o${at}`, score }));
      expect(standing_out(items).map((each) => each.score)).toEqual(scale.related);
    }
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

  it("brings a removed context back with its links to what still exists", () => {
    const fixture = start_fixture();
    const { garden, seeds } = garden_of(fixture);
    const shed = fixture.calls.add_context("Shed");
    const ada = fixture.calls.add_entity("person", "Ada");
    const bob = fixture.calls.add_entity("person", "Bob");
    const about_ada = fixture.calls.add_graph_link(node_key("context", shed), node_key("entity", ada), "about");
    fixture.calls.add_graph_link(node_key("context", shed), node_key("entity", bob), "about");
    const with_garden = fixture.calls.add_graph_link(node_key("context", garden), node_key("context", shed), "related_to");

    fixture.calls.remove_context(shed);
    expect(fixture.calls.get_node_links(node_key("entity", ada)).links).toEqual([]);
    fixture.calls.remove_entity(bob);
    const deleted = fixture.calls.list_item_history("context", shed).find((version) => version.change === "deleted")!;
    fixture.calls.restore_item_version("context", deleted.id);

    const links = fixture.calls.get_node_links(node_key("context", shed)).links;
    expect(links.map((link) => link.id).sort()).toEqual([about_ada, with_garden].sort());
    expect(links.find((link) => link.id === about_ada)).toMatchObject({ status: "accepted", made_by: "user" });
    expect(seeds).toBeTruthy();
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
