// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

// force-graph draws on a canvas jsdom lacks, so a fake keeps what the widget hands it.
const drawings: { calls: Record<string, unknown[][]> }[] = [];
vi.mock("force-graph", () => ({
  default: class {
    calls: Record<string, unknown[][]> = {};
    constructor() {
      drawings.push(this);
      return new Proxy(this, {
        get: (target, name: string) =>
          name in target
            ? (target as unknown as Record<string, unknown>)[name]
            : (...args: unknown[]) => {
                (target.calls[name] ??= []).push(args);
                return name === "zoom" && args.length === 0 ? 1 : name === "centerAt" && args.length === 0 ? { x: 0, y: 0 } : target;
              },
      });
    }
  },
}));

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import { index_now, open_index, settle_index, use_search_index } from "../src/shared/search/indexer.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { wanted_conversation } from "../src/web/assistant/selection.ts";
import { ContextView } from "../src/web/contexts/ContextView.tsx";
import { GraphPage, graph_href } from "../src/web/graph/GraphPage.tsx";
import { drawn, kinds_of, maker_text, type_name } from "../src/web/graph/look.ts";
import { open_node } from "../src/web/graph/NodePanel.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

beforeEach(() => {
  drawings.length = 0;
});

afterEach(async () => {
  cleanup();
  await wait_for_runs();
  await settle_index();
  use_search_index(null);
  use_assistant_host(null);
});

function open_page(): Fixture {
  const fixture = start_fixture();
  const index = new DatabaseSync(":memory:");
  open_index(index);
  use_search_index({ database: () => fixture.database, index: () => index });
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return fixture;
}

// A garden with a task, a seed shop and Ada, an engine's proposals among them.
async function garden_of(fixture: Fixture) {
  const garden = fixture.calls.add_context("Garden");
  const seeds = fixture.calls.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" });
  const shop = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop", uri: "https://example.org/seeds" });
  const ada = fixture.calls.add_entity("person", "Ada");
  fixture.calls.add_graph_link(seeds, `entity:${ada}`, "mentions");
  const maker = { engine: "fake", model: "fake-model", sources: [] };
  const company = await fixture.calls.propose_entity("organisation", "Seed Co", [], { item_id: shop, excerpt: "Seeds from Seed Co" }, maker);
  const about = await fixture.calls.propose_link(shop, `entity:${company.id}`, "about", "", { item_id: shop }, maker);
  const related = await fixture.calls.propose_link(seeds, shop, "related_to", "", null, maker);
  fixture.calls.set_context_view(garden, "graph");
  return { garden, seeds, shop, ada, company: company.id, about: about.id, related: related.id };
}

// What the drawing was last given.
function drawn_data(): { nodes: { id: string; data: { label: string } }[]; links: { id: string; data: { style?: string } }[] } {
  const calls = drawings.at(-1)!.calls.graphData!;
  return calls.at(-1)![0] as never;
}

async function drawing_ready(): Promise<void> {
  await waitFor(() => expect(drawings.at(-1)?.calls.graphData).toBeTruthy());
}

function callback(name: string): (...args: unknown[]) => void {
  return drawings.at(-1)!.calls[name]!.at(-1)![0] as (...args: unknown[]) => void;
}

