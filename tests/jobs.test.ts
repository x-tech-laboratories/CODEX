import { afterEach, describe, expect, it } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import type { JobFields } from "../src/shared/jobs/model.ts";
import { check_jobs, context_mark, job_running, keep_running_jobs, use_job_host, wait_for_job } from "../src/shared/jobs/runner.ts";
import { register_device } from "../src/shared/jobs/records.ts";
import { checked_schedule, describe_schedule, is_due, next_due } from "../src/shared/jobs/schedule.ts";
import { page_only_methods, user_only_settings } from "../src/shared/page_api.ts";
import { bind_methods } from "../src/shared/store.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_job();
  await wait_for_runs();
  use_job_host(null);
  use_assistant_host(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const minute = 60_000;
const hour = 60 * minute;

// A store with a scripted engine and jobs run here on a clock the test moves.
function with_jobs(): Fixture & { clock: { now: number }; finished: string[] } {
  const fixture = start_fixture();
  const clock = { now: Date.now() };
  const finished: string[] = [];
  use_job_host({ database: () => fixture.database, device: "Test laptop", now: () => clock.now, on_finished: (run) => finished.push(run.outcome) });
  return { ...fixture, clock, finished };
}

function job_of(context_id: string | null, more: Partial<JobFields> = {}): JobFields {
  return { title: "Tidy the kitchen", instruction: "Rename the kitchen to Cooking.", context_id, schedule: { kind: "every", every: 1, unit: "hours" }, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 6 }, ...more };
}

// Background work on, and this device the one that runs it.
function turn_on(fixture: Fixture): void {
  fixture.calls.set_setting("background.enabled", true);
  fixture.calls.set_background_device(register_device(fixture.database, "Test laptop", "desktop", Date.now()));
}

async function check(): Promise<string | null> {
  const started = check_jobs();
  if (!started) return null;
  return (await started).outcome;
}

// ── Schedules ────────────────────────────────────────────────────────────────

