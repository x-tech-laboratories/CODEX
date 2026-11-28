// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { ContextMenus } from "@x-tech-laboratories/x-libs/web/react/menus";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { use_job_host, wait_for_job } from "../../../src/shared/jobs/runner.ts";
import { register_device } from "../../../src/shared/jobs/records.ts";
import type { ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { InboxPage } from "../../../src/web/inbox/InboxPage.tsx";
import { assistant_jobs_section, background_section, maintenance_section, run_words } from "../../../src/web/jobs/BackgroundSettings.tsx";
import { JobsPage } from "../../../src/web/jobs/JobsPage.tsx";
import { sidebar_views } from "../../../src/web/Sidebar.tsx";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

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
    expect(screen.getByText(/The assistant's jobs are off/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(screen.getByText(/The assistant's jobs are off; turn them on/)).toBeTruthy());

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
  it("turns the assistant's jobs on, makes this device the one, and shows today's use", async () => {
    const fixture = open_page();
    const server = "server-1";
    fixture.database.prepare("INSERT INTO background_devices (id, name, kind, started_at) VALUES (?, ?, ?, ?)").run(server, "server on home", "server", new Date().toISOString());
    fixture.calls.set_background_device(server);
    const own = register_device(fixture.database, "Test laptop", "desktop", Date.now());
    render(
      <>
        {background_section.content}
        {assistant_jobs_section.content}
      </>,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "The assistant's jobs" }));
    await waitFor(() => expect(fixture.calls.get_background_state().enabled).toBe(true));
    const device = screen.getByLabelText("Device that does it") as HTMLSelectElement;
    expect(device.value).toBe(server);
    fireEvent.change(device, { target: { value: own } });
    await waitFor(() => expect(fixture.calls.get_background_state().runs_here).toBe(true));
    expect(screen.getByText("The assistant's jobs together, on every device. Today: 0.")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Approve or set aside the ticked" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/approve or accept 2 proposals/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, all of them" }));
    await waitFor(() => expect(fixture.calls.get_inbox_count()).toBe(0));
    expect(fixture.calls.get_context(kitchen)).toMatchObject({ name: "Cooking", notes: "Clean." });
  });

  it("rejects several at once and sets runs aside, through each feature's own calls", async () => {
    const fixture = open_page();
    fixture.calls.set_setting("background.enabled", true);
    const maker = { engine: "fake", model: "fake-model", sources: [] };
    fixture.calls.propose_blueprint("Sort the mail", "When sorting mail.", "1. Read.", null, maker);
    const kept = fixture.calls.add_blueprint("Sow", "When sowing.", "1. Sow.");
    fixture.calls.propose_blueprint_change(kept, "1. Sow thinly.", "Thinner.", undefined, undefined, maker);
    await fixture.calls.propose_entity("person", "Ada", [], null, maker);
    const id = fixture.calls.add_job({ title: "Tidy", instruction: "Tidy.", context_id: null, schedule: every_day, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 6 } });
    fixture.set_script(async function* () {
      yield { type: "error", message: "The engine could not answer." };
    });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    render(
      <>
        <InboxPage />
        <Dialogs />
      </>,
    );
    expect(await screen.findByText("Failed: Tidy")).toBeTruthy();
    expect(screen.getByText("What would change")).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Reject the ticked" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/reject 3 proposals/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject all of them" }));
    await waitFor(() => expect(fixture.calls.get_inbox_count()).toBe(1));
    expect(fixture.calls.get_blueprint(kept).body).toBe("1. Sow.");

    const run = (await screen.findByText("Failed: Tidy")).closest("li")!;
    fireEvent.click(within(run).getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(fixture.calls.get_inbox_count()).toBe(0));
    expect(await screen.findByText("Nothing waits for you")).toBeTruthy();
  });
});