describe("a context's Graph view", () => {
  it("draws the context, its items, their entities and links, proposed ones dashed, with the proposals and their evidence", async () => {
    const fixture = open_page();
    const { garden, about } = await garden_of(fixture);
    render(<ContextView id={garden} />);
    await drawing_ready();
    expect(screen.getByRole("radio", { name: "Graph" }).getAttribute("aria-checked")).toBe("true");
    const labels = drawn_data().nodes.map((node) => node.data.label).sort();
    expect(labels).toEqual(["Ada", "Garden", "Order seeds", "Seed Co", "Seed shop"]);
    expect(drawn_data().links.find((link) => link.id === about)!.data.style).toBe("dashed");
    expect(screen.getByRole("img", { name: "Graph of Garden" })).toBeTruthy();

    const proposed = screen.getByRole("list", { name: "Proposed links" });
    expect(within(proposed).getAllByRole("listitem")).toHaveLength(3);
    expect(proposed.textContent).toContain("By fake (fake-model); from Seed shop");
    // The shop is not marked to leave this computer, so its excerpt was not kept.
    expect(proposed.textContent).not.toContain("Seeds from Seed Co");
  });

  it("accepts a link from the graph and rejects one from the list, and accepts the rest after asking", async () => {
    const fixture = open_page();
    const { garden, seeds, about, related, company } = await garden_of(fixture);
    render(
      <>
        <ContextView id={garden} />
        <Dialogs />
      </>,
    );
    await drawing_ready();
    act(() => callback("onLinkClick")({ id: related }));
    const chosen = await screen.findByRole("region", { name: "The link chosen" });
    fireEvent.click(within(chosen).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.get_node_links(seeds).links.find((link) => link.id === related)!.status).toBe("accepted"));

    const proposed = await screen.findByRole("list", { name: "Proposed links" });
    await waitFor(() => expect(within(proposed).getAllByRole("listitem")).toHaveLength(2));
    const row = within(proposed).getAllByRole("listitem").find((each) => each.textContent!.includes("about"))!;
    fireEvent.click(within(row).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fixture.calls.list_graph_proposals(garden).links).toHaveLength(0));
    expect(fixture.calls.get_node_links(company).links.find((link) => link.id === about)!.status).toBe("rejected");

    await waitFor(() => expect(within(screen.getByRole("list", { name: "Proposed links" })).getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Choose Seed Co" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Accept 1 proposal?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.list_graph_proposals()).toEqual({ links: [], entities: [] }));
    expect(fixture.calls.list_graph_decision_counts()).toMatchObject([{ engine: "fake", accepted: 2, rejected: 1 }]);
    await screen.findByText("Nothing is waiting for you.");
  });

  it("filters by kind of node, type and status of link, and shows everything when asked", async () => {
    const fixture = open_page();
    const { garden } = await garden_of(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/tiles", kind: "link", title: "Tiles" });
    render(<ContextView id={garden} />);
    await drawing_ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "Entities" }));
    await waitFor(() => expect(drawn_data().nodes.map((node) => node.data.label)).not.toContain("Ada"));
    fireEvent.click(screen.getByRole("radio", { name: "Accepted" }));
    await waitFor(() => expect(drawn_data().links.every((link) => link.data.style !== "dashed")).toBe(true));
    fireEvent.change(screen.getByLabelText("Links"), { target: { value: "mentions" } });
    fireEvent.click(screen.getByRole("switch", { name: "Show everything" }));
    await waitFor(() => expect(drawn_data().nodes.map((node) => node.data.label)).toContain("Tiles"));
  });

  it("shows what a node is in the workspace, links it to another picked through search, and works an entity", async () => {
    const fixture = open_page();
    const { garden, seeds, ada } = await garden_of(fixture);
    const bob = fixture.calls.add_entity("person", "Bob");
    fixture.calls.add_graph_link(seeds, `entity:${bob}`, "mentions");
    await index_now();
    render(
      <>
        <ContextView id={garden} />
        <Dialogs />
      </>,
    );
    await drawing_ready();
    // Opening an entity, which has nowhere to open, shows it beside the drawing.
    act(() => callback("onNodeClick")({ id: `entity:${ada}` }, { detail: 2 }));
    const about = await screen.findByRole("region", { name: "About Ada" });
    expect(about.textContent).toContain("Person");
    expect(about.textContent).toContain("Order seeds");

    // Join with Bob, found by search, then undo the join.
    fireEvent.click(within(about).getByRole("button", { name: "Join with…" }));
    fireEvent.change(within(about).getByLabelText("Find the entity it is the same as"), { target: { value: "bob" } });
    fireEvent.click(await within(about).findByRole("button", { name: "Bob" }));
    await waitFor(() => expect(fixture.calls.get_node_links(bob).node.key).toBe(`entity:${ada}`));
    fireEvent.click(await screen.findByRole("button", { name: "Undo join" }));
    await waitFor(() => expect(fixture.calls.get_node_links(bob).node.key).toBe(`entity:${bob}`));

    // Link to the seed shop, picked through search.
    const panel = await screen.findByRole("region", { name: "About Ada" });
    fireEvent.change(within(panel).getByLabelText("Find what to link to"), { target: { value: "seed shop" } });
    fireEvent.click(await within(panel).findByRole("button", { name: "Seed shop" }));
    await waitFor(() => expect(fixture.calls.get_node_links(ada).links.map((link) => link.other.label).sort()).toEqual(["Order seeds", "Seed shop"]));

    // Close a link, rename the entity, then remove it after asking.
    const row = (await within(panel).findAllByRole("listitem")).find((each) => each.textContent!.includes("Seed shop") && each.querySelector("button"))!;
    fireEvent.click(within(row).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(fixture.calls.get_node_links(ada).links.find((link) => link.other.label === "Seed shop")!.valid_until).not.toBe(""));
    fireEvent.click(within(panel).getByRole("button", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog");
    fireEvent.change(within(rename).getByLabelText("Name"), { target: { value: "Ada L" } });
    fireEvent.change(within(rename).getByLabelText("Other names, with commas between"), { target: { value: "Ada, Countess" } });
    fireEvent.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fixture.calls.get_node_links(ada).node).toMatchObject({ label: "Ada L", alt_names: ["Ada", "Countess"] }));
    fireEvent.click(within(await screen.findByRole("region", { name: "About Ada L" })).getAllByRole("button", { name: "Remove" })[0]!);
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(() => fixture.calls.get_node_links(ada)).toThrow());
  });

  it("puts a link count on each linked item, opening the graph on it, and Suggest links opens the pane on its run", async () => {
    const fixture = open_page();
    const { garden, seeds } = await garden_of(fixture);
    fixture.calls.set_context_view(garden, "list");
    render(<ContextView id={garden} />);
    const counts = await screen.findAllByRole("link", { name: "2 links" });
    expect(counts.map((count) => count.getAttribute("href"))).toContain(graph_href(`item:${seeds}`));
    fireEvent.click(screen.getByRole("button", { name: "Suggest links" }));
    await waitFor(() => expect(wanted_conversation()).toMatchObject({ context_id: garden }));
    const conversation = fixture.calls.get_conversation(wanted_conversation()!.id);
    expect(conversation.messages[0]!.text).toContain("Suggest links for this context.");
  });
});