describe("schedules", () => {
  it("are checked and said in plain words", () => {
    expect(describe_schedule(checked_schedule({ kind: "every", every: 2, unit: "hours" }))).toBe("every 2 hours");
    expect(describe_schedule(checked_schedule({ kind: "every", every: 1, unit: "days" }))).toBe("every day");
    expect(describe_schedule(checked_schedule({ kind: "at", time: "7:30", weekdays: [5, 1, 1] }))).toBe("at 07:30 on Monday and Friday");
    expect(describe_schedule(checked_schedule({ kind: "at", time: "18:00", weekdays: [1, 2, 3, 4, 5] }))).toBe("at 18:00 on weekdays");
    expect(describe_schedule(checked_schedule({ kind: "at", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }))).toBe("at 18:00 every day");
    expect(() => checked_schedule({ kind: "every", every: 2, unit: "weeks" })).toThrow("unit is");
    expect(() => checked_schedule({ kind: "every", every: 1, unit: "minutes" })).toThrow("at most every 5 minutes");
    expect(() => checked_schedule({ kind: "every", every: 1.5, unit: "hours" })).toThrow("whole number");
    expect(() => checked_schedule({ kind: "at", time: "25:00", weekdays: [1] })).toThrow("24-hour time");
    expect(() => checked_schedule({ kind: "at", time: "07:00", weekdays: [] })).toThrow("one weekday or more");
    expect(() => checked_schedule(null)).toThrow("A schedule is");
  });

  it("fall due once however many times they were missed", () => {
    const every = checked_schedule({ kind: "every", every: 2, unit: "hours" });
    const since = Date.parse("2026-11-26T09:00:00");
    expect(is_due(every, since, since + hour)).toBe(false);
    expect(is_due(every, since, since + 2 * hour)).toBe(true);
    expect(is_due(every, since, since + 20 * hour)).toBe(true);
    expect(next_due(every, since)).toBe(since + 2 * hour);

    // 2026-11-26 is a Thursday.
    const thursdays = checked_schedule({ kind: "at", time: "08:00", weekdays: [4] });
    expect(is_due(thursdays, Date.parse("2026-11-26T07:00:00"), Date.parse("2026-11-26T07:59:00"))).toBe(false);
    expect(is_due(thursdays, Date.parse("2026-11-26T07:00:00"), Date.parse("2026-11-26T08:00:00"))).toBe(true);
    expect(is_due(thursdays, Date.parse("2026-11-26T08:00:00"), Date.parse("2026-11-27T12:00:00"))).toBe(false);
    expect(is_due(thursdays, Date.parse("2026-11-10T08:30:00"), Date.parse("2026-11-27T12:00:00"))).toBe(true);
    expect(new Date(next_due(thursdays, Date.parse("2026-11-26T08:00:00"))).toString()).toContain("Thu Dec 03 2026 08:00");
  });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

describe("jobs", () => {
  it("are made, changed, turned off and removed, with History, and a program's starts off", () => {
    const fixture = with_jobs();
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_job(job_of(kitchen));
    expect(fixture.calls.get_job(id)).toMatchObject({ title: "Tidy the kitchen", is_on: true, made_by: "user", context_name: "Kitchen", when: "every hour", last_run: null, runs: [] });
    expect(fixture.calls.list_jobs(kitchen).map((job) => job.id)).toEqual([id]);
    expect(fixture.calls.list_jobs(null)).toEqual([]);

    fixture.calls.change_job(id, { schedule: { kind: "every", every: 3, unit: "hours" }, limits: { max_runs_per_day: 2 } as never });
    expect(fixture.calls.get_job(id)).toMatchObject({ when: "every 3 hours", limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 2 } });
    expect(() => fixture.calls.change_job(id, { title: " " })).toThrow("needs a title");
    expect(() => fixture.calls.change_job(id, { context_id: "nowhere" })).toThrow("There is no context nowhere");
    expect(() => fixture.calls.change_job(id, { limits: { max_rounds: 99 } as never })).toThrow("most rounds a run");
    expect(() => fixture.calls.add_job({ ...job_of(null), instruction: "" })).toThrow("needs an instruction");

    fixture.calls.set_job_on(id, false);
    expect(fixture.calls.get_job(id).is_on).toBe(false);
    expect(fixture.calls.list_item_history("job", id).map((version) => version.summary)).toEqual(["off", "on", "on"]);

    const program = bind_methods(() => fixture.database, () => undefined, "program");
    const by_program = program.add_job(job_of(null, { title: "From a script" }));
    expect(fixture.calls.get_job(by_program)).toMatchObject({ is_on: false, made_by: "program" });

    fixture.calls.remove_job(id);
    expect(() => fixture.calls.get_job(id)).toThrow("There is no job");

    for (const name of ["set_job_on", "run_job_now", "set_background_device"]) expect(page_only_methods.has(name)).toBe(true);
    for (const key of ["background.enabled", "background.daily_runs", "background.daily_tokens"]) expect(user_only_settings.has(key)).toBe(true);
  });

  it("are asked for by the engine as changes under the action policy, which the user approves", async () => {
    const fixture = with_jobs();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      await request.tools.call("add_job", { fields: { title: "Morning review", instruction: "List what is due today.", context_id: kitchen, schedule: { kind: "at", time: "07:30", weekdays: [1, 2, 3, 4, 5] } } });
      yield { type: "done", text: "I proposed the job." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Review my morning every weekday");
    await wait_for_runs();
    const [proposal] = fixture.calls.list_proposals(conversation_id);
    expect(proposal).toMatchObject({ method: "add_job", summary: "Add the job “Morning review”, at 07:30 on weekdays, in the context “Kitchen”, doing “List what is due today.”." });
    expect(fixture.calls.list_jobs()).toEqual([]);
    await fixture.calls.resolve_proposal(proposal!.id, "approve");
    expect(fixture.calls.list_jobs()).toMatchObject([{ title: "Morning review", is_on: true, made_by: "user" }]);

    // At a level that lets it, the engine makes it itself.
    fixture.calls.set_action_level("add_job", "auto");
    fixture.set_script(async function* (request) {
      await request.tools.call("add_job", { fields: { title: "Evening", instruction: "Say good night.", schedule: { kind: "every", every: 1, unit: "days" } } });
      yield { type: "done", text: "Made." };
    });
    await fixture.calls.send_message(kitchen, "And every evening", conversation_id);
    await wait_for_runs();
    expect(fixture.calls.list_jobs().find((job) => job.title === "Evening")!.made_by).toBe("engine");
  });
});

// ── Running ──────────────────────────────────────────────────────────────────

describe("background runs", () => {
  it("run nothing until background work is on and this device runs it, and Run now says why", async () => {
    const fixture = with_jobs();
    const id = fixture.calls.add_job(job_of(null));
    fixture.clock.now += 2 * hour;
    expect(check_jobs()).toBeNull();
    await expect(fixture.calls.run_job_now(id)).rejects.toThrow("The assistant's jobs are off");
    fixture.calls.set_setting("background.enabled", true);
    expect(check_jobs()).toBeNull();
    expect(fixture.calls.get_background_state()).toMatchObject({ enabled: true, runs_here: false, device: "Test laptop", daily_runs: 24, daily_tokens: 200_000, runs_today: 0 });
    fixture.calls.set_background_device(register_device(fixture.database, "Test laptop", "desktop", Date.now()));
    expect(await check()).toBe("done");
    expect(fixture.requests).toHaveLength(1);
  });

  it("start an ordinary run in the job's own conversation, applying only background-level changes and proposing the rest", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "auto");
    fixture.calls.set_action_level("set_context_notes", "background");
    fixture.set_script(async function* (request) {
      await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      await request.tools.call("set_context_notes", { id: kitchen, notes: "Checked." });
      yield { type: "usage", input_tokens: 300, output_tokens: 50 };
      yield { type: "done", text: "Done what I may." };
    });
    const id = fixture.calls.add_job(job_of(kitchen));
    fixture.clock.now += hour;
    expect(await check()).toBe("done");

    const job = fixture.calls.get_job(id);
    expect(job.runs[0]).toMatchObject({ outcome: "done", device: "Test laptop", engine: "Fake", model: "fake-model", rounds: 1, input_tokens: 300, output_tokens: 50, proposed: ["Rename the context “Kitchen” to “Cooking”."] });
    expect(job.runs[0]!.applied).toHaveLength(1);
    expect(fixture.calls.get_context(kitchen)).toMatchObject({ name: "Kitchen", notes: "Checked." });
    const conversation = fixture.calls.get_conversation(job.conversation_id);
    expect(conversation).toMatchObject({ title: "Tidy the kitchen", contexts: [{ id: kitchen, name: "Kitchen" }] });
    expect(conversation.messages[0]!.text).toBe("Rename the kitchen to Cooking.");
    expect(fixture.finished).toEqual(["done"]);

    // Not again until it is due; then once, however long it waited.
    expect(check_jobs()).toBeNull();
    fixture.clock.now += 5 * hour;
    expect(await check()).toBe("done");
    expect(check_jobs()).toBeNull();
    expect(fixture.calls.get_job(id).runs).toHaveLength(2);
    expect(fixture.calls.get_job(id).conversation_id).toBe(job.conversation_id);
  });

  it("make no engine call when the job runs only on change and nothing changed", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.add_job(job_of(kitchen, { only_when_changed: true }));
    fixture.clock.now += hour;
    expect(await check()).toBe("done");
    fixture.clock.now += hour;
    expect(check_jobs()).toBeNull();
    expect(fixture.requests).toHaveLength(1);
    // Checked unchanged, it waits a whole interval again.
    fixture.calls.add_item([kitchen], "links", { source_id: "https://example.org", kind: "link", title: "Recipes" });
    fixture.clock.now += 30 * minute;
    expect(check_jobs()).toBeNull();
    fixture.clock.now += 30 * minute;
    expect(await check()).toBe("done");
    expect(fixture.requests).toHaveLength(2);
    const mark = context_mark(fixture.database, kitchen, "");
    expect(context_mark(fixture.database, kitchen, "")).toBe(mark);
  });

  it("stop at the round and token limits with a plain note, and an error is kept", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const id = fixture.calls.add_job(job_of(null, { limits: { max_rounds: 2, max_tokens: 5000, max_runs_per_day: 6 } }));
    fixture.set_script(async function* (request) {
      expect(request.limits).toEqual({ max_rounds: 2 });
      yield { type: "usage", input_tokens: 4000, output_tokens: 1500 };
      yield { type: "done", text: "Never reached." };
    });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_job(id).runs[0]).toMatchObject({ outcome: "limit", note: "Stopped: it reached its limit of 5,000 tokens for one run." });

    fixture.set_script(async function* () {
      for (let round = 0; round < 3; round++) yield { type: "usage", input_tokens: 10, output_tokens: 10 };
      yield { type: "done", text: "Too many rounds." };
    });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_job(id).runs[0]).toMatchObject({ outcome: "limit", note: "Stopped: it reached its limit of 2 rounds for one run." });

    fixture.set_script(async function* () {
      yield { type: "usage", input_tokens: 10, output_tokens: 10 };
      yield { type: "usage", input_tokens: 10, output_tokens: 10 };
      yield { type: "error", message: "The model was still calling tools after 2 rounds." };
    });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_job(id).runs[0]!.outcome).toBe("limit");

    fixture.set_script(async function* () {
      yield { type: "error", message: "The engine could not answer." };
    });
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_job(id).runs[0]).toMatchObject({ outcome: "error", note: "The engine could not answer." });
    // A failed job leaves the assistant mildly concerned, and nothing more.
    expect(fixture.calls.get_settings()["mood.current"]).toMatchObject({ mood: "concerned", strength: 0.4, by: "event" });
  });

  it("hold to today's caps, each job's and every job's together", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const id = fixture.calls.add_job(job_of(null, { limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 1 } }));
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    await expect(fixture.calls.run_job_now(id)).rejects.toThrow("as often as it may today");
    const other = fixture.calls.add_job(job_of(null, { title: "Other" }));
    fixture.calls.set_setting("background.daily_runs", 1);
    await expect(fixture.calls.run_job_now(other)).rejects.toThrow("Today's cap on background runs");
    fixture.calls.set_setting("background.daily_runs", 10);
    fixture.calls.set_setting("background.daily_tokens", 0);
    await expect(fixture.calls.run_job_now(other)).rejects.toThrow("Today's cap on background tokens");
    // A new day starts the counts again.
    fixture.calls.set_setting("background.daily_tokens", 1000);
    fixture.clock.now += 24 * hour;
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_background_state()).toMatchObject({ runs_today: 1 });
  });

  it("never run twice at once, wait for a live conversation, and give way to one that starts", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_job(job_of(kitchen));
    let release: () => void = () => undefined;
    fixture.set_script(async function* (_request, signal) {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve());
      });
      yield { type: "done", text: "Background." };
    });
    fixture.clock.now += hour;
    const started = check_jobs()!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(fixture.calls.run_job_now(id)).rejects.toThrow("This job is running now.");
    expect(fixture.calls.get_background_state().is_running).toBe(true);

    fixture.set_script(async function* () {
      yield { type: "done", text: "Live." };
    });
    await fixture.calls.send_message(kitchen, "Hello");
    expect((await started).outcome).toBe("gave_way");
    expect((await started).note).toContain("give way to a conversation");
    release();
    await wait_for_runs();

    // It runs again at its next turn, the run that gave way not counting.
    expect(await check()).toBe("done");
    expect(fixture.calls.get_job(id).runs.map((run) => run.outcome)).toEqual(["done", "gave_way"]);

    // While a live reply is written, nothing starts.
    fixture.set_script(async function* (_request, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      yield { type: "done", text: "Stopped." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Wait");
    fixture.clock.now += 2 * hour;
    expect(check_jobs()).toBeNull();
    fixture.calls.stop_reply(conversation_id);
  });
});

