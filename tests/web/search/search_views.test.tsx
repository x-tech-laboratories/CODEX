// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { add_message } from "../../../src/shared/conversations/messages.ts";
import { add_conversation_record } from "../../../src/shared/conversations/records.ts";
import { wanted_conversation } from "../../../src/web/assistant/selection.ts";
import { index_now, open_index, settle_index, use_search_index } from "../../../src/shared/search/indexer.ts";
import type { IndexState, SearchHit } from "../../../src/shared/search/model.ts";
import type { ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { group_hits, HomeView } from "../../../src/web/contexts/HomeView.tsx";
import { row_icon } from "../../../src/web/contexts/kinds.tsx";
import { forget_page_plugins } from "../../../src/web/plugins/plugins.tsx";
import { embedding_words, held_words, StateRows } from "../../../src/web/search/IndexSettings.tsx";
import { SettingsView } from "../../../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

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
    add_conversation_record(fixture.database, kitchen, "c1");
    fixture.calls.rename_conversation("c1", "Floor plans");
    add_message(fixture.database, { conversation_id: "c1", role: "user", text: "Remind me about the grout." });
    add_message(fixture.database, { conversation_id: "c1", role: "assistant", text: "The grout is grey.", sources: [] });
    await index_now();
    render(<HomeView />);

    fireEvent.change(await screen.findByLabelText("Search everything kept"), { target: { value: "grout" } });
    const found = (await screen.findByText("Found")).closest("section")!;
    const link = await within(found).findByRole("link", { name: "Grout guide" });
    expect(link.getAttribute("href")).toBe("https://example.org/grout");
    expect(within(found).getByRole("link", { name: "Kitchen" }).getAttribute("href")).toBe(`#/context/${kitchen}`);
    // Messages are gathered under their conversation, which opens in the pane on a context holding it.
    const in_conversation = within(found).getByRole("link", { name: "Floor plans" });
    expect(in_conversation.getAttribute("href")).toBe("#/conversation/c1");
    expect(in_conversation.closest(".item-title")!.textContent).toBe("Floor plans2 messages");
    const row = in_conversation.closest("li")!;
    expect(within(row).getByText(/^You: Remind me about the grout/)).toBeTruthy();
    expect(within(row).getByText(/^Assistant: The grout is grey/)).toBeTruthy();
    fireEvent.click(in_conversation);
    expect(wanted_conversation()).toEqual({ context_id: kitchen, id: "c1" });
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
    expect(await within(section).findByText("0 items, 2 contexts and 0 messages.")).toBeTruthy();
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
      last_error_detail: "",
    };
    expect(held_words(state)).toBe("1 item, 2 contexts and 3 messages.");
    expect(embedding_words(state)).toBe("4 of 7 pieces of text embedded; 3 waiting; 3 never sent, since the embedder is hosted and their sources are not marked for hosted engines.");
    expect(embedding_words({ ...state, embedder: null, embedder_problem: "The x embedder is not running." })).toBe("The x embedder is not running.");

    // The last problem in plain words, its raw text folded behind Details.
    const { container } = render(<StateRows state={{ ...state, last_error: "The embedder at 127.0.0.1:9 cannot be reached.", last_error_detail: "fetch failed (ECONNREFUSED)" }} />);
    expect(screen.getByText("Last problem")).toBeTruthy();
    expect(screen.getByText("The embedder at 127.0.0.1:9 cannot be reached.")).toBeTruthy();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Details")).toBeTruthy();
    expect(within(details).getByText("fetch failed (ECONNREFUSED)")).toBeTruthy();
    cleanup();
    render(<StateRows state={{ ...state, is_working: true, pending: 0, withheld: 0, embedder: { ...state.embedder!, is_local: true } }} />);
    expect(screen.queryByText("Last problem")).toBeNull();
    expect(screen.getByText("Indexing now…")).toBeTruthy();
    expect(screen.getByText("E, m, local.")).toBeTruthy();
    expect(screen.getByText("4 of 10 pieces of text embedded.")).toBeTruthy();
  });
});

describe("gathering what was found", () => {
  const hit = (kind: SearchHit["kind"], id: string, extra: Partial<SearchHit> = {}): SearchHit => ({ kind, id, title: id, excerpt: "", collector: "", item_kind: "", uri: "", where: [], conversation: null, sources: [], matched_by: ["words"], score: 1, ...extra });

  it("gathers a conversation's own item and its messages in one row where the first ranked, leaving the rest in order", () => {
    const chat = { id: "c1", title: "Floor plans" };
    const entries = group_hits([
      hit("message", "m1", { conversation: chat }),
      hit("item", "x-tasks:t1", { item_kind: "task" }),
      hit("item", "conversation:c1", { item_kind: "conversation", title: "Floor plans" }),
      hit("message", "m2", { conversation: chat }),
      hit("message", "m3"),
    ]);

    expect(entries.map((entry) => ("hit" in entry ? entry.hit.id : `${entry.conversation.id}:${entry.messages.map((message) => message.id).join(",")}`))).toEqual(["c1:m1,m2", "x-tasks:t1", "m3"]);
  });

  it("marks a task's row open or done apart from the task kind's icon", () => {
    expect(row_icon("task", "")).toMatchObject({ label: "Open task" });
    expect(row_icon("task", "done")).toMatchObject({ label: "Done task" });
    expect(row_icon("task", "done").icon).not.toBe(row_icon("task", "").icon);
    expect(row_icon("note", "done").label).toBeUndefined();
  });
});
