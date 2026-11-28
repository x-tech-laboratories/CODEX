// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { DatabaseSync } from "node:sqlite";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { bind_methods, open_store, type ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { HistoryButton, HistoryView } from "../../../src/web/history/HistoryView.tsx";

// The page's calls answered by a real store on a throwaway database, telling the page after every write.
function fake_page(): ContextMethods {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const listeners = new Set<() => void>();
  const methods = bind_methods(() => database, () => listeners.forEach((listener) => listener()));
  const calls = Object.fromEntries(Object.entries(methods).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({
    host: "desktop",
    calls: calls as unknown as Client<ContextMethods>,
    device: null,
    on_change: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    on_conversation: () => () => undefined,
  });
  return methods;
}

afterEach(cleanup);

describe("the History page", () => {
  it("shows only Global, first seen, before anything has changed", async () => {
    fake_page();
    render(<HistoryView />);
    expect(await screen.findByText("Global")).toBeTruthy();
    expect(screen.queryByText("No changes yet.")).toBeNull();
  });

  it("lists the latest changes, and brings a deleted context back", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.remove_context(garden);
    render(<><HistoryView /><Dialogs /></>);

    const table = await screen.findByRole("table", { name: "Latest changes" });
    expect(within(table).getAllByText("Garden").length).toBeGreaterThan(0);
    expect(within(table).getByText("Deleted")).toBeTruthy();
    expect(within(table).getAllByText("Here").length).toBeGreaterThan(0);

    fireEvent.click(within(table).getByRole("button", { name: "Bring back" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Bring back Garden?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(store.list_contexts().map((context) => context.name)).toEqual(["Garden", "Global"]));
  });

  it("shows more changes when asked", async () => {
    const store = fake_page();
    store.add_context("Garden", null);
    render(<HistoryView />);
    await screen.findByRole("table", { name: "Latest changes" });
    fireEvent.change(screen.getByLabelText("Changes shown"), { target: { value: "200" } });
    expect(await screen.findByRole("table", { name: "Latest changes" })).toBeTruthy();
  });

  it("opens one context's versions, and restores an earlier one", async () => {
    const store = fake_page();
    const garden = store.add_context("Garden", null);
    store.rename_context(garden, "Back garden");
    render(<><HistoryButton kind="context" item_id={garden} name="Back garden" /><Dialogs /></>);

    fireEvent.click(screen.getByRole("button", { name: "History of Back garden" }));
    const table = await screen.findByRole("table", { name: "History of Back garden" });
    const restores = within(table).getAllByRole("button", { name: "Restore" });
    expect(restores).toHaveLength(1);
    fireEvent.click(restores[0]!);
    expect(await screen.findByText("Restore Garden?")).toBeTruthy();
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    fireEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(store.list_contexts()[0]!.name).toBe("Garden"));
  });
});