// ── Inbox ────────────────────────────────────────────────────────────────────

describe("the Inbox", () => {
  it("lists what waits across the app, newest first, and runs that failed until set aside", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      yield { type: "done", text: "Proposed." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Rename it");
    await wait_for_runs();
    const maker = { engine: "fake", model: "fake-model", sources: [] };
    fixture.calls.propose_blueprint("Sort the mail", "When sorting mail.", "1. Read.", null, maker);
    await fixture.calls.propose_entity("person", "Ada", [], null, maker);
    const id = fixture.calls.add_job(job_of(kitchen));
    fixture.set_script(async function* () {
      yield { type: "error", message: "The engine could not answer." };
    });
    fixture.clock.now = Date.now() + minute;
    await fixture.calls.run_job_now(id);
    await wait_for_job();

    const inbox = fixture.calls.list_inbox();
    expect(inbox.map((entry) => entry.kind).sort()).toEqual(["blueprint", "change", "entity", "job_run"]);
    expect(fixture.calls.get_inbox_count()).toBe(4);
    const change = inbox.find((entry) => entry.kind === "change")!;
    expect(change).toMatchObject({ title: "Rename the context “Kitchen” to “Cooking”.", conversation_id, conversation_title: "Rename it", route: `#/conversation/${conversation_id}` });
    expect(change.proposal!.evidence.asked_by).not.toBe("");
    expect(inbox.find((entry) => entry.kind === "job_run")).toMatchObject({ title: "Failed: Tidy the kitchen", detail: "The engine could not answer.", job_title: "Tidy the kitchen", route: `#/jobs/${id}` });
    expect(inbox.find((entry) => entry.kind === "entity")).toMatchObject({ title: "New person: Ada", made_by: "the assistant, fake · fake-model" });
    expect(inbox[0]!.kind).toBe("job_run");

    const run = inbox.find((entry) => entry.kind === "job_run")!;
    expect(fixture.calls.dismiss_job_runs([run.id, "nothing"])).toBe(1);
    expect(fixture.calls.dismiss_job_runs([run.id])).toBe(0);
    expect(fixture.calls.get_inbox_count()).toBe(3);
  });

  it("names who made each proposal and what a change to a blueprint or a run at its limit is", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const garden = fixture.calls.add_context("Garden");
    const seeds = fixture.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seeds" });
    const program = bind_methods(() => fixture.database, () => undefined, "program");
    program.add_graph_link(`context:${garden}`, `item:${seeds}`, "about");
    program.add_entity("topic", "Sowing");
    const blueprint = fixture.calls.add_blueprint("Sow", "When sowing.", "1. Sow.");
    fixture.calls.propose_blueprint_change(blueprint, "1. Sow thinly.", "Thinner.", undefined, undefined, { engine: "fake", model: "fake-model", sources: [] });
    const id = fixture.calls.add_job(job_of(null, { limits: { max_rounds: 4, max_tokens: 1000, max_runs_per_day: 6 } }));
    fixture.set_script(async function* () {
      yield { type: "usage", input_tokens: 2000, output_tokens: 10 };
      yield { type: "done", text: "Never." };
    });
    fixture.clock.now = Date.now() + minute;
    await fixture.calls.run_job_now(id);
    await wait_for_job();

    const inbox = fixture.calls.list_inbox();
    expect(inbox.find((entry) => entry.kind === "link")).toMatchObject({ made_by: "a program", route: `#/graph/${encodeURIComponent(`context:${garden}`)}` });
    expect(inbox.find((entry) => entry.kind === "entity")).toMatchObject({ title: "New topic: Sowing", made_by: "a program" });
    expect(inbox.find((entry) => entry.kind === "blueprint_change")).toMatchObject({ title: "Change to the blueprint “Sow”", detail: "Thinner.", route: `#/blueprint/${blueprint}` });
    expect(inbox.find((entry) => entry.kind === "job_run")).toMatchObject({ title: "Stopped at a limit: Tidy the kitchen" });
  });
});

