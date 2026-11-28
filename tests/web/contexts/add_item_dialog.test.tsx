// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { email_plugin, links_plugin } from "../../../src/shared/collectors/bundled.ts";
import { app_info } from "../../../src/shared/collectors/collector.ts";
import { use_plugins, type ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { bind_methods, open_store, type ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { add_item_dialog } from "../../../src/web/contexts/AddItemDialog.tsx";

// A collector that finds tasks by their title, and whose app is down when asked for "down".
const tasks_plugin = define_plugin<ContextPluginApi>({
  id: "tests.tasks",
  name: "Tasks",
  version: "1.0.0",
  app: app_info.id,
  start: (context) =>
    context.provide("collector", "tasks", {
      label: "Tasks",
      kinds: ["task"],
      search: async (query: string) => {
        if (query === "down") throw new Error("Tasks is down");
        const all = [
          { source_id: "t1", kind: "task", title: "Order seeds", snippet: "From the catalogue" },
          { source_id: "t2", kind: "task", title: "Sow seeds" },
        ];
        return all.filter((task) => task.title.toLowerCase().includes(query.toLowerCase()));
      },
    }),
});

function fake_page(): ContextMethods {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const methods = bind_methods(() => database, () => undefined);
  const calls = Object.fromEntries(Object.entries(methods).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "desktop", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return methods;
}

function open(context_id: string) {
  render(<Dialogs />);
  act(() => add_item_dialog(context_id, "Garden"));
}

function search(text: string) {
  const box = screen.getByRole("searchbox", { name: "Search Tasks" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => use_plugins([tasks_plugin, links_plugin, email_plugin]));

afterEach(() => {
  // Open dialogs are kept apart from what is rendered, so each test closes its own.
  for (const done of screen.queryAllByRole("button", { name: "Done" })) fireEvent.click(done);
  cleanup();
  use_plugins([]);
});

describe("adding items to a context", () => {
  it("searches the collector's app and adds what is picked, marking what the context holds", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.add_item([garden], "tasks", { source_id: "t2", kind: "task", title: "Sow seeds" }, "");
    open(garden);

    expect(await screen.findByRole("radiogroup", { name: "Collector" })).toBeTruthy();
    search("seeds");
    const list = await screen.findByRole("list");
    expect(within(list).getByText("From the catalogue")).toBeTruthy();
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Add", "Added"]);

    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["Added", "Added"]));
    expect(store.get_context(garden).items.map((item) => item.title).sort()).toEqual(["Order seeds", "Sow seeds"]);
  });

  it("says when nothing is found, and when the app could not answer", async () => {
    const store = fake_page();
    open(store.add_context("Garden", null));
    await screen.findByRole("radiogroup", { name: "Collector" });

    search("fence");
    expect(await screen.findByText("Nothing found")).toBeTruthy();
    search("");
    await waitFor(() => expect(screen.queryByText("Nothing found")).toBeNull());
    search("down");
    expect((await screen.findByText("Tasks is down")).getAttribute("role")).toBe("alert");
  });

  it("takes an item typed in by hand, once what it needs is given", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    open(garden);

    fireEvent.click(await screen.findByRole("radio", { name: "Web links" }));
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://example.org/seeds" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Cheapest" } });
    fireEvent.click(add);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.get_context(garden).items[0]).toMatchObject({ title: "example.org", note: "Cheapest" });
  });

  it("says how items reach a collector that takes them from elsewhere", async () => {
    const store = fake_page();
    open(store.add_context("Garden", null));
    fireEvent.click(await screen.findByRole("radio", { name: "Email" }));
    expect(screen.getByText(/install the CODEX add-on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when no collector runs", async () => {
    use_plugins([]);
    const store = fake_page();
    open(store.add_context("Garden", null));
    expect(await screen.findByText("No collectors running")).toBeTruthy();
  });
});
