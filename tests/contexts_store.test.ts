import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { app_info, type Feed, type FoundItem } from "../src/shared/collectors/collector.ts";
import { links_plugin } from "../src/shared/collectors/bundled.ts";
import { use_plugins, type ContextPluginApi } from "../src/shared/collectors/host.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

// ── A collector of its own ───────────────────────────────────────────────────

// What the fake app holds now, by id; tests change it to see what a refresh does.
let held: Record<string, FoundItem> = {};

const fake_plugin = define_plugin<ContextPluginApi>({
  id: "tests.fake",
  name: "Fake",
  version: "1.0.0",
  app: app_info.id,
  start: (context) =>
    context.provide("collector", "fake", {
      label: "Fake",
      kinds: ["task"],
      search: async (query) => Object.values(held).filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
      resolve: async (ids) => Object.fromEntries(ids.filter((id) => held[id]).map((id) => [id, held[id]!])),
      feeds: {
        list: async () => [{ id: "tag:seeds", label: "Seeds", kind: "Tag" }, ...grouped],
        items: async (feed_id) => {
          if (feed_id === "tag:broken") throw new Error("X-Tasks is down.");
          return (tagged[feed_id] ?? []).map((id) => held[id]!).filter(Boolean);
        },
      },
    }),
});

// Which of the fake app's items each feed holds now.
let tagged: Record<string, string[]> = {};

// The feeds in a filter group the fake app offers besides Seeds.
let grouped: Feed[] = [];

const broken_plugin = define_plugin<ContextPluginApi>({
  id: "tests.broken",
  name: "Broken",
  version: "1.0.0",
  app: app_info.id,
  start: (context) =>
    context.provide("collector", "broken", {
      label: "Broken",
      kinds: ["note"],
      resolve: async () => {
        throw new Error("Set the server's address.");
      },
    }),
});

function open_methods() {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  return bind_methods(() => database, () => undefined);
}

beforeEach(() => {
  grouped = [];
  tagged = { "tag:seeds": ["t1", "t2"] };
  held = { t1: { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" }, t2: { source_id: "t2", kind: "task", title: "Fix fence" } };
  use_plugins([fake_plugin, broken_plugin, links_plugin]);
});

afterEach(() => use_plugins([]));

// ── Contexts ─────────────────────────────────────────────────────────────────

describe("contexts", () => {
  it("nest, keep their order among siblings, and move anywhere but inside themselves", () => {
    const store = open_methods();
    const garden = store.add_context("  Garden ", null);
    const beds = store.add_context("Beds", garden);
    const taxes = store.add_context("Taxes", null);

    expect(store.list_contexts(false).map((context) => [context.name, context.parent_id, context.position])).toEqual([
      ["Beds", garden, 0],
      ["Garden", null, 0],
      ["Taxes", null, 1],
    ]);
    expect(() => store.move_context(garden, beds, null)).toThrow("inside itself");
    store.move_context(taxes, garden, null);
    expect(store.list_contexts(false).find((context) => context.id === taxes)).toMatchObject({ parent_id: garden, position: 1 });
    expect(() => store.add_context(" ", null)).toThrow("name");
  });

  it("are renamed, given notes, archived out of the list and deleted with every context inside them", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    const beds = store.add_context("Beds", garden);
    store.rename_context(garden, "Allotment");
    store.set_context_notes(garden, "Plot 14");
    expect(store.get_context(garden)).toMatchObject({ name: "Allotment", notes: "Plot 14" });

    store.set_context_archived(garden, true);
    expect(store.list_contexts(false).map((context) => context.id)).toEqual([beds]);
    expect(store.list_contexts(true)).toHaveLength(2);

    store.remove_context(garden);
    expect(store.list_contexts(true)).toEqual([]);
    expect(() => store.get_context(garden)).toThrow("no context");
  });
});

// ── Items ────────────────────────────────────────────────────────────────────

describe("items", () => {
  it("are kept once per collector and source, shown in every context that holds them with their own notes", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    const spring = store.add_context("Spring", null);
    const id = store.add_item([garden, spring], "fake", held.t1!, "Before March");
    store.add_item([garden], "fake", held.t1!, "a second add changes nothing");
    store.set_item_note(spring, id, "This week");

    expect(id).toBe("fake:t1");
    const in_garden = store.get_context(garden).items;
    expect(in_garden).toHaveLength(1);
    expect(in_garden[0]).toMatchObject({ title: "Order seeds", note: "Before March", also_in: [{ id: spring, name: "Spring" }] });
    expect(store.get_context(spring).items[0]!.note).toBe("This week");
    expect(store.get_item(id).contexts.map((context) => context.name)).toEqual(["Garden", "Spring"]);
    expect(() => store.add_item([], "fake", held.t1!, "")).toThrow("at least one context");
  });

  it("leave a context without leaving their app or the other contexts", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    const spring = store.add_context("Spring", null);
    const id = store.add_item([garden, spring], "fake", held.t1!, "");
    store.remove_item(garden, id);
    expect(store.get_context(garden).items).toEqual([]);
    expect(store.get_context(spring).items.map((item) => item.id)).toEqual([id]);
  });

  it("are found among those kept by their title, snippet or address", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "");
    store.add_item([garden], "fake", held.t2!, "");
    expect(store.search_kept_items("seeds").map((item) => [item.title, item.contexts.map((context) => context.name)])).toEqual([["Order seeds", ["Garden"]]]);
    expect(store.search_kept_items("x-tasks://").map((item) => item.id)).toEqual(["fake:t1"]);
  });
});

