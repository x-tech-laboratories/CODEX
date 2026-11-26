// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { ContextMenus } from "@x-tech-laboratories/x-libs/web/react/menus";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import { use_job_host, wait_for_job } from "../src/shared/jobs/runner.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { InboxPage } from "../src/web/inbox/InboxPage.tsx";
import { background_section } from "../src/web/jobs/BackgroundSettings.tsx";
import { JobsPage } from "../src/web/jobs/JobsPage.tsx";
import { sidebar_views } from "../src/web/Sidebar.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  cleanup();
  await wait_for_job();
  await wait_for_runs();
  use_job_host(null);
  use_assistant_host(null);
});

function open_page(): Fixture {
  const fixture = start_fixture();
  use_job_host({ database: () => fixture.database, device: "Test laptop", now: () => Date.now() });
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "desktop", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return fixture;
}

const every_day = { kind: "every", every: 1, unit: "days" } as const;

describe("the Jobs page", () => {
  it("lists jobs with their schedule and last run, makes one, turns one off and runs one now", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_job({ title: "Tidy", instruction: "Tidy the kitchen.", context_id: kitchen, schedule: every_day, only_when_changed: true, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 2 } });
    render(
      <>
        <JobsPage focus={null} />
        <Dialogs />
        <ContextMenus />
        <Toasts />
      </>,
    );
    expect(await screen.findByText("Tidy")).toBeTruthy();
    expect(screen.getByText(/Every day, only when something changed/)).toBeTruthy();
    expect(screen.getByText(/Background work is off/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(screen.getByText(/Background work is off; turn it on/)).toBeTruthy());

    fixture.calls.set_setting("background.enabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(fixture.calls.list_job_runs().length).toBe(1));
    await wait_for_job();

    fireEvent.click(screen.getByRole("switch", { name: "Tidy is on" }));
    await waitFor(() => expect(fixture.calls.list_jobs()[0]!.is_on).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /New job/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Morning" } });
    fireEvent.change(within(dialog).getByLabelText("What it does"), { target: { value: "List what is due." } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "At a time" }));
    fireEvent.click(within(dialog).getByLabelText("Mon"));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(fixture.calls.list_jobs().find((job) => job.title === "Morning")).toMatchObject({ when: "at 08:00 on Tuesday, Wednesday, Thursday and Friday" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Changing one saves it and closes the dialog too.
    fireEvent.click(screen.getByRole("button", { name: "More for Morning" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Change…" }));
    const change = await screen.findByRole("dialog");
    fireEvent.change(within(change).getByLabelText("Title"), { target: { value: "Mornings" } });
    fireEvent.submit(change.querySelector("form")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.calls.list_jobs().some((job) => job.title === "Mornings")).toBe(true);
  });

  it("shows one job's runs, with the device that ran each", async () => {
    const fixture = open_page();
    fixture.calls.set_setting("background.enabled", true);
    const id = fixture.calls.add_job({ title: "Tidy", instruction: "Tidy.", context_id: null, schedule: every_day, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 2 } });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    render(<JobsPage focus={id} />);
    expect(await screen.findByText(/Its runs, newest first/)).toBeTruthy();
    expect(screen.getAllByText(/on Test laptop/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open its conversation" })).toBeTruthy();
  });
});

describe("Settings → Background work", () => {
  it("turns background work on, makes this device the one, and shows today's use", async () => {
    const fixture = open_page();
    render(<>{background_section.content}</>);
    fireEvent.click(await screen.findByRole("switch", { name: "Background work" }));
    await waitFor(() => expect(fixture.calls.get_background_state().enabled).toBe(true));
    fireEvent.click(screen.getByRole("switch", { name: "This device runs background work" }));
    await waitFor(() => expect(fixture.calls.get_background_state().runs_here).toBe(true));
    expect(screen.getByText("Every job on every device together. Today: 0.")).toBeTruthy();
  });
});

describe("the Inbox", () => {
  it("lists what waits with its count, decides one in place and several at once after asking", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      await request.tools.call("set_context_notes", { id: kitchen, notes: "Clean." });
      yield { type: "done", text: "Proposed." };
    });
    await fixture.calls.send_message(kitchen, "Rename and note it");
    await wait_for_runs();
    const maker = { engine: "fake", model: "fake-model", sources: [] };
    fixture.calls.propose_blueprint("Sort the mail", "When sorting mail.", "1. **Read**.", null, maker);
    expect(sidebar_views(fixture.calls.get_inbox_count()).find((view) => view.id === "inbox")!.label).toBe("Inbox · 3");
    expect(sidebar_views(0).find((view) => view.id === "inbox")!.label).toBe("Inbox");

    render(
      <>
        <InboxPage />
        <Dialogs />
      </>,
    );
    expect(await screen.findByText("Rename the context “Kitchen” to “Cooking”.")).toBeTruthy();
    expect(screen.getByText("Blueprint: Sort the mail")).toBeTruthy();
    expect(screen.getAllByText("Rename and note it").length).toBeGreaterThan(0);

    const row = screen.getByText("Blueprint: Sort the mail").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(fixture.calls.list_blueprints()[0]!.status).toBe("active"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Pick Rename the context “Kitchen” to “Cooking”." }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Pick Replace the notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve or set aside" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/approve or accept 2 proposals/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, all of them" }));
    await waitFor(() => expect(fixture.calls.get_inbox_count()).toBe(0));
    expect(fixture.calls.get_context(kitchen)).toMatchObject({ name: "Cooking", notes: "Clean." });
  });
});
