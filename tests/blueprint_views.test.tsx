// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { ContextMenus } from "@x-tech-laboratories/x-libs/web/react/menus";

import { line_diff } from "../src/shared/blueprints/diff.ts";
import { blueprint_item_id } from "../src/shared/blueprints/model.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { AssistantPane } from "../src/web/assistant/AssistantPane.tsx";
import { BlueprintsPage } from "../src/web/blueprints/BlueprintsPage.tsx";
import { BlueprintView } from "../src/web/blueprints/BlueprintView.tsx";
import { ContextView } from "../src/web/contexts/ContextView.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  cleanup();
  await wait_for_runs();
  use_assistant_host(null);
});

function open_page(): Fixture {
  const fixture = start_fixture();
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return fixture;
}

const maker = { engine: "fake", model: "fake-model", sources: [] };

describe("line_diff", () => {
  it("keeps, adds and takes away lines by their longest common run", () => {
    expect(line_diff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(line_diff("", "x")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "x" },
    ]);
  });
});

describe("the Blueprints page", () => {
  it("lists what waits, accepted in place, and those that apply everywhere and in contexts", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_blueprint("Weekly review", "When the user asks for the weekly review.", "1. List open tasks.");
    fixture.calls.add_blueprint("Dishes", "When the dishes pile up.", "1. Run the dishwasher.", kitchen);
    const proposed = fixture.calls.propose_blueprint("Sort the mail", "When sorting the inbox.", "1. **Receipts** to Taxes.", null, maker);
    render(
      <>
        <BlueprintsPage />
        <Dialogs />
      </>,
    );
    const card = await screen.findByRole("article", { name: "Proposed blueprint: Sort the mail" });
    expect(within(card).getByText("Receipts")).toBeTruthy();
    expect(screen.getByText("Weekly review")).toBeTruthy();
    expect(screen.getByText("Dishes")).toBeTruthy();
    expect(screen.getByText("In contexts · 1")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.get_blueprint(proposed.id).status).toBe("active"));

    fireEvent.click(screen.getByRole("button", { name: /New blueprint/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Plan meals" } });
    fireEvent.change(within(dialog).getByLabelText("Applies when"), { target: { value: "When planning the week's meals." } });
    expect(within(dialog).getByText("Applies everywhere")).toBeTruthy();
    // Without its rules and steps it is not written.
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(fixture.calls.list_blueprints().map((each) => each.title)).not.toContain("Plan meals"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("a blueprint in the workspace", () => {
  it("is edited and saved, shows a proposed change as what differs, and is retired and placed", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_blueprint("Sort the mail", "When sorting the inbox.", "1. Read.\n2. File.", kitchen);
    fixture.calls.propose_blueprint_change(id, "1. Read.\n2. File.\n3. Archive.", "Archive as well.", undefined, undefined, maker);
    render(
      <>
        <BlueprintView id={id} />
        <Dialogs />
      </>,
    );
    const change = await screen.findByRole("article", { name: "Proposed change to the blueprint “Sort the mail”" });
    expect(within(change).getByLabelText("What would change").textContent).toContain("+ 3. Archive.");
    expect(within(change).getByText("Why: Archive as well.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sort the post" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fixture.calls.get_blueprint(id).title).toBe("Sort the post"));

    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(fixture.calls.get_blueprint(id).status).toBe("retired"));
    fireEvent.change(screen.getByLabelText("Where it applies"), { target: { value: "" } });
    await waitFor(() => expect(fixture.calls.get_blueprint(id).contexts).toEqual([]));
  });

  it("makes a proposed one active when the user saves an edit of it", async () => {
    const fixture = open_page();
    const proposed = fixture.calls.propose_blueprint("Sort the mail", "When sorting the inbox.", "1. Read.", null, maker);
    render(<BlueprintView id={proposed.id} />);
    await screen.findByRole("article", { name: "Proposed blueprint: Sort the mail" });
    fireEvent.change(screen.getByLabelText("Applies when"), { target: { value: "When sorting the post." } });
    fireEvent.click(screen.getByRole("button", { name: "Save and make active" }));
    await waitFor(() => expect(fixture.calls.get_blueprint(proposed.id)).toMatchObject({ status: "active", applies_when: "When sorting the post." }));
  });
});

describe("blueprints elsewhere", () => {
  it("list in their context with their own icon, opening in the workspace", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_blueprint("Dishes", "When the dishes pile up.", "1. Run it.", kitchen);
    render(<ContextView id={kitchen} />);
    const link = await screen.findByRole("link", { name: "Dishes" });
    expect(link.getAttribute("href")).toBe(`#/blueprint/${id}`);
    expect(screen.getByText("Blueprints · 1")).toBeTruthy();
    expect(fixture.calls.get_item(blueprint_item_id(id)).kind).toBe("blueprint");
  });

  it("show in the pane as cards for the blueprints its conversation proposed, and Save as blueprint asks for one", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Sort my mail");
    await wait_for_runs();
    fixture.calls.propose_blueprint("Sort the mail", "When sorting the inbox.", "1. Read.", kitchen, { ...maker, conversation_id } as never);
    render(
      <>
        <AssistantPane context_id={kitchen} />
        <Dialogs />
        <ContextMenus />
      </>,
    );
    const card = await screen.findByRole("article", { name: "Proposed blueprint: Sort the mail" });
    expect(within(card).getByRole("link", { name: "Open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More for this conversation" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save as blueprint" }));
    await waitFor(() => expect(fixture.requests.length).toBe(2));
  });
});