describe("working the graph by hand", () => {
  it("adds an entity, opens a node from the list, chooses a link's end, and rejects a ticked selection after asking", async () => {
    const fixture = open_page();
    const { garden, seeds, related } = await garden_of(fixture);
    render(
      <>
        <ContextView id={garden} />
        <Dialogs />
      </>,
    );
    await drawing_ready();
    fireEvent.click(screen.getByRole("button", { name: "New entity…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Kind"), { target: { value: "place" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Allotment" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("region", { name: "About Allotment" })).toBeTruthy();
    expect(fixture.calls.get_graph(null, { node_types: ["place"] }).nodes.map((node) => node.label)).toEqual(["Allotment"]);
    fireEvent.click(within(screen.getByRole("region", { name: "About Allotment" })).getByRole("button", { name: "Close" }));
    await screen.findByText("Choose a node or a link to see what it is and what it is linked to.");

    // A link's end, chosen from the link, shows that node; a structure line chooses nothing.
    act(() => callback("onLinkClick")({ id: `structure:context:${garden}>item:${seeds}` }));
    act(() => callback("onLinkClick")({ id: related }));
    const chosen = await screen.findByRole("region", { name: "The link chosen" });
    fireEvent.click(within(chosen).getByRole("button", { name: "Seed shop" }));
    expect(await screen.findByRole("region", { name: "About Seed shop" })).toBeTruthy();
    act(() => callback("onLinkClick")({ id: related }));
    fireEvent.click(within(await screen.findByRole("region", { name: "The link chosen" })).getByRole("button", { name: "Close" }));

    // Every proposal ticked at once, then rejected together after asking.
    fireEvent.click(screen.getByRole("checkbox", { name: "Choose Seed Co" }));
    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain("Reject 3 proposals?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fixture.calls.list_graph_proposals()).toEqual({ links: [], entities: [] }));
    expect(fixture.calls.list_graph_decision_counts()).toMatchObject([{ rejected: 3 }]);
  });
});

describe("the Graph page", () => {
  it("draws the whole graph, finds a node by name and shows it, opening on a node asked for", async () => {
    const fixture = open_page();
    const { seeds } = await garden_of(fixture);
    fixture.calls.add_context("Kitchen");
    render(<GraphPage focus={`item:${seeds}`} />);
    await drawing_ready();
    expect(drawn_data().nodes.map((node) => node.data.label)).toContain("Kitchen");
    expect(await screen.findByRole("region", { name: "About Order seeds" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find a node"), { target: { value: "seed c" } });
    fireEvent.keyDown(screen.getByLabelText("Find a node"), { key: "Enter" });
    expect(await screen.findByRole("region", { name: "About Seed Co" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find a node"), { target: { value: "nothing like it" } });
    expect(screen.getByText("No node by that name is shown.")).toBeTruthy();
  });
});

describe("how graph things are named", () => {
  it("names kinds and makers, and draws structure as plain lines", async () => {
    expect(type_name({ kind: "context", type: "context" })).toBe("Context");
    expect(type_name({ kind: "entity", type: "organisation" })).toBe("Organisation");
    expect(type_name({ kind: "item", type: "task" })).toBe("Task");
    expect(maker_text({ made_by: "user", rule: "", engine: "", model: "" })).toBe("you");
    expect(maker_text({ made_by: "program", rule: "", engine: "", model: "" })).toBe("a program, through a token or MCP");
    expect(maker_text({ made_by: "rule", rule: "parent", engine: "", model: "" })).toBe("a rule: its app names its parent");
    expect(maker_text({ made_by: "rule", rule: "new", engine: "", model: "" })).toBe("a rule (new)");
    expect(maker_text({ made_by: "similarity", rule: "", engine: "e", model: "m" })).toBe("similarity of meaning (m)");
    expect(maker_text({ made_by: "engine", rule: "", engine: "", model: "" })).toBe("a program");
    const fixture = open_page();
    const { garden } = await garden_of(fixture);
    const view = fixture.calls.get_graph(garden);
    expect(kinds_of(view.nodes).map((kind) => kind.label)).toEqual(["Context", "Link", "Task", "Organisation", "Person"]);
    expect(drawn(view).links.filter((link) => link.id.startsWith("structure:")).every((link) => link.tone === "neutral")).toBe(true);

    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => (opened.push(String(url)), null));
    open_node({ kind: "context", id: garden, type: "context", uri: "" });
    expect(window.location.hash).toBe(`#/context/${garden}`);
    open_node({ kind: "item", id: "conversation:c1", type: "conversation", uri: "" });
    expect(window.location.hash).toBe("#/conversation/c1");
    open_node({ kind: "item", id: "links:x", type: "link", uri: "https://example.org" });
    expect(opened).toEqual(["https://example.org"]);
  });
});