describe("the job calls an engine proposes", () => {
  it("say a change and a removal in plain words, and the runner checks on a timer until stopped", async () => {
    const fixture = with_jobs();
    const kitchen = fixture.calls.add_context("Kitchen");
    const id = fixture.calls.add_job(job_of(kitchen));
    fixture.set_script(async function* (request) {
      await request.tools.call("change_job", { id, fields: { context_id: null, only_when_changed: true, limits: { max_rounds: 2 }, schedule: { kind: "every", every: 0, unit: "hours" } } });
      await request.tools.call("change_job", { id: "nothing", fields: { title: "Other" } });
      await request.tools.call("remove_job", { id });
      yield { type: "done", text: "Proposed." };
    });
    const { conversation_id } = await fixture.calls.send_message(kitchen, "Change the job");
    await wait_for_runs();
    expect(fixture.calls.list_proposals(conversation_id).map((proposal) => proposal.summary)).toEqual([
      'Change the job “Tidy the kitchen”: on the schedule {"kind":"every","every":0,"unit":"hours"}, in the context “Global”, only when its context changed, within {"max_rounds":2}.',
      "Change the job that does not exist (nothing): “Other”.",
      "Remove the job “Tidy the kitchen”; its runs and conversation stay.",
    ]);

    turn_on(fixture);
    fixture.clock.now += 2 * hour;
    const running = keep_running_jobs({ database: () => fixture.database, device: "Timer", now: () => fixture.clock.now }, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await wait_for_job();
    expect(fixture.calls.list_job_runs(id)[0]).toMatchObject({ device: "Timer", outcome: "done" });
    expect(job_running()).toBeNull();
    await running.stop();
    expect(() => check_jobs()).toThrow("Jobs run only where the store runs");
  });
});

describe("a run that cannot start", () => {
  it("is kept as failed with why, and the user writing in the job's conversation makes a running job give way", async () => {
    const fixture = with_jobs();
    turn_on(fixture);
    const id = fixture.calls.add_job(job_of(null));
    fixture.calls.set_setting("engine", "");
    await fixture.calls.run_job_now(id);
    await wait_for_job();
    expect(fixture.calls.get_job(id).runs[0]).toMatchObject({ outcome: "error", note: "No engine is set up; choose one under Settings → Assistant → Engine." });

    fixture.calls.set_setting("engine", "fake");
    fixture.set_script(async function* (_request, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      yield { type: "done", text: "Stopped." };
    });
    fixture.clock.now += hour;
    await fixture.calls.run_job_now(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const conversation_id = fixture.calls.get_job(id).conversation_id;
    fixture.set_script(async function* () {
      yield { type: "done", text: "Here." };
    });
    await fixture.calls.send_message(null, "I am here", conversation_id);
    await wait_for_runs();
    expect(fixture.calls.get_job(id).runs[0]!.outcome).toBe("gave_way");
    expect(fixture.calls.get_conversation(conversation_id).messages.at(-1)!.text).toBe("Here.");
  });
});