// ── Collectors ───────────────────────────────────────────────────────────────

describe("collectors", () => {
  it("are listed with what each can do", async () => {
    const store = open_methods();
    const listed = await store.list_collectors();
    expect(listed.map((collector) => [collector.id, collector.can_search, collector.can_refresh, collector.can_follow, collector.manual_fields.length])).toEqual([
      ["fake", true, true, true, 0],
      ["broken", false, true, false, 0],
      ["links", false, false, false, 2],
      // CODEX's own, answering for the conversations kept as items.
      ["conversation", false, true, false, 0],
    ]);
  });

  it("search their app, marking what a context holds already", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "");
    const found = await store.search_collector("fake", "e");
    expect(found.map((item) => [item.source_id, item.kept_in])).toEqual([
      ["t1", [garden]],
      ["t2", []],
    ]);
    await expect(store.search_collector("broken", "x")).rejects.toThrow("cannot search");
    await expect(store.search_collector("nowhere", "x")).rejects.toThrow("not running");
  });

  it("take an item typed in by hand", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    const id = await store.add_manual_item([garden], "links", { url: "example.org/seeds", title: "" }, "");
    expect(store.get_item(id)).toMatchObject({ kind: "link", title: "example.org", uri: "https://example.org/seeds" });
    await expect(store.add_manual_item([garden], "fake", {}, "")).rejects.toThrow("typed in by hand");
  });

  it("refresh their items: new titles are kept, gone ones are marked missing, and a failing collector is reported", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "");
    store.add_item([garden], "fake", held.t2!, "");
    store.add_item([garden], "broken", { source_id: "n1", kind: "note", title: "Plan" }, "");

    held = { t1: { ...held.t1!, title: "Order seeds by Friday", status: "done" } };
    const report = await store.refresh_items(garden);

    expect(report).toEqual({ checked: 2, updated: 1, missing: 1, joined: 0, left: 0, problems: ["Broken: Set the server's address."] });
    const items = Object.fromEntries(store.get_context(garden).items.map((item) => [item.id, item]));
    expect(items["fake:t1"]).toMatchObject({ title: "Order seeds by Friday", status: "done" });
    expect(items["fake:t2"]!.status).toBe("missing");
    expect((await store.refresh_items(null)).missing).toBe(0);
  });
});

// ── Import and export ────────────────────────────────────────────────────────