describe("the Jobs page's other states", () => {
  it("says when another device runs background work, removes a job after asking, and sets a unit and limits", async () => {
    const fixture = open_page();
    fixture.calls.set_setting("background.enabled", true);
    fixture.calls.add_job({ title: "Tidy", instruction: "Tidy.", context_id: null, schedule: every_day, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 2 } });
    render(
      <>
        <JobsPage focus={null} />
        <Dialogs />
        <ContextMenus />
      </>,
    );
    expect(await screen.findByText(/run on the device you choose, not here/)).toBeTruthy();
    fixture.calls.set_background_device(register_device(fixture.database, "Test laptop", "desktop", Date.now()));

    fireEvent.click(screen.getByRole("button", { name: /New job/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Often" } });
    fireEvent.change(within(dialog).getByLabelText("What it does"), { target: { value: "Look." } });
    fireEvent.change(within(dialog).getByLabelText("Unit"), { target: { value: "hours" } });
    fireEvent.change(within(dialog).getByLabelText("Rounds a run"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Only when something changed" }));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(fixture.calls.list_jobs().find((job) => job.title === "Often")).toMatchObject({ when: "every hour", only_when_changed: true }));

    fireEvent.click(await screen.findByRole("button", { name: "More for Tidy" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fixture.calls.list_jobs().map((job) => job.title)).toEqual(["Often"]));
  });
});

describe("Settings → Background work's maintenance jobs", () => {
  it("pause everything, list each job with why it last did nothing, and set one's switch and budget in its dialog", async () => {
    const fixture = open_page();
    register_device(fixture.database, "Test laptop", "desktop", Date.now());
    const now = new Date().toISOString();
    fixture.database.prepare("INSERT INTO maintenance_checks (job, device, checked_at, day, skips, skip_reason, skipped_at, used_up) VALUES ('tidy', 'Test laptop', ?, '2000-01-01', 3, 'Nothing changed, so there was nothing to do.', ?, '')").run(now, now);
    render(
      <>
        {background_section.content}
        {maintenance_section.content}
        <Dialogs />
      </>,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Pause background work" }));
    await waitFor(() => expect(fixture.calls.get_background_state().paused).toBe(true));
    expect(await screen.findByText("Tidy the graph")).toBeTruthy();
    expect(document.body.textContent).toMatch(/Last looked .+: Nothing changed, so there was nothing to do\./);
    expect(screen.getAllByText(/Every device runs it for its own index\./)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Open Suggest links" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Off until you turn it on, since it calls a model/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Suggest links on" }));
    await waitFor(() => expect(fixture.calls.list_maintenance_jobs().find((job) => job.key === "suggest")!.on).toBe(true));
    fireEvent.change(within(dialog).getByLabelText("Suggest links: Tokens a day"), { target: { value: "20000" } });
    fireEvent.blur(within(dialog).getByLabelText("Suggest links: Tokens a day"));
    await waitFor(() => expect(fixture.calls.list_maintenance_jobs().find((job) => job.key === "suggest")!.budget.tokens_per_day).toBe(20_000));

    fireEvent.change(screen.getByLabelText("Look for work every"), { target: { value: "60" } });
    fireEvent.blur(screen.getByLabelText("Look for work every"));
    await waitFor(() => expect(fixture.calls.get_background_state().tick_minutes).toBe(60));
    fireEvent.click(screen.getByRole("switch", { name: "Background work may use a hosted engine" }));
    await waitFor(() => expect(fixture.calls.get_background_state().hosted_allowed).toBe(true));
  });

  it("say what a run did in a line", () => {
    const run = { applied: ["Embedded 3 pieces of text."], proposed: [], note: "", outcome: "done" } as never;
    expect(run_words(run)).toBe("Embedded 3 pieces of text.");
    expect(run_words({ ...(run as object), applied: [], outcome: "error", note: "away" } as never)).toBe("It failed: away");
    expect(run_words({ ...(run as object), applied: [] } as never)).toBe("It found nothing to change.");
  });
});

describe("the Inbox's daily digest", () => {
  it("lists what background work did, and is set aside", async () => {
    const fixture = open_page();
    fixture.database
      .prepare("INSERT INTO job_runs (id, job_id, title, started_at, ended_at, outcome, applied, items) VALUES ('d1', 'maintenance:digest', 'Daily digest', ?, ?, 'done', ?, 1)")
      .run("2026-11-27T08:00:00.000Z", "2026-11-27T08:00:01.000Z", JSON.stringify(["Links from rules: The rules made 2 links.", "Nothing waits for you in the Inbox."]));
    render(<InboxPage />);
    expect(await screen.findByText("Background work, 2026-11-27")).toBeTruthy();
    expect(screen.getByText("Links from rules: The rules made 2 links.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(fixture.calls.list_inbox()).toEqual([]));
  });
});

describe("one job with no runs", () => {
  it("says it has not run, and where background work runs", async () => {
    const fixture = open_page();
    fixture.calls.set_setting("background.enabled", true);
    fixture.calls.set_background_device(register_device(fixture.database, "Test laptop", "desktop", Date.now()));
    const id = fixture.calls.add_job({ title: "Tidy", instruction: "Tidy.", context_id: null, schedule: every_day, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 2 } });
    render(<JobsPage focus={id} />);
    expect(await screen.findByText("It has not run yet.")).toBeTruthy();
    expect(screen.getByText(/The assistant's jobs run on this device \(Test laptop\)/)).toBeTruthy();
  });
});

