// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { app_info, type Feed } from "../src/shared/collectors/collector.ts";
import { links_plugin } from "../src/shared/collectors/bundled.ts";
import { use_plugins, type ContextPluginApi } from "../src/shared/collectors/host.ts";
import { bind_methods, open_store, type ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { App } from "../src/web/App.tsx";
import { group_by_kind } from "../src/web/contexts/ContextView.tsx";
import { groups_of, kinds_of, plural_of } from "../src/web/contexts/FeedDialogs.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";

// The page's calls answered by a real store on a throwaway database, as the desktop app would, which needs no sign-in.
function fake_page(): ContextMethods {
  const database = new DatabaseSync(":memory:");
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

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name)).toEqual(["Taxes"]));
    expect(window.location.hash).toBe(`#/context/${store.list_contexts(false)[0]!.id}`);
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

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name).sort()).toEqual(["Kitchen", "Loose"]));
  });

  it("makes the group's context from the first page, then offers a tag added to the group later", async () => {
    const store = fake_page();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "From another app…" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Filter groups" }));
    fireEvent.click(within(await screen.findByRole("list", { name: "Tasks filter groups" })).getByRole("radio", { name: /Area/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make contexts" }));

    await waitFor(() => expect(store.list_contexts(false).map((context) => context.name).sort()).toEqual(["Area", "Home", "Work"]));
    const made = store.list_contexts(false).find((context) => context.name === "Area")!;
    await waitFor(() => expect(window.location.hash).toBe(`#/context/${made.id}`));

    offered.push(area_tag("health", "Health"));
    cleanup();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add as a context" }));
    await waitFor(() => expect(store.list_contexts(false).filter((context) => context.parent_id === made.id).map((context) => context.name).sort()).toEqual(["Health", "Home", "Work"]));
  });
});
