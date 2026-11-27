import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { openai_embedder_plugin } from "../src/server/embedders/openai.ts";
import type { FoundItem } from "../src/shared/collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../src/shared/collectors/host.ts";
import { reply_ended, reply_started } from "../src/shared/conversations/activity.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { openai_embeddings_manifest, openai_embedder_id } from "../src/shared/embedders/manifests.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import { engine_tools, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { embed_pending, open_index, settle_index, sync_documents, use_search_index, index_now, keep_indexing, poke_index } from "../src/shared/search/indexer.ts";
import { open_screen } from "../src/shared/privacy/screen.ts";
import { chunk_text, fts_query, fuse_ranks, text_hash, unit, to_blob, from_blob } from "../src/shared/search/text.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

// ── Fakes ────────────────────────────────────────────────────────────────────

// Words that mean the same go to one place in the fake embedder's vectors.
const same_meaning: Record<string, string> = { automobile: "car", vehicle: "car", motor: "car" };

function word_vector(text: string, size: number): number[] {
  const vector = Array.from({ length: size }, () => 0);
  for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const word = same_meaning[raw] ?? raw;
    vector[Number.parseInt(text_hash(word), 16) % size]! += 1;
  }
  return vector;
}

interface FakeEmbedder {
  plugin: ContextPlugin;
  calls: string[][];
  model: { name: string };
  set_failing: (failing: boolean) => void;
  // Runs before each call is answered, such as to hold it until the test lets it go.
  before: { run?: (texts: string[]) => Promise<void> };
}

// An embedder plugin, provided as "fake-embedder", that counts what it was sent.
function fake_embedder(options: { hosted?: boolean } = {}): FakeEmbedder {
  const calls: string[][] = [];
  const model = { name: "words-1" };
  let failing = false;
  const before: FakeEmbedder["before"] = {};
  const plugin = define_plugin<ContextPluginApi>({
    id: "tests.fake-embedder",
    name: "Fake embedder",
    version: "1.0.0",
    start: (context) =>
      context.provide("embedder", "fake-embedder", {
        label: "Fake embedder",
        model: () => model.name,
        dimensions: () => 512,
        is_local: () => options.hosted !== true,
        embed: async (texts) => {
          if (failing) throw new Error("the model is away");
          await before.run?.(texts);
          calls.push(texts);
          return texts.map((text) => word_vector(text, 512));
        },
      }),
  });
  return { plugin, calls, model, set_failing: (on) => (failing = on), before };
}

interface FakeNotes {
  plugin: ContextPlugin;
  texts: Map<string, string>;
  reads: string[][];
}

// A collector of notes whose text it gives for the index, counting each read.
function fake_notes(): FakeNotes {
  const texts = new Map<string, string>();
  const reads: string[][] = [];
  const titles = new Map<string, string>();
  const plugin = define_plugin<ContextPluginApi>({
    id: "tests.notes",
    name: "Notes",
    version: "1.0.0",
    start: (context) =>
      context.provide("collector", "notes", {
        label: "Notes",
        kinds: ["note"],
        resolve: async (ids) => Object.fromEntries(ids.map((id): [string, FoundItem] => [id, { source_id: id, kind: "note", title: titles.get(id) ?? id }])),
        content: async (ids) => {
          reads.push(ids);
          return Object.fromEntries(ids.filter((id) => texts.has(id)).map((id) => [id, texts.get(id)!]));
        },
      }),
  });
  return { plugin, texts, reads };
}

interface Setup {
  fixture: Fixture;
  index: DatabaseSync;
  notes: FakeNotes;
  embedder: FakeEmbedder;
}

function set_up(options: { hosted_embedder?: boolean; hosted_engine?: boolean; with_embedder?: boolean } = {}): Setup {
  const notes = fake_notes();
  const embedder = fake_embedder({ hosted: options.hosted_embedder });
  const fixture = start_fixture({ hosted: options.hosted_engine, plugins: [notes.plugin, embedder.plugin] });
  const index = new DatabaseSync(":memory:");
  open_index(index);
  use_search_index({ database: () => fixture.database, index: () => index });
  if (options.with_embedder !== false) fixture.calls.set_setting("embedder", "fake-embedder");
  return { fixture, index, notes, embedder };
}