describe("import and export", () => {
  it("carry every context, item and note into another database, and refuse other files", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "Before March");
    const file = JSON.stringify(store.export_contexts());

    const other = open_methods();
    expect(other.import_contexts(file)).toEqual({ contexts: 1, items: 1 });
    expect(other.get_context(garden).items[0]).toMatchObject({ title: "Order seeds", note: "Before March" });
    expect(() => other.import_contexts(JSON.stringify({ app: "x-tasks" }))).toThrow("not a CODEX export");
    expect(() => other.import_contexts(JSON.stringify({ app: "codex", kind: "contexts", version: 9 }))).toThrow("newer");
  });

  it("reads an export X-Context made, so its contexts move over", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "Before March");
    const file = JSON.stringify({ ...store.export_contexts(), app: "x-context" });

    const other = open_methods();
    expect(other.import_contexts(file)).toEqual({ contexts: 1, items: 1 });
    expect(other.get_context(garden).items[0]).toMatchObject({ title: "Order seeds", note: "Before March" });
  });
});

// ── Feeds ────────────────────────────────────────────────────────────────────

describe("following a feed", () => {
  it("brings in what the feed holds now, and lists the feed on the context with where each item came from", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    expect(await store.list_collector_feeds("fake")).toEqual([{ id: "tag:seeds", label: "Seeds", kind: "Tag" }]);

    const report = await store.follow_feed(garden, "fake", "tag:seeds", "Seeds");

    expect(report).toMatchObject({ joined: 2, left: 0, problems: [] });
    const context = store.get_context(garden);
    expect(context.feeds).toEqual([expect.objectContaining({ collector: "fake", feed_id: "tag:seeds", label: "Seeds" })]);
    expect(context.items.map((item) => [item.id, item.via_label])).toEqual(expect.arrayContaining([["fake:t1", "Seeds"], ["fake:t2", "Seeds"]]));
    await expect(store.list_collector_feeds("links")).rejects.toThrow("nothing to follow");
  });

  it("keeps in step on refresh, but keeps items added by hand or given a note", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    held.t3 = { source_id: "t3", kind: "task", title: "Water beds" };
    held.t4 = { source_id: "t4", kind: "task", title: "Buy compost" };
    tagged["tag:seeds"] = ["t1", "t2", "t4"];
    await store.follow_feed(garden, "fake", "tag:seeds", "Seeds");
    store.set_item_note(garden, "fake:t2", "Keep this one");
    store.add_item([garden], "fake", held.t4!, "");

    tagged["tag:seeds"] = ["t3"];
    const report = await store.refresh_items(garden);

    expect(report).toMatchObject({ joined: 1, left: 1 });
    expect(store.get_context(garden).items.map((item) => item.id).sort()).toEqual(["fake:t2", "fake:t3", "fake:t4"]);
  });

  it("leaves what a feed brought while the feed cannot answer, and says so", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    tagged["tag:broken"] = [];
    await store.follow_feed(garden, "fake", "tag:seeds", "Seeds");
    await store.follow_feed(garden, "fake", "tag:broken", "Broken tag");

    const report = await store.refresh_items(null);

    expect(report.problems).toEqual(["Broken tag: X-Tasks is down."]);
    expect(store.get_context(garden).items).toHaveLength(2);
  });

  it("stops: the feed's items leave, but for the ones given a note", async () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    await store.follow_feed(garden, "fake", "tag:seeds", "Seeds");
    store.set_item_note(garden, "fake:t1", "Mine now");

    store.unfollow_feed(garden, "fake", "tag:seeds");

    const context = store.get_context(garden);
    expect(context.feeds).toEqual([]);
    expect(context.items.map((item) => [item.id, item.via_label])).toEqual([["fake:t1", ""]]);
  });

  it("makes a context for each feed picked, following it, and carries feeds through export", async () => {
    const store = open_methods();
    const home = store.add_context("Home", null);
    const ids = await store.add_contexts_from_feeds("fake", [{ id: "tag:seeds", label: "Seeds" }], home);

    expect(store.get_context(ids[0]!)).toMatchObject({ name: "Seeds", parent_id: home, item_count: 2 });
    await expect(store.add_contexts_from_feeds("fake", [], null)).rejects.toThrow("at least one");

    const other = open_methods();
    other.import_contexts(JSON.stringify(store.export_contexts()));
    expect(other.get_context(ids[0]!).feeds.map((feed) => feed.label)).toEqual(["Seeds"]);
  });
});

