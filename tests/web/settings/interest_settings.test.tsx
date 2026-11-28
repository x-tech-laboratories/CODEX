// @vitest-environment jsdom
// Settings → Assistant → Interests: the list with states, accepting with the exact topic shown and editable, pausing,
// dropping, adding one, and the cap; and a proposed interest in the Inbox, accepted only through the same dialog.
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import type { Interest } from "../../../src/shared/interests/model.ts";
import type { ContextMethods } from "../../../src/shared/store.ts";
import { data_watch, set_page_api } from "../../../src/web/api.ts";
import { InboxPage } from "../../../src/web/inbox/InboxPage.tsx";
import { interest_hint } from "../../../src/web/interests/InterestSettings.tsx";
import { forget_page_plugins } from "../../../src/web/plugins.tsx";
import { SettingsView } from "../../../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_assistant_host(null);
});

function open_page(page: "settings" | "inbox" = "settings", seed: (fixture: Fixture) => void = () => undefined): Fixture {
  const fixture = start_fixture({ on_announce: () => data_watch.bump() });
  seed(fixture);
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  render(
    <>
      {page === "settings" ? <SettingsView /> : <InboxPage />}
      <Dialogs />
    </>,
  );
  return fixture;
}

const open_settings = (): Fixture => open_page();

const section = () => screen.getByRole("heading", { name: "Interests" }).closest("section")!;

describe("the interests in Settings", () => {
  it("accept a proposed one only after showing its exact topic, which the user may edit, then pause and drop it", async () => {
    const fixture = open_settings();
    fixture.calls.propose_interest("tomatoes for Anna's allotment", "It came up.");
    data_watch.bump();
    const interests = await waitFor(section);
    expect(await within(interests).findByText("tomatoes for Anna's allotment")).toBeTruthy();
    expect(within(interests).getByText("Proposed, waiting for you")).toBeTruthy();

    fireEvent.click(within(interests).getByRole("button", { name: "Accept…" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(dialog).getByText(/sends exactly this text to the search engine/)).toBeTruthy();
    const topic = within(dialog).getByLabelText("Topic sent to the search engine") as HTMLInputElement;
    expect(topic.value).toBe("tomatoes for Anna's allotment");
    fireEvent.change(topic, { target: { value: "Tomatoes in a cold greenhouse" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.list_interests()[0]).toMatchObject({ topic: "Tomatoes in a cold greenhouse", state: "accepted" }));

    fireEvent.click(await within(section()).findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(fixture.calls.list_interests()[0]!.state).toBe("paused"));
    fireEvent.click(await within(section()).findByRole("button", { name: "Drop" }));
    await waitFor(() => expect(fixture.calls.list_interests()[0]!.state).toBe("dropped"));
  });

  it("add one of the user's own, accepted as typed, and set the most accepted at once", async () => {
    const fixture = open_settings();
    fireEvent.click(await within(await waitFor(section)).findByRole("button", { name: "Add an interest…" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.change(within(dialog).getByLabelText("Topic sent to the search engine"), { target: { value: "Rain barrels" } });
    fireEvent.change(within(dialog).getByLabelText("Why"), { target: { value: "I want one." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fixture.calls.list_interests()).toMatchObject([{ topic: "Rain barrels", state: "accepted", made_by: "user", reason: "I want one." }]));

    const most = within(section()).getByLabelText("Most accepted at once") as HTMLInputElement;
    fireEvent.change(most, { target: { value: "3" } });
    fireEvent.blur(most);
    await waitFor(() => expect(fixture.calls.get_settings()["interests.max_accepted"]).toBe(3));
  });

  it("say who made each and what it found in plain words", () => {
    const base = { made_by: "engine", conversation_title: "Greenhouse", reason: "It came up.", findings: 2 } as Interest;
    expect(interest_hint(base)).toBe("The assistant proposed it in “Greenhouse”. It came up. 2 findings.");
    expect(interest_hint({ ...base, made_by: "user", reason: "", findings: 1 })).toBe("You added it. 1 finding.");
    expect(interest_hint({ ...base, made_by: "program", reason: "", findings: 0 })).toBe("A program proposed it.");
  });
});

describe("a proposed interest in the Inbox", () => {
  const engine = { engine: "fake", model: "fake-model", sources: [], conversation_id: "" };

  it("is accepted only through the dialog showing its exact topic, which the user may edit, and never ticked", async () => {
    const fixture = open_page("inbox", (seeded) => {
      seeded.calls.propose_interest("tomatoes for Anna's allotment", "It came up.", engine);
      seeded.calls.propose_blueprint("Sort the mail", "When sorting mail.", "1. Read.", null, { engine: "fake", model: "fake-model", sources: [] });
      seeded.calls.propose_blueprint("Sow seeds", "When sowing.", "1. Sow.", null, { engine: "fake", model: "fake-model", sources: [] });
    });
    const row = (await screen.findByText("Interest: tomatoes for Anna's allotment")).closest("li")!;
    expect(within(row).getByText("It came up.")).toBeTruthy();
    expect(within(row).getByText(/By the assistant, fake · fake-model/)).toBeTruthy();
    expect(within(row).queryByRole("checkbox")).toBeNull();

    // Ticking everything picks the blueprint alone, so an interest is never accepted in bulk.
    fireEvent.click(screen.getByRole("checkbox", { name: "Pick Blueprint: Sort the mail" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve or set aside the ticked" }));
    const asked = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(asked).getByText(/approve or accept 2 proposals/)).toBeTruthy();
    fireEvent.click(within(asked).getByRole("button", { name: "Yes, all of them" }));
    await waitFor(() => expect(fixture.calls.list_blueprints().every((blueprint) => blueprint.status === "active")).toBe(true));
    expect(fixture.calls.list_interests()[0]!.state).toBe("proposed");

    fireEvent.click(within(await screen.findByText("Interest: tomatoes for Anna's allotment").then((title) => title.closest("li")!)).getByRole("button", { name: "Accept…" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(dialog).getByText(/sends exactly this text to the search engine/)).toBeTruthy();
    const topic = within(dialog).getByLabelText("Topic sent to the search engine") as HTMLInputElement;
    expect(topic.value).toBe("tomatoes for Anna's allotment");
    fireEvent.change(topic, { target: { value: "Tomatoes in a cold greenhouse" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.list_interests()[0]).toMatchObject({ topic: "Tomatoes in a cold greenhouse", state: "accepted" }));
    await waitFor(() => expect(screen.queryByText(/^Interest: /)).toBeNull());
    expect(fixture.calls.get_inbox_count()).toBe(0);
  });

  it("is dropped in place", async () => {
    const fixture = open_page("inbox", (seeded) => void seeded.calls.propose_interest("Rain barrels", "", engine));
    const row = (await screen.findByText("Interest: Rain barrels")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Drop" }));
    await waitFor(() => expect(fixture.calls.list_interests()[0]!.state).toBe("dropped"));
    await waitFor(() => expect(fixture.calls.get_inbox_count()).toBe(0));
  });
});