// Home with Kitchen inside it, and Taxes beside it; a note about the car in the kitchen, and a receipt in Taxes.
function seed(setup: Setup): { home: string; kitchen: string; taxes: string; car: string; receipt: string } {
  const { fixture, notes } = setup;
  const home = fixture.calls.add_context("Home");
  const kitchen = fixture.calls.add_context("Kitchen", home);
  const taxes = fixture.calls.add_context("Taxes");
  fixture.calls.set_context_notes(kitchen, "Tiles before the worktop.");
  notes.texts.set("n-car", "Automobile service");
  notes.texts.set("n-receipt", "Receipt for the tiler, paid in cash.");
  const car = fixture.calls.add_item([kitchen], "notes", { source_id: "n-car", kind: "note", title: "Garage visit" }, "ask about winter tyres");
  const receipt = fixture.calls.add_item([taxes], "notes", { source_id: "n-receipt", kind: "note", title: "Tiler receipt" });
  return { home, kitchen, taxes, car, receipt };
}

const count = (index: DatabaseSync, table: string) => (index.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;

afterEach(async () => {
  await settle_index();
  await wait_for_runs();
  use_search_index(null);
  use_assistant_host(null);
});

// ── Text ─────────────────────────────────────────────────────────────────────

describe("the index's text helpers", () => {
  it("cut long text into overlapping pieces at spaces, and keep short text whole", () => {
    expect(chunk_text("  short  ")).toEqual(["short"]);
    expect(chunk_text("   ")).toEqual([]);
    const words = Array.from({ length: 400 }, (_, at) => `word${at}`).join(" ");
    const pieces = chunk_text(words, 500, 100);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 500)).toBe(true);
    // Each piece starts with words the one before ended with.
    expect(pieces[1]!.includes(pieces[0]!.split(" ").at(-1)!)).toBe(true);
    expect(pieces.join(" ")).toContain("word399");
    expect(chunk_text("x".repeat(1000), 400, 50).every((piece) => piece.length <= 400)).toBe(true);
  });

  it("quote each word of a query, hash text, fuse rankings and keep vectors as blobs", () => {
    expect(fts_query('tiles "OR" grout-colour')).toBe('"tiles"* AND "or"* AND "grout"* AND "colour"*');
    expect(fts_query("a b", "OR")).toBe('"a"* OR "b"*');
    expect(fts_query("!!")).toBe("");
    expect(text_hash("a")).not.toBe(text_hash("b"));
    expect(text_hash("same")).toBe(text_hash("same"));
    const fused = fuse_ranks([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect([...fused].sort((first, second) => second[1] - first[1]).map(([key]) => key)).toEqual(["b", "a", "c"]);
    const vector = unit([3, 4]);
    expect([...from_blob(to_blob(vector))]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
  });
});

// ── Indexing ─────────────────────────────────────────────────────────────────

describe("indexing", () => {
  it("holds every kept item with its notes and its app's text, every context and the messages, and embeds them", async () => {
    const setup = set_up();
    const { kitchen } = seed(setup);
    add_message(setup.fixture.database, { conversation_id: kitchen, role: "user", text: "When is the tiler coming?" });
    add_message(setup.fixture.database, { conversation_id: kitchen, role: "event", text: "Approved and done." });
    // An item no context holds any more is not indexed.
    const loose = setup.fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/x", kind: "link", title: "Loose" });
    setup.fixture.calls.remove_item(kitchen, loose);

    await index_now();

    const state = await setup.fixture.calls.get_index_state();
    // The messages, kept with no conversation as an older device would, became a conversation item in the kitchen.
    expect(state).toMatchObject({ items: 3, contexts: 4, messages: 1, pending: 0, withheld: 0, embedder: { id: "fake-embedder", label: "Fake embedder", model: "words-1", dimensions: 512, is_local: true }, last_error: "", is_working: false });
    expect(state.embedded).toBe(state.chunks);
    expect(state.embedders).toEqual([{ id: "fake-embedder", label: "Fake embedder" }]);
    const car = setup.index.prepare("SELECT body, content FROM docs WHERE key LIKE 'item:notes:n-car'").get() as { body: string; content: string };
    expect(car).toEqual({ body: "ask about winter tyres", content: "Automobile service" });
    // The store never gets the text.
    expect(JSON.stringify(setup.fixture.calls.export_contexts())).not.toContain("Automobile");
  });

  it("indexes only what changed, reading an item's text again only when its app said something new, and calls no model when nothing did", async () => {
    const setup = set_up();
    const { kitchen, car } = seed(setup);
    const { index, notes, embedder, fixture } = setup;
    await index_now();
    const first_reads = notes.reads.length;
    const first_calls = embedder.calls.length;

    expect(await sync_documents(fixture.database, index)).toEqual({ written: 0, removed: 0, written_keys: [], was_empty: false, waiting: 0 });
    await index_now();
    expect([notes.reads.length, embedder.calls.length]).toEqual([first_reads, first_calls]);

    // A note on the item changes its text, but not what its app said: written and embedded again, its text not read.
    fixture.calls.set_item_note(kitchen, car, "ask about winter tyres and the brakes");
    await index_now();
    expect(notes.reads.length).toBe(first_reads);
    expect(embedder.calls.at(-1)!.join(" ")).toContain("brakes");
    expect(embedder.calls.at(-1)!.join(" ")).not.toContain("Tiler receipt");

    // A new title from its app reads its text again.
    notes.texts.set("n-car", "The vehicle is booked in for Tuesday.");
    fixture.calls.add_item([kitchen], "notes", { source_id: "n-car", kind: "note", title: "Garage booking" });
    await index_now();
    expect(notes.reads.at(-1)).toEqual(["n-car"]);
    expect((await fixture.calls.search_index("Tuesday")).map((hit) => hit.title)).toEqual(["Garage booking"]);

    // Taken out of every context, it leaves the index with its vectors.
    fixture.calls.remove_item(kitchen, car);
    await index_now();
    expect(index.prepare("SELECT COUNT(*) AS total FROM vectors WHERE key = ?").get(`item:${car}`)).toEqual({ total: 0 });
    expect((await fixture.calls.get_index_state()).items).toBe(1);
  });

  it("moves an item between contexts without embedding it again", async () => {
    const setup = set_up();
    const { taxes, car } = seed(setup);
    await index_now();
    const calls = setup.embedder.calls.length;
    setup.fixture.calls.add_item([taxes], "notes", { source_id: "n-car", kind: "note", title: "Garage visit" });
    await index_now();
    expect(setup.embedder.calls.length).toBe(calls);
    expect((await setup.fixture.calls.search_index("garage", taxes)).map((hit) => hit.id)).toEqual([car]);
  });

  it("keeps the text it had when a collector fails, and says so", async () => {
    const setup = set_up({ with_embedder: false });
    seed(setup);
    await index_now();
    const failing = define_plugin<ContextPluginApi>({
      id: "tests.broken",
      name: "Broken",
      version: "1.0.0",
      start: (context) => context.provide("collector", "broken", { label: "Broken", kinds: ["note"], content: async () => Promise.reject(new Error("offline")) }),
    });
    const fixture = start_fixture({ plugins: [failing] });
    const index = new DatabaseSync(":memory:");
    open_index(index);
    use_search_index({ database: () => fixture.database, index: () => index });
    const home = fixture.calls.add_context("Home");
    fixture.calls.add_item([home], "broken", { source_id: "b1", kind: "note", title: "Broken note" });
    await index_now();
    expect((await fixture.calls.get_index_state()).last_error).toBe("Broken: offline");
    expect((await fixture.calls.search_index("broken")).map((hit) => hit.title)).toEqual(["Broken note"]);
  });

  it("embeds again when the embedder's model changes, and stops with none chosen", async () => {
    const setup = set_up();
    seed(setup);
    await index_now();
    const embedded = (await setup.fixture.calls.get_index_state()).embedded;
    setup.embedder.model.name = "words-2";
    expect((await setup.fixture.calls.get_index_state())).toMatchObject({ embedded: 0, pending: embedded });
    await index_now();
    expect(count(setup.index, "vectors")).toBe(embedded);
    expect((setup.index.prepare("SELECT DISTINCT model FROM vectors").all() as { model: string }[]).map((row) => row.model)).toEqual(["words-2"]);

    setup.fixture.calls.set_setting("embedder", "");
    expect(await setup.fixture.calls.get_index_state()).toMatchObject({ embedder: null, pending: 0, embedder_problem: "" });
    setup.fixture.calls.set_setting("embedder", "gone");
    expect((await setup.fixture.calls.get_index_state()).embedder_problem).toContain("The gone embedder is not running");
  });

  it("records an embedder's failure and carries on with the words", async () => {
    const setup = set_up();
    seed(setup);
    setup.embedder.set_failing(true);
    await index_now();
    const state = await setup.fixture.calls.get_index_state();
    expect(state.last_error).toBe("the model is away");
    expect(state.pending).toBe(state.chunks);
    expect((await setup.fixture.calls.search_index("tyres")).map((hit) => hit.title)).toEqual(["Garage visit"]);
  });

  it("clears a stale error as soon as a later attempt embeds, before the pass ends", async () => {
    const setup = set_up();
    seed(setup);
    for (let at = 0; at < 20; at++) setup.fixture.calls.add_context(`Room ${at}`);
    setup.embedder.set_failing(true);
    await index_now();
    expect((await setup.fixture.calls.get_index_state()).last_error).toBe("the model is away");

    setup.embedder.set_failing(false);
    const seen: string[] = [];
    setup.embedder.before.run = async () => void seen.push((await setup.fixture.calls.get_index_state()).last_error);
    await index_now();

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.slice(0, 2)).toEqual(["the model is away", ""]);
    expect((await setup.fixture.calls.get_index_state())).toMatchObject({ last_error: "", pending: 0 });
  });

  it("says in plain words which embedder endpoint cannot be reached, and clears it when the endpoint is corrected during a pass", async () => {
    // A real embeddings endpoint on a random port, and the address of one where nothing listens.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: [text.length, 1, 2, 3, 4, 5, 6, 7] })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const working_endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closed_port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    try {
      const notes = fake_notes();
      let hold: Promise<void> | null = null;
      const slow_notes = define_plugin<ContextPluginApi>({
        id: "tests.slow-notes",
        name: "Slow notes",
        version: "1.0.0",
        start: (context) =>
          context.provide("collector", "slow", {
            label: "Slow notes",
            kinds: ["note"],
            content: async (ids) => {
              await hold;
              return Object.fromEntries(ids.map((id) => [id, `The text of ${id}.`]));
            },
          }),
      });
      const fixture = start_fixture({ plugins: [notes.plugin, slow_notes, openai_embedder_plugin()] });
      const index = new DatabaseSync(":memory:");
      open_index(index);
      use_search_index({ database: () => fixture.database, index: () => index });
      const home = fixture.calls.add_context("Home");
      fixture.calls.add_item([home], "slow", { source_id: "s1", kind: "note", title: "First note" });
      const plugins = (endpoint: string) => ({ [openai_embeddings_manifest.id]: { enabled: true, settings: { endpoint, model: "small", dimensions: 8 } } });

      // Chosen while still pointing where nothing answers.
      fixture.calls.set_setting("plugins", plugins(`http://127.0.0.1:${closed_port}/v1`));
      fixture.calls.set_setting("embedder", openai_embedder_id);
      await index_now();
      const failed = await fixture.calls.get_index_state();
      expect(failed.last_error).toBe(`The embedder at 127.0.0.1:${closed_port} cannot be reached. Check that its server is running and that its endpoint under Settings → Index is right.`);
      expect(failed.last_error_detail).toMatch(/^fetch failed.*ECONNREFUSED/);

      // A pass is under way, held reading a source, when the endpoint is corrected.
      let release = () => {};
      hold = new Promise<void>((resolve) => (release = resolve));
      fixture.calls.add_item([home], "slow", { source_id: "s2", kind: "note", title: "Second note" });
      const pass = index_now();
      fixture.calls.set_setting("plugins", plugins(working_endpoint));
      expect(await fixture.calls.get_index_state()).toMatchObject({ last_error: "", last_error_detail: "" });

      release();
      await pass;
      await settle_index();
      expect(await fixture.calls.get_index_state()).toMatchObject({ last_error: "", last_error_detail: "", pending: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ends the embedding in hand when the embedder's settings change, and goes round again with the new ones", async () => {
    const setup = set_up();
    seed(setup);
    for (let at = 0; at < 20; at++) setup.fixture.calls.add_context(`Room ${at}`);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    setup.embedder.before.run = () => held;
    const pass = index_now();
    await new Promise((resolve) => setTimeout(resolve, 20));

    setup.fixture.calls.set_setting("embedder", "");
    release();
    await pass;
    await settle_index();

    expect(setup.embedder.calls).toHaveLength(1);
    expect(await setup.fixture.calls.get_index_state()).toMatchObject({ embedder: null, last_error: "" });
  });

  it("waits while a reply is being written before calling the embedder", async () => {
    const setup = set_up();
    seed(setup);
    await sync_documents(setup.fixture.database, setup.index);
    reply_started();
    const embedding = embed_pending(setup.fixture.database, setup.index, new AbortController().signal, 5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(setup.embedder.calls).toEqual([]);
    reply_ended();
    expect(await embedding).toBeGreaterThan(0);
    // Stopped, it makes no call.
    const stopped = new AbortController();
    stopped.abort();
    setup.embedder.model.name = "words-3";
    expect(await embed_pending(setup.fixture.database, setup.index, stopped.signal)).toBe(0);
  });

  it("rebuilds from nothing, and catches up after writes and on its own schedule", async () => {
    const setup = set_up();
    seed(setup);
    await index_now();
    const before = await setup.fixture.calls.get_index_state();
    await setup.fixture.calls.rebuild_index();
    await settle_index();
    expect(await setup.fixture.calls.get_index_state()).toMatchObject({ items: before.items, contexts: before.contexts, embedded: before.embedded });

    // A write asks for a pass soon after.
    setup.fixture.calls.add_context("Garden");
    poke_index(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle_index();
    expect((await setup.fixture.calls.get_index_state()).contexts).toBe(before.contexts + 1);

    use_search_index(null);
    const kept = keep_indexing({ database: () => setup.fixture.database, index: () => setup.index });
    setup.fixture.calls.add_context("Shed");
    poke_index(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle_index();
    await kept.stop();
    expect(count(setup.index, "docs")).toBe(before.items + before.contexts + 2);
    await expect(Promise.resolve().then(() => setup.fixture.calls.get_index_state())).rejects.toThrow("runs only where the store runs");
  });
});

// ── Searching ────────────────────────────────────────────────────────────────

describe("searching", () => {
  it("fuses words and meaning: a match on both ranks first, and meaning finds other words for the same thing", async () => {
    const setup = set_up();
    const { car, kitchen } = seed(setup);
    await index_now();

    const by_meaning = await setup.fixture.calls.search_index("car");
    expect(by_meaning[0]).toMatchObject({ kind: "item", id: car, title: "Garage visit", collector: "notes", item_kind: "note", matched_by: ["meaning"], where: [{ id: kitchen, name: "Kitchen" }] });
    expect(by_meaning[0]!.excerpt).toContain("Automobile");

    const both = await setup.fixture.calls.search_index("automobile tyres");
    expect(both[0]).toMatchObject({ id: car, matched_by: ["words", "meaning"] });
    expect(both[0]!.excerpt).toContain("Automobile");
    expect(both[0]!.score).toBeGreaterThan(both[1]?.score ?? 0);
    expect(await setup.fixture.calls.search_index("   ")).toEqual([]);
  });

  it("finds contexts by their notes and messages by their words, saying where each is", async () => {
    const setup = set_up({ with_embedder: false });
    const { home, kitchen } = seed(setup);
    const general = add_message(setup.fixture.database, { conversation_id: "general", role: "assistant", text: "The worktop arrives in March." });
    await index_now();

    const found = await setup.fixture.calls.search_index("worktop");
    expect(found.map((hit) => [hit.kind, hit.title, hit.where, hit.matched_by])).toEqual(
      expect.arrayContaining([
        ["context", "Kitchen", [{ id: home, name: "Home" }], ["words"]],
        ["message", "Assistant", [], ["words"]],
      ]),
    );
    expect(found.find((hit) => hit.kind === "message")!.id).toBe(general.id);
    // A context with no notes has no excerpt, rather than its name again.
    expect((await setup.fixture.calls.search_index("home"))[0]).toMatchObject({ kind: "context", where: [{ id: "global", name: "Global" }], excerpt: "" });
    // Words that do not all match fall back to any of them.
    expect((await setup.fixture.calls.search_index("worktop zebra")).length).toBeGreaterThan(0);
    void kitchen;
  });

  it("keeps to a context and every context inside it, and a limit", async () => {
    const setup = set_up();
    const { home, kitchen, taxes, car, receipt } = seed(setup);
    await index_now();
    const ids = async (query: string, context_id: string | null, limit?: number) => (await setup.fixture.calls.search_index(query, context_id, limit)).map((hit) => hit.id);

    expect(await ids("tiler", taxes)).toEqual([receipt]);
    expect(await ids("tyres", home)).toEqual([car]);
    expect(await ids("tyres", taxes)).toEqual([]);
    expect(await ids("tiles", home)).toEqual([kitchen]);
    expect((await ids("the", null, 1)).length).toBe(1);
    await expect(setup.fixture.calls.search_index("x", "nowhere")).rejects.toThrow("There is no context nowhere.");
  });

  it("ranks items and contexts ahead of messages scoring close, and leaves out the asking conversation's messages for an engine", async () => {
    const setup = set_up({ with_embedder: false });
    const { kitchen } = seed(setup);
    const asking = add_message(setup.fixture.database, { conversation_id: "asking", role: "user", text: "Where are the tiles?", sources: [] });
    const other = add_message(setup.fixture.database, { conversation_id: "other", role: "assistant", text: "The tiles came on Monday.", sources: [] });
    await index_now();

    const found = await setup.fixture.calls.search_index("tiles");
    expect(found[0]).toMatchObject({ kind: "context", id: kitchen });
    expect(found.filter((hit) => hit.kind === "message").map((hit) => hit.id).sort()).toEqual([asking.id, other.id].sort());

    const context: ToolContext = {
      database: () => setup.fixture.database,
      call: async (method, args) => (setup.fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
      conversation_id: "asking",
      presence: "conversation",
      has_outside_content: false,
    };
    const answer = await engine_tools(context).call("search_index", { query: "tiles" });
    expect(answer.result).toContain(other.id);
    expect(answer.result).not.toContain(asking.id);
    expect(answer.result).not.toContain("Where are the tiles?");
  });

  it("searches by words alone when the embedder cannot read the query", async () => {
    const setup = set_up();
    seed(setup);
    await index_now();
    setup.embedder.set_failing(true);
    expect((await setup.fixture.calls.search_index("tyres")).map((hit) => hit.matched_by)).toEqual([["words"]]);
  });
});

// ── Privacy ──────────────────────────────────────────────────────────────────

describe("the index and hosted models", () => {
  it("never sends a hosted embedder text from a source not marked for hosted engines", async () => {
    const setup = set_up({ hosted_embedder: true });
    seed(setup);
    await index_now();
    const sent = setup.embedder.calls.flat().join(" ");
    expect(sent).not.toContain("Automobile");
    expect(sent).not.toContain("Garage");
    expect(sent).toContain("Tiles before the worktop.");
    const state = await setup.fixture.calls.get_index_state();
    expect(state.withheld).toBeGreaterThan(0);
    expect(state.pending).toBe(0);
    expect(state.embedder!.is_local).toBe(false);

    setup.fixture.calls.set_source_mark("tests.notes", "send_to_hosted", true);
    await index_now();
    expect(setup.embedder.calls.flat().join(" ")).toContain("Automobile");
    expect((await setup.fixture.calls.get_index_state()).withheld).toBe(0);
  });

  it("gives an engine the search as a tool, withholding unmarked items from a hosted one and tainting by source", async () => {
    const setup = set_up({ with_embedder: false });
    const { kitchen } = seed(setup);
    await index_now();
    const tools_of = async (hosted: boolean) => {
      const context: ToolContext = {
        database: () => setup.fixture.database,
        call: async (method, args) => (setup.fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
        conversation_id: "general",
        presence: "conversation",
        has_outside_content: false,
        screen: await open_screen(setup.fixture.database, hosted),
      };
      return { context, tools: engine_tools(context) };
    };

    const hosted = await tools_of(true);
    expect(hosted.tools.definitions.some((tool) => tool.name === "search_index")).toBe(true);
    const found = await hosted.tools.call("search_index", { query: "tiles tyres", context_id: kitchen });
    expect(found.result).toContain("Kitchen");
    expect(found.result).not.toContain("Garage");
    expect(found.result).toContain("[Withheld: 1 item (1 from Notes)");
    // Only the user's own words were left, so nothing taints.
    expect(hosted.context.has_outside_content).toBe(false);

    const local = await tools_of(false);
    const all = await local.tools.call("search_index", { query: "tyres" });
    expect(all.result).toContain("Garage visit");
    expect(local.context.has_outside_content).toBe(true);
    setup.fixture.calls.set_source_mark("tests.notes", "trusted", true);
    const trusted = await tools_of(false);
    await trusted.tools.call("search_index", { query: "tyres" });
    expect(trusted.context.has_outside_content).toBe(false);
  });
});