// ── Card view ────────────────────────────────────────────────────────────────

describe("the card view", () => {
  it("keeps a context's view and its cards' places, out of its history, and through export", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "fake", held.t1!, "");
    expect(store.get_context(garden)).toMatchObject({ view: "list", card_places: [] });
    const versions = store.list_item_history("context", garden).length;

    store.set_context_view(garden, "cards");
    store.set_card_places(garden, [{ id: "fake:t1", x: 2, y: 0, w: 6, h: 4 }]);

    expect(store.get_context(garden)).toMatchObject({ view: "cards", card_places: [{ id: "fake:t1", x: 2, y: 0, w: 6, h: 4 }] });
    expect(store.list_item_history("context", garden)).toHaveLength(versions);
    const other = open_methods();
    other.import_contexts(JSON.stringify(store.export_contexts()));
    expect(other.get_context(garden).view).toBe("cards");
  });

  it("refuses a view it does not know and places that are not whole cells", () => {
    const store = open_methods();
    const garden = store.add_context("Garden", null);
    expect(() => store.set_context_view(garden, "board" as never)).toThrow("list");
    expect(() => store.set_card_places(garden, [{ id: "a", x: 0.5, y: 0, w: 4, h: 4 }])).toThrow("whole cells");
    expect(() => store.set_card_places(garden, [{ id: "a", x: 0, y: 0, w: 0, h: 4 }])).toThrow("whole cells");
    expect(() => store.set_card_places("nowhere", [])).toThrow("no context");
  });
});

// ── Feed groups ──────────────────────────────────────────────────────────────

describe("contexts from a feed group", () => {
  const area = { id: "area", label: "Area" };
  const tag = (id: string, label: string): Feed => ({ id: `tag:${id}`, label, kind: "Tag", group: area });

  it("makes a context for the group with one inside following each of its outer feeds, and offers ones added later", async () => {
    const store = open_methods();
    grouped = [tag("home", "Home"), tag("garden", "Home/Garden"), tag("work", "Work")];
    tagged["tag:home"] = ["t1"];

    const id = await store.add_contexts_from_feed_group("fake", "area", null);

    const made = store.get_context(id);
    expect(made).toMatchObject({ name: "Area", seeded_from: { collector: "fake", group_id: "area", label: "Area" } });
    const inside = store.list_contexts().filter((context) => context.parent_id === id);
    expect(inside.map((context) => context.name).sort()).toEqual(["Home", "Work"]);
    expect(store.get_context(inside.find((context) => context.name === "Home")!.id).items.map((item) => item.id)).toEqual(["fake:t1"]);
    expect(await store.list_feed_group_news(id)).toEqual([]);

    grouped.push(tag("health", "Health"));
    expect((await store.list_feed_group_news(id)).map((feed) => feed.label)).toEqual(["Health"]);

    store.stop_feed_group_news(id);
    expect(store.get_context(id).seeded_from).toBeNull();
    expect(await store.list_feed_group_news(id)).toEqual([]);
  });

  it("refuses a group with nothing in it, and carries the group through export", async () => {
    const store = open_methods();
    await expect(store.add_contexts_from_feed_group("fake", "nothing", null)).rejects.toThrow("nothing to follow");

    grouped = [tag("work", "Work")];
    const id = await store.add_contexts_from_feed_group("fake", "area", null);
    const other = open_methods();
    other.import_contexts(JSON.stringify(store.export_contexts()));
    expect(other.get_context(id).seeded_from).toEqual({ collector: "fake", group_id: "area", label: "Area" });
    expect(store.get_context(store.add_context("Plain", null)).seeded_from).toBeNull();
  });
});
