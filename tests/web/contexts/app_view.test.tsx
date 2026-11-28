// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { app_info, type Feed } from "../../../src/shared/collectors/collector.ts";
import { links_plugin } from "../../../src/shared/collectors/bundled.ts";
import { use_plugins, type ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { add_message } from "../../../src/shared/conversations/messages.ts";
import { add_conversation_record } from "../../../src/shared/conversations/records.ts";
import { route_of_link } from "../../../src/shared/links.ts";
import { bind_methods, open_store, type ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { App } from "../../../src/web/App.tsx";
import { group_by_kind } from "../../../src/web/contexts/ContextView.tsx";
import { groups_of, kinds_of, plural_of } from "../../../src/web/contexts/FeedDialogs.tsx";
import { forget_page_plugins } from "../../../src/web/plugins.tsx";

// The page's calls answered by a real store on a throwaway database, as the desktop app would, which needs no sign-in.
function fake_page(database = new DatabaseSync(":memory:")): ContextMethods {
  open_store(database);
  const methods = bind_methods(() => database, () => undefined);
  const calls = Object.fromEntries(Object.entries(methods).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "desktop", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return methods;
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  use_plugins([links_plugin]);
  forget_page_plugins();
});

afterEach(() => {
  cleanup();
  use_plugins([]);
});

describe("the page", () => {
  it("lists the contexts as a tree in the sidebar and as cards on the first page", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.add_context("Beds", garden);
    render(<App />);

    const tree = await screen.findByRole("tree", { name: "Contexts" });
    expect(await within(tree).findByText("Garden")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Contexts" })).toBeTruthy();
    expect(screen.getByText("Beds", { selector: ".card *" })).toBeTruthy();

    fireEvent.click(within(tree).getByText("Garden"));
    expect(window.location.hash).toBe(`#/context/${garden}`);
  });

  it("puts Global at the top of the tree, selected while no other context is open, and offers it no delete", async () => {
    const store = fake_page();
    store.add_context("Garden");
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Contexts" });
    await within(tree).findByText("Garden");
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows[0]!.textContent).toContain("Global");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.contextMenu(within(tree).getByText("Global"));
    expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete…" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("shows a context's items grouped by kind, each opening in its own app", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "links", { source_id: "https://example.org/", kind: "link", title: "Seed shop", uri: "https://example.org/" }, "Cheapest");
    store.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1", status: "done" }, "");
    go(`#/context/${garden}`);
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Garden" })).toBeTruthy();
    const main = document.querySelector<HTMLElement>(".main-pane")!;
    const headings = within(main).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Notes", "Tasks · 1", "Links · 1"]);
    expect(screen.getByRole("link", { name: "Order seeds" }).getAttribute("href")).toBe("x-tasks://task/t1");
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Cheapest")).toBeTruthy();
  });

  it("adds a web link typed in by hand from a context's page", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    go(`#/context/${garden}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.change(await screen.findByLabelText("Address"), { target: { value: "example.org/seeds" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Seed shop" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(store.get_context(garden).items.map((item) => item.uri)).toEqual(["https://example.org/seeds"]));
  });

  it("makes a new context from the first page and opens it", async () => {
    const store = fake_page();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "New context" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Taxes" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name)).toEqual(["Global", "Taxes"]));
    expect(window.location.hash).toBe(`#/context/${store.list_contexts(false).find((context) => context.name === "Taxes")!.id}`);
  });
});

describe("the card view", () => {
  it("shows a context's items as cards when switched, each with a handle to move it", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" }, "");
    go(`#/context/${garden}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("radio", { name: "Cards" }));

    await waitFor(() => expect(store.get_context(garden).view).toBe("cards"));
    const grid = await screen.findByRole("list", { name: "Items" });
    expect(within(grid).getByRole("link", { name: "Order seeds" })).toBeTruthy();
    fireEvent.keyDown(within(grid).getByRole("button", { name: "Move Order seeds" }), { key: "ArrowRight" });
    await waitFor(() => expect(store.get_context(garden).card_places).toEqual([{ id: "x-tasks:t1", x: 1, y: 0, w: 4, h: 4 }]));
  });

  it("groups the items on a card per kind, keeping the single cards' places apart", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" }, "");
    store.add_item([garden], "x-tasks", { source_id: "t2", kind: "task", title: "Fix fence", uri: "x-tasks://task/t2" }, "");
    store.add_item([garden], "links", { source_id: "https://example.org/", kind: "link", title: "Seed shop", uri: "https://example.org/" }, "");
    store.set_card_places(garden, [{ id: "x-tasks:t1", x: 4, y: 0, w: 4, h: 4 }]);
    go(`#/context/${garden}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("radio", { name: "Grouped" }));

    await waitFor(() => expect(store.get_context(garden).view).toBe("grouped"));
    const grid = await screen.findByRole("list", { name: "Kinds" });
    expect(within(grid).getByText("Tasks · 2")).toBeTruthy();
    expect(within(grid).getByText("Links · 1")).toBeTruthy();
    expect(within(grid).getByRole("link", { name: "Fix fence" })).toBeTruthy();
    fireEvent.keyDown(within(grid).getByRole("button", { name: "Move Links" }), { key: "ArrowDown" });
    await waitFor(() => expect(store.get_context(garden).card_places.map((place) => place.id).sort()).toEqual(["kind:link", "kind:task", "x-tasks:t1"]));
    expect(store.get_context(garden).card_places.find((place) => place.id === "x-tasks:t1")).toEqual({ id: "x-tasks:t1", x: 4, y: 0, w: 4, h: 4 });
  });
});

// A conversation kept in the contexts given, with a question and its answer.
function conversation_in(database: DatabaseSync, context_ids: string[], id: string, question: string): string {
  add_conversation_record(database, context_ids[0] ?? null, id);
  for (const context_id of context_ids.slice(1)) bind_methods(() => database, () => undefined).add_item_to_contexts(`conversation:${id}`, [context_id]);
  add_message(database, { conversation_id: id, role: "user", text: question, sources: [] });
  add_message(database, { conversation_id: id, role: "assistant", text: "Here it is.", sources: [] });
  return id;
}

describe("conversations in a context", () => {
  it("list with the other items in every view, each with its icon, title, latest exchange and when it was used, opening in the pane", async () => {
    const database = new DatabaseSync(":memory:");
    const store = fake_page(database);
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" }, "");
    conversation_in(database, [garden], "c1", "Which seeds first?");
    go(`#/context/${garden}`);
    render(<App />);

    const main = await waitFor(() => document.querySelector<HTMLElement>(".main-pane")!);
    expect(await within(main).findByRole("heading", { level: 2, name: "Conversations · 1" })).toBeTruthy();
    const title = within(main).getByRole("link", { name: "Which seeds first?" });
    expect(title.getAttribute("href")).toBe("#/conversation/c1");
    expect(within(main).getByText("You: Which seeds first? · CODEX: Here it is.")).toBeTruthy();
    expect(within(main).getByText(/Last used/)).toBeTruthy();

    fireEvent.click(title);
    const pane = await screen.findByRole("complementary", { name: "Assistant" });
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Conversations" }).textContent).toContain("Which seeds first?"));
    expect(within(pane).getByText("Here it is.")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    const cards = await screen.findByRole("list", { name: "Items" });
    expect(within(cards).getByText("Conversation")).toBeTruthy();
    expect(within(cards).getByRole("link", { name: "Which seeds first?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Grouped" }));
    const kinds = await screen.findByRole("list", { name: "Kinds" });
    expect(within(kinds).getByText("Conversations · 1")).toBeTruthy();
  });

  it("asks before deleting one from its last context, and takes a shared one out of this context alone", async () => {
    const database = new DatabaseSync(":memory:");
    const store = fake_page(database);
    const garden = store.add_context("Garden", null);
    const shed = store.add_context("Shed", null);
    conversation_in(database, [garden], "only", "Only here");
    conversation_in(database, [garden, shed], "shared", "In both");
    go(`#/context/${garden}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "More for In both" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from context" }));
    await waitFor(() => expect(store.list_conversations(garden).map((each) => each.id)).toEqual(["only"]));
    expect(store.list_conversations(shed).map((each) => each.id)).toEqual(["shared"]);

    fireEvent.click(await screen.findByRole("button", { name: "More for Only here" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete conversation…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Only here?" });
    expect(store.list_conversations(garden)).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(() => store.get_conversation("only")).toThrow("There is no conversation"));
  });

  it("moves one to another context, picked from a list", async () => {
    const database = new DatabaseSync(":memory:");
    const store = fake_page(database);
    const garden = store.add_context("Garden", null);
    const shed = store.add_context("Shed", null);
    conversation_in(database, [garden], "c1", "Tools");
    go(`#/context/${garden}`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "More for Tools" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move Tools to" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Shed" }));
    await waitFor(() => expect(store.list_conversations(shed).map((each) => each.id)).toEqual(["c1"]));
    expect(store.list_conversations(garden)).toEqual([]);
  });

  it("opens one by its codex://conversation link on a context holding it, the pane showing it", async () => {
    const database = new DatabaseSync(":memory:");
    const store = fake_page(database);
    const garden = store.add_context("Garden", null);
    conversation_in(database, [garden], "c1", "Seeds");
    conversation_in(database, [garden], "c2", "Fence");
    database.prepare("UPDATE conversation_messages SET created_at = '2030-01-01T00:00:00.000Z' WHERE conversation_id = 'c2' AND role = 'assistant'").run();
    go(route_of_link("codex://conversation/c1")!);
    render(<App />);

    await waitFor(() => expect(window.location.hash).toBe(`#/context/${garden}`));
    const pane = await screen.findByRole("complementary", { name: "Assistant" });
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Conversations" }).textContent).toContain("Seeds"));
  });
});

describe("grouping items", () => {
  it("puts tasks first and kinds it does not know last", () => {
    const item = (kind: string) => ({ kind }) as never;
    expect(group_by_kind([item("widget"), item("link"), item("task"), item("link")]).map(([kind, items]) => [kind, items.length])).toEqual([
      ["task", 1],
      ["link", 2],
      ["widget", 1],
    ]);
  });
});

// ── Filter groups ────────────────────────────────────────────────────────────

const area = { id: "area", label: "Area" };
const area_tag = (id: string, label: string): Feed => ({ id: `tag:${id}`, label, kind: "Tag", group: area });

// What the fake tasks app offers to follow now; tests add to it.
let offered: Feed[] = [];

const grouped_plugin = define_plugin<ContextPluginApi>({
  id: "tests.grouped",
  name: "Grouped",
  version: "1.0.0",
  app: app_info.id,
  start: (context) =>
    context.provide("collector", "grouped", {
      label: "Tasks",
      kinds: ["task"],
      feeds: { list: async () => offered, items: async () => [] },
    }),
});

describe("contexts from a filter group", () => {
  beforeEach(() => {
    offered = [area_tag("home", "Home"), area_tag("garden", "Home/Garden"), area_tag("work", "Work"), { id: "tag:loose", label: "Loose", kind: "Tag" }, { id: "task:k", label: "Kitchen", kind: "Task with subtasks" }];
    use_plugins([links_plugin, grouped_plugin]);
  });

  it("counts a context for each outer feed of a group, and names a tab for each kind", () => {
    expect(groups_of(offered)).toEqual([{ id: "area", label: "Area", count: 2 }]);
    expect(kinds_of(offered).map(plural_of)).toEqual(["Tags", "Tasks with subtasks"]);
    expect(plural_of("Notes")).toBe("Notes");
  });

  it("shows tags, tasks and filter groups on tabs of their own, keeping what was ticked on each", async () => {
    const store = fake_page();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "From another app…" }));
    const tags = await screen.findByRole("list", { name: "Tasks tags" });
    expect(within(tags).getAllByRole("checkbox").map((box) => box.parentElement!.textContent!.trim())).toEqual(["Home · Area", "Home/Garden · Area", "Work · Area", "Loose"]);
    fireEvent.click(within(tags).getByLabelText(/Loose/));

    fireEvent.click(screen.getByRole("radio", { name: "Tasks with subtasks" }));
    const tasks = await screen.findByRole("list", { name: "Tasks tasks with subtasks" });
    expect(within(tasks).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(within(tasks).getByLabelText(/Kitchen/));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make contexts" }));

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name).sort()).toEqual(["Global", "Kitchen", "Loose"]));
  });

  it("makes the group's context from the first page, then offers a tag added to the group later", async () => {
    const store = fake_page();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "From another app…" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Filter groups" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Tasks filter groups" })).getByRole("radio", { name: /Area/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make contexts" }));

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name).sort()).toEqual(["Area", "Global", "Home", "Work"]));
    const made = store.list_contexts(false).find((context) => context.name === "Area")!;
    await waitFor(() => expect(window.location.hash).toBe(`#/context/${made.id}`));

    offered.push(area_tag("health", "Health"));
    cleanup();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add as a context" }));
    await waitFor(() => expect(store.list_contexts(false).filter((context) => context.parent_id === made.id).map((context) => context.name).sort()).toEqual(["Health", "Home", "Work"]));
  });
});
