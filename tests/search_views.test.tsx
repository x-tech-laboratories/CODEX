// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message } from "../src/shared/conversations/messages.ts";
import { index_now, open_index, settle_index, use_search_index } from "../src/shared/search/indexer.ts";
import type { IndexState } from "../src/shared/search/model.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { HomeView } from "../src/web/contexts/HomeView.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { embedding_words, held_words } from "../src/web/search/IndexSettings.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  cleanup();
  forget_page_plugins();
  await settle_index();
  use_search_index(null);
  use_assistant_host(null);
});

function open_page(): { fixture: Fixture; calls_made: string[] } {
  const fixture = start_fixture();
  const index = new DatabaseSync(":memory:");
  open_index(index);
  use_search_index({ database: () => fixture.database, index: () => index });
  const calls_made: string[] = [];
  const calls = Object.fromEntries(
    Object.entries(fixture.calls).map(([name, call]) => [
      name,
      async (...args: unknown[]) => {
        calls_made.push(name);
        return (call as (...args: unknown[]) => unknown)(...args);
      },
    ]),
  );
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return { fixture, calls_made };
}

describe("the first page's search", () => {
  it("finds items, contexts and messages through the index, each with its excerpt and where it is", async () => {
    const { fixture } = open_page();
    const home = fixture.calls.add_context("Home");
    const kitchen = fixture.calls.add_context("Kitchen", home);
    fixture.calls.set_context_notes(kitchen, "Grout colour to choose.");
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org/grout", kind: "link", title: "Grout guide", uri: "https://example.org/grout", snippet: "Which grout for wet rooms" });
    add_message(fixture.database, { conversation_id: "general", role: "user", text: "Remind me about the grout." });
    await index_now();
    render(<HomeView />);

    fireEvent.change(await screen.findByLabelText("Search everything kept"), { target: { value: "grout" } });
    const found = (await screen.findByText("Found")).closest("section")!;
    const link = await within(found).findByRole("link", { name: "Grout guide" });
    expect(link.getAttribute("href")).toBe("https://example.org/grout");
    expect(within(found).getByRole("link", { name: "Kitchen" }).getAttribute("href")).toBe(`#/context/${kitchen}`);
    expect(within(found).getByText("You, in a conversation")).toBeTruthy();
    expect(within(found).getByText("General conversation")).toBeTruthy();
    expect(within(found).getByText("Which grout for wet rooms")).toBeTruthy();
    expect(within(found).getAllByText("Home").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Search everything kept"), { target: { value: "zebra" } });
    expect(await screen.findByText("Nothing matches")).toBeTruthy();
  });
});

describe("Settings → Index", () => {
  it("shows what is indexed, chooses an embedder, and rebuilds only once confirmed", async () => {
    const { fixture, calls_made } = open_page();
    fixture.calls.add_context("Home");
    await index_now();
    render(
      <>
        <SettingsView />
        <Dialogs />
      </>,
    );

    const section = (await screen.findByRole("heading", { name: "Index" })).closest("section")!;
    expect(await within(section).findByText("0 items, 1 context and 0 messages.")).toBeTruthy();
    expect(within(section).getByText("No embedder is chosen, so search finds words only.")).toBeTruthy();
    expect(within(section).getByText("OpenAI-compatible embeddings")).toBeTruthy();
    const choice = within(section).getByLabelText("Embedder") as HTMLSelectElement;
    expect([...choice.options].map((option) => option.text)).toEqual(["None: words only"]);
    fireEvent.change(choice, { target: { value: "" } });

    fireEvent.click(within(section).getByRole("button", { name: "Rebuild…" }));
    expect(calls_made).not.toContain("rebuild_index");
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(calls_made).toContain("rebuild_index"));
    await settle_index();
  });

  it("says how far embedding has come in plain words", () => {
    const state: IndexState = {
      items: 1,
      contexts: 2,
      messages: 3,
      chunks: 10,
      embedded: 4,
      pending: 3,
      withheld: 3,
      embedder: { id: "e", label: "E", model: "m", dimensions: 8, is_local: false },
      embedder_problem: "",
      embedders: [],
      is_working: false,
      last_indexed_at: "",
      last_error: "",
    };
    expect(held_words(state)).toBe("1 item, 2 contexts and 3 messages.");
    expect(embedding_words(state)).toBe("4 of 7 pieces of text embedded; 3 waiting; 3 never sent, since the embedder is hosted and their sources are not marked for hosted engines.");
    expect(embedding_words({ ...state, embedder: null, embedder_problem: "The x embedder is not running." })).toBe("The x embedder is not running.");
  });
});
