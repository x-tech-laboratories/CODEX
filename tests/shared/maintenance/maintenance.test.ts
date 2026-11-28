// The self-maintenance loop: built-in jobs chosen by what changed, each with a budget, skipped when there is nothing
// to do, run by the one device chosen, paused by a switch, waiting for a live conversation, under the action policy,
// with background model work on a local engine unless a hosted one is allowed.

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import type { FoundItem } from "../../../src/shared/collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { check_jobs, use_job_host, wait_for_job } from "../../../src/shared/jobs/runner.ts";
import { device_id_of, register_device, runs_here } from "../../../src/shared/jobs/records.ts";
import { digest_lines } from "../../../src/shared/maintenance/jobs.ts";
import { keep_maintaining, run_maintenance_job, settle_maintenance, tick, use_maintenance_host, type MaintenanceHost } from "../../../src/shared/maintenance/loop.ts";
import { maintenance_jobs } from "../../../src/shared/maintenance/model.ts";
import { mood_state } from "../../../src/shared/mood/mood.ts";
import { user_only_settings } from "../../../src/shared/page_api.ts";
import { page_only_methods } from "../../../src/shared/store.ts";
import { count_changed, open_index, settle_index, use_search_index } from "../../../src/shared/search/indexer.ts";
import { page_only } from "../../../src/shared/store.ts";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

afterEach(async () => {
  await settle_maintenance();
  await settle_index();
  await wait_for_job();
  await wait_for_runs();
  use_maintenance_host(null);
  use_job_host(null);
  use_search_index(null);
  use_assistant_host(null);
});

// ── Fakes ────────────────────────────────────────────────────────────────────

const day = 86_400_000;

// A collector of notes whose text it gives for the index, counting each read.
function notes_plugin(texts: Map<string, string>, reads: string[][]): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: "tests.notes",
    name: "Notes",
    version: "1.0.0",
    start: (context) =>
      context.provide("collector", "notes", {
        label: "Notes",
        kinds: ["note"],
        resolve: async (ids) => Object.fromEntries(ids.map((id): [string, FoundItem] => [id, { source_id: id, kind: "note", title: id }])),
        content: async (ids) => {
          reads.push(ids);
          return Object.fromEntries(ids.filter((id) => texts.has(id)).map((id) => [id, texts.get(id)!]));
        },
      }),
  });
}

// An embedder giving each text the same vector, which can be held until the test lets it go.
function embedder_plugin(calls: string[][], hold: { until?: (signal: AbortSignal) => Promise<void> }): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: "tests.fake-embedder",
    name: "Fake embedder",
    version: "1.0.0",
    start: (context) =>
      context.provide("embedder", "fake-embedder", {
        label: "Fake embedder",
        model: () => "m",
        dimensions: () => 4,
        is_local: () => true,
        embed: async (texts, signal) => {
          await hold.until?.(signal ?? new AbortController().signal);
          calls.push(texts);
          return texts.map(() => [1, 0, 0, 0]);
        },
      }),
  });
}

interface Setup extends Fixture {
  index: DatabaseSync;
  clock: { now: number };
  host: MaintenanceHost;
  reads: string[][];
  texts: Map<string, string>;
  embedded: string[][];
  hold: { until?: (signal: AbortSignal) => Promise<void> };
  changes: { count: number };
}

// A store with notes, an embedder, a scripted engine and an index, and this device the one that runs background work.
function set_up(options: { embedder?: boolean; hosted?: boolean; chosen?: boolean } = {}): Setup {
  const texts = new Map<string, string>();
  const reads: string[][] = [];
  const embedded: string[][] = [];
  const hold: Setup["hold"] = {};
  const fixture = start_fixture({ plugins: [notes_plugin(texts, reads), embedder_plugin(embedded, hold)], hosted: options.hosted });
  const index = new DatabaseSync(":memory:");
  open_index(index);
  use_search_index({ database: () => fixture.database, index: () => index });
  if (options.embedder) fixture.calls.set_setting("embedder", "fake-embedder");
  const clock = { now: Date.parse("2026-11-27T10:00:00") };
  const changes = { count: 0 };
  const host: MaintenanceHost = { database: () => fixture.database, index: () => index, device: "Test laptop", kind: "desktop", now: () => clock.now, on_change: () => void (changes.count += 1), wait_ms: 5 };
  use_maintenance_host(host);
  if (options.chosen !== false) register_device(fixture.database, host.device, host.kind, clock.now);
  return { ...fixture, index, clock, host, reads, texts, embedded, hold, changes };
}

function job(setup: Setup, key: string) {
  return setup.calls.list_maintenance_jobs().find((each) => each.key === key)!;
}

// Turns every job off but the ones named, so a tick looks only at those.
function only(setup: Setup, ...keys: string[]): void {
  for (const key of Object.keys(maintenance_jobs)) setup.calls.set_maintenance_job(key as never, { on: keys.includes(key) });
}

// ── Devices ──────────────────────────────────────────────────────────────────

describe("the device that runs background work", () => {
  it("is the first desktop app or server to start with none chosen, and changes only when the user chooses another", () => {
    const setup = set_up({ chosen: false });
    expect(runs_here(setup.database)).toBe(false);
    const own = register_device(setup.database, "Test laptop", "desktop", setup.clock.now);
    expect(setup.calls.get_background_state()).toMatchObject({ chosen_device: own, devices: [{ id: own, name: "Test laptop", kind: "desktop" }] });
    expect(runs_here(setup.database)).toBe(true);

    // Another device starting later, such as the server, leaves the choice alone.
    setup.database.prepare("INSERT INTO background_devices (id, name, kind, started_at) VALUES ('server-1', 'server on home', 'server', ?)").run(new Date().toISOString());
    register_device(setup.database, "Test laptop, renamed", "desktop", setup.clock.now);
    expect(setup.calls.get_background_state().chosen_device).toBe(own);
    expect(setup.calls.get_background_state().devices.map((device) => device.name)).toEqual(["Test laptop, renamed", "server on home"]);

    setup.calls.set_background_device("server-1");
    expect(runs_here(setup.database)).toBe(false);
    expect(() => setup.calls.set_background_device("nowhere")).toThrow("Choose one of the devices");
    expect(device_id_of(setup.database)).toBe(own);
  });

  it("is the only one that runs the assistant's jobs, and none runs while background work is paused", async () => {
    const setup = set_up();
    use_job_host({ database: () => setup.database, device: "Test laptop", now: () => setup.clock.now });
    setup.calls.set_setting("background.enabled", true);
    setup.calls.add_job({ title: "Look", instruction: "Look.", context_id: null, schedule: { kind: "every", every: 1, unit: "hours" }, only_when_changed: false, limits: { max_rounds: 2, max_tokens: 5000, max_runs_per_day: 4 } });
    setup.clock.now += 2 * 3_600_000;
    setup.calls.set_setting("background.paused", true);
    expect(check_jobs()).toBeNull();
    setup.database.prepare("INSERT INTO background_devices (id, name, kind, started_at) VALUES ('server-1', 'server on home', 'server', ?)").run(new Date().toISOString());
    setup.calls.set_setting("background.paused", false);
    setup.calls.set_background_device("server-1");
    expect(check_jobs()).toBeNull();
    setup.calls.set_background_device(device_id_of(setup.database));
    expect(await check_jobs()).toMatchObject({ outcome: "done", device: "Test laptop" });
  });

  it("runs only its own index and embeddings on a device not chosen", async () => {
    const setup = set_up({ embedder: true });
    setup.database.prepare("INSERT INTO background_devices (id, name, kind, started_at) VALUES ('server-1', 'server on home', 'server', ?)").run(new Date().toISOString());
    setup.calls.set_background_device("server-1");
    setup.calls.add_context("Garden");
    const report = await tick();
    expect(report.jobs.map((each) => each.key)).toEqual(["index", "embed"]);
    expect(report.jobs.every((each) => each.ran)).toBe(true);
  });
});

// ── Chosen by what changed ───────────────────────────────────────────────────

describe("a tick", () => {
  it("runs only the jobs with work, and a job with nothing to do leaves no run, only a count and why", async () => {
    const setup = set_up({ embedder: true });
    setup.calls.add_context("Garden");
    const first = await tick();
    expect(first.jobs.filter((each) => each.ran).map((each) => each.key)).toEqual(["index", "embed", "rules", "digest"]);
    // Suggest links is off until turned on, so it is not looked at.
    expect(first.jobs.some((each) => each.key === "suggest")).toBe(false);
    const runs = setup.calls.list_job_runs("maintenance:index");
    // Global and the garden.
    expect(runs).toMatchObject([{ outcome: "done", device: "Test laptop", items: 2, applied: ["Brought 2 documents of the index up to date."] }]);

    setup.clock.now += 30 * 60_000;
    const second = await tick();
    expect(second.jobs.filter((each) => each.ran)).toEqual([]);
    expect(setup.calls.list_job_runs("maintenance:index")).toHaveLength(1);
    expect(job(setup, "index")).toMatchObject({ skips_today: 1, skip_reason: "Nothing changed, so there was nothing to do.", today: { runs: 1, items: 2 } });
    // The assistant's own jobs' list and caps leave the maintenance runs out.
    expect(setup.calls.list_job_runs()).toEqual([]);
    expect(setup.calls.get_background_state().runs_today).toBe(0);
  });

  it("does nothing while background work is paused", async () => {
    const setup = set_up();
    setup.calls.set_setting("background.paused", true);
    setup.calls.add_context("Garden");
    expect(await tick()).toEqual({ reason: "Background work is paused.", jobs: [] });
    expect(setup.calls.list_job_runs("maintenance:index")).toEqual([]);
  });

  it("waits while a reply is being written, and gives up at a pause meanwhile", async () => {
    const setup = set_up();
    only(setup, "index");
    let release = () => undefined as void;
    setup.set_script(async function* () {
      await new Promise<void>((resolve) => (release = resolve));
      yield { type: "done", text: "Done." };
    });
    await setup.calls.send_message(null, "Hello");
    setup.calls.add_context("Garden");
    const waiting = tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(setup.calls.list_job_runs("maintenance:index")).toEqual([]);
    release();
    expect((await waiting).jobs).toMatchObject([{ key: "index", ran: true }]);

    setup.set_script(async function* () {
      await new Promise<void>((resolve) => (release = resolve));
      yield { type: "done", text: "Done." };
    });
    await setup.calls.send_message(null, "Again");
    setup.calls.add_context("Shed");
    const paused = tick();
    setup.calls.set_setting("background.paused", true);
    expect(await paused).toEqual({ reason: "Background work is paused.", jobs: [] });
    release();
  });

  it("comes every so many minutes, as the setting says, once the loop starts", async () => {
    const setup = set_up();
    use_maintenance_host(null);
    const loop = keep_maintaining(setup.host, 5);
    setup.calls.add_context("Garden");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle_maintenance();
    expect(setup.calls.list_job_runs("maintenance:index")).toHaveLength(1);
    setup.calls.add_context("Shed");
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Not yet: the next tick is 30 minutes on.
    expect(setup.calls.list_job_runs("maintenance:index")).toHaveLength(1);
    setup.clock.now += 30 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settle_maintenance();
    expect(setup.calls.list_job_runs("maintenance:index")).toHaveLength(2);
    await loop.stop();
  });
});

// ── Budgets ──────────────────────────────────────────────────────────────────

describe("budgets", () => {
  it("stop a job for the day once its runs are used, and it runs again the next day", async () => {
    const setup = set_up();
    only(setup, "index");
    setup.calls.set_maintenance_job("index", { budget: { runs_per_day: 1 } });
    setup.calls.add_context("Garden");
    await tick();
    setup.calls.add_context("Shed");
    const second = await tick();
    expect(second.jobs).toMatchObject([{ key: "index", ran: false, reason: "It used today's 1 run; it runs again tomorrow." }]);
    expect(job(setup, "index").used_up).toContain("It used today's 1 run");
    setup.clock.now += day;
    expect((await tick()).jobs).toMatchObject([{ key: "index", ran: true }]);
    expect(job(setup, "index").today.runs).toBe(1);
  });

  it("handle at most so many in one run, the rest waiting for the next", async () => {
    const setup = set_up();
    only(setup, "index");
    const garden = setup.calls.add_context("Garden");
    for (const id of ["a", "b", "c"]) {
      setup.texts.set(id, `Text of ${id}`);
      setup.calls.add_item([garden], "notes", { source_id: id, kind: "note", title: id });
    }
    setup.calls.set_maintenance_job("index", { budget: { items_per_run: 1 } });
    await tick();
    expect(setup.reads).toEqual([["a"]]);
    expect(setup.calls.list_job_runs("maintenance:index")[0]!.note).toBe("2 items' text wait for the next run.");
    setup.clock.now += 60_000;
    await tick();
    setup.clock.now += 60_000;
    await tick();
    expect(setup.reads).toEqual([["a"], ["b"], ["c"]]);
  });

  it("are checked and set by the user alone", () => {
    const setup = set_up();
    expect(() => setup.calls.set_maintenance_job("index", { budget: { runs_per_day: 1000 } })).toThrow("runs_per_day is a whole number from 0 to 288");
    expect(() => setup.calls.set_maintenance_job("index", { budget: { loud: 1 } as never })).toThrow("A budget holds");
    expect(() => setup.calls.set_maintenance_job("nothing" as never, { on: true })).toThrow("A maintenance job is one of");
    expect(() => setup.calls.set_maintenance_job("index", { on: "yes" as never })).toThrow("Turn a job on with true");
    setup.calls.set_maintenance_job("embed", { budget: { items_per_run: 10 } });
    setup.calls.set_maintenance_job("embed", { on: false });
    expect(job(setup, "embed")).toMatchObject({ on: false, budget: { items_per_run: 10, runs_per_day: 48 } });
    expect(page_only_methods.has("set_maintenance_job")).toBe(true);
    expect(page_only.is_page_only_call("set_maintenance_job", [])).toBe(true);
    for (const key of ["maintenance.jobs", "background.paused", "background.device", "background.tick_minutes", "background.hosted"]) expect(user_only_settings.has(key)).toBe(true);
    expect(page_only.is_page_only_call("list_maintenance_jobs", [])).toBe(false);
  });
});

// ── The jobs ─────────────────────────────────────────────────────────────────

describe("embedding", () => {
  it("is skipped with a plain reason without an embedder, embeds within its budget, and stops at a pause", async () => {
    const setup = set_up();
    only(setup, "index", "embed");
    setup.calls.add_context("Garden", null);
    expect((await tick()).jobs[1]).toMatchObject({ key: "embed", ran: false, reason: expect.stringContaining("No embedder is chosen") });

    setup.calls.set_setting("embedder", "fake-embedder");
    setup.calls.set_maintenance_job("embed", { budget: { items_per_run: 1 } });
    setup.calls.add_context("Shed", null);
    setup.clock.now += 60_000;
    await tick();
    expect(setup.embedded.flat()).toHaveLength(1);
    expect(setup.calls.list_job_runs("maintenance:embed")[0]).toMatchObject({ items: 1, note: "2 pieces wait for the next run." });

    // Held by the embedder, the run gives way when background work is paused.
    setup.hold.until = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    setup.clock.now += 60_000;
    const running = run_maintenance_job(setup.host, "embed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    setup.calls.set_setting("background.paused", true);
    await running;
    expect(setup.calls.list_job_runs("maintenance:embed")[0]).toMatchObject({ outcome: "gave_way", note: expect.stringContaining("It stopped for a pause or a conversation") });
  });
});

describe("similar items", () => {
  it("compare the items given new vectors, and empty their queue", async () => {
    const setup = set_up({ embedder: true });
    only(setup, "index", "embed", "similarity");
    const garden = setup.calls.add_context("Garden");
    for (const id of ["a", "b"]) setup.calls.add_item([garden], "notes", { source_id: id, kind: "note", title: `Note ${id}` });
    await tick();
    expect(setup.calls.list_job_runs("maintenance:similarity")).toMatchObject([{ items: 2, outcome: "done" }]);
    expect(count_changed(setup.index, "similarity")).toBe(0);
  });
});

describe("tidying the graph", () => {
  function gone_item(setup: Setup): { garden: string; seeds: string; shop: string } {
    const garden = setup.calls.add_context("Garden");
    const seeds = setup.calls.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds" });
    const shop = setup.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop", uri: "https://example.org/seeds" });
    setup.database.prepare("UPDATE items SET status = 'missing' WHERE id = ?").run(seeds);
    return { garden, seeds, shop };
  }

  it("proposes ending a link the user made to an item gone from its app, ends it once approved, and never deletes it", async () => {
    const setup = set_up();
    only(setup, "tidy");
    const { seeds, shop } = gone_item(setup);
    const link = setup.calls.add_graph_link(shop, seeds, "related_to", "for");
    await tick();
    const [proposal] = setup.calls.list_proposals(null, "waiting");
    expect(proposal).toMatchObject({ method: "close_graph_link", arguments: { id: link }, summary: "End the link “Seed shop related to (for) Order seeds”, since Order seeds is gone from its app.", conversation_id: "maintenance" });
    expect(setup.calls.list_inbox().find((entry) => entry.kind === "change")).toMatchObject({ made_by: "background maintenance", conversation_title: "Background maintenance" });
    // Its conversation is a background job's, never the pane's default.
    expect(setup.calls.list_conversations(null).find((each) => each.id === "maintenance")!.job).toEqual({ title: "Tidy the graph" });
    expect(setup.calls.get_node_links(shop).links[0]!.valid_until).toBe("");
    // Asked once, it is not asked again.
    setup.clock.now += day;
    expect((await tick()).jobs).toMatchObject([{ key: "tidy", ran: false }]);

    await setup.calls.resolve_proposal(proposal!.id, "approve");
    const [ended] = setup.calls.get_node_links(shop).links;
    expect(ended!.id).toBe(link);
    expect(ended!.valid_until).not.toBe("");
    expect(setup.calls.get_conversation("maintenance").messages.at(-1)!.text).toContain("Approved and done: End the link");
  });

  it("ends such a link at once at the background level, and refuses nothing it may not", async () => {
    const setup = set_up();
    only(setup, "tidy");
    const { seeds, shop } = gone_item(setup);
    setup.calls.set_action_level("close_graph_link", "background");
    setup.calls.add_graph_link(shop, seeds, "related_to");
    await tick();
    expect(setup.calls.list_proposals(null, "waiting")).toEqual([]);
    expect(setup.calls.get_node_links(shop).links[0]!.valid_until).not.toBe("");
    expect(setup.calls.list_job_runs("maintenance:tidy")[0]!.applied[0]).toContain("Ended the link “Seed shop related to Order seeds”");
    expect(setup.changes.count).toBe(1);

    setup.calls.set_action_level("close_graph_link", "restricted");
    const other = setup.calls.add_item([setup.calls.list_contexts()[0]!.id], "links", { source_id: "https://example.org/b", kind: "link", title: "B" });
    setup.calls.add_graph_link(other, seeds, "mentions");
    setup.clock.now += day;
    await tick();
    expect(setup.calls.list_proposals(null, "waiting")).toEqual([]);
    expect(setup.calls.list_job_runs("maintenance:tidy")[0]!.note).toContain("since ending links is restricted");
  });

  it("proposes joining entities of one kind that share a name, once", async () => {
    const setup = set_up();
    only(setup, "tidy");
    const first = setup.calls.add_entity("person", "Ada Lovelace");
    const second = setup.calls.add_entity("person", "Ada King", ["ada  lovelace"]);
    setup.calls.add_entity("topic", "Ada Lovelace");
    await tick();
    const proposed = setup.calls.list_graph_proposals().links;
    expect(proposed).toMatchObject([{ type: "same_as", made_by: "rule", rule: "same_name", status: "proposed" }]);
    // Finding something new leaves the assistant mildly curious.
    expect(mood_state(setup.database, setup.clock.now)).toMatchObject({ mood: "curious", reason: "Tidy the graph found something new.", strength: 0.4 });
    expect([proposed[0]!.from, proposed[0]!.to].sort()).toEqual([`entity:${first}`, `entity:${second}`].sort());
    setup.calls.reject_graph_proposals([proposed[0]!.id]);
    setup.clock.now += day;
    expect((await tick()).jobs).toMatchObject([{ key: "tidy", ran: false, reason: "Nothing changed, so there was nothing to do." }]);
  });
});

describe("Suggest links in the background", () => {
  // The scripted engine proposes one entity each time it is asked.
  function proposing(setup: Setup): void {
    setup.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "propose_entity", arguments: { kind: "topic", name: "Seeds" } };
      const outcome = await request.tools.call("propose_entity", { kind: "topic", name: "Seeds" });
      yield { type: "tool_result", id: "t1", ...outcome };
      yield { type: "usage", input_tokens: 1000, output_tokens: 200 };
      yield { type: "done", text: "Proposed Seeds." };
    });
  }

  it("is off until turned on, and runs for a context whose items changed, offered only its tools, with nobody present", async () => {
    const setup = set_up();
    only(setup);
    expect((await run_maintenance_job(setup.host, "suggest"))).toMatchObject({ ran: false, reason: "It is turned off." });
    only(setup, "suggest");
    const garden = setup.calls.add_context("Garden");
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop" });
    proposing(setup);
    await tick();
    const [run] = setup.calls.list_job_runs("maintenance:suggest");
    expect(run).toMatchObject({ outcome: "done", items: 1, engine: "Fake", rounds: 1, input_tokens: 1000, output_tokens: 200 });
    expect(run!.proposed[0]).toContain("Garden: Suggest links proposed 1 entity and 0 links");
    expect(setup.requests[0]!.tools.definitions.map((tool) => tool.name).sort()).toEqual(["get_item", "list_graph_proposals", "propose_entity", "propose_link", "propose_link_drop", "read_tool_result", "search_index"]);
    expect(setup.calls.list_graph_proposals().entities).toMatchObject([{ name: "Seeds", made_by: "engine" }]);
    expect(setup.calls.get_conversation(run!.conversation_id).title).toBe("Suggest links (background)");

    // Nothing changed since, so no model call.
    setup.clock.now += 60 * 60_000;
    expect((await tick()).jobs).toMatchObject([{ key: "suggest", ran: false, reason: "Nothing changed, so there was nothing to do." }]);
    expect(setup.requests).toHaveLength(1);

    // A change runs it again, in the same conversation.
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/tools", kind: "link", title: "Tool shop" });
    await tick();
    expect(setup.calls.list_job_runs("maintenance:suggest")[0]!.conversation_id).toBe(run!.conversation_id);
  });

  it("stops for the day once its tokens are used", async () => {
    const setup = set_up();
    only(setup, "suggest");
    setup.calls.set_maintenance_job("suggest", { budget: { tokens_per_day: 1000 } });
    const garden = setup.calls.add_context("Garden");
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop" });
    proposing(setup);
    await tick();
    expect(job(setup, "suggest").used_up).toBe("It used today's 1,000 tokens; it runs again tomorrow.");
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/tools", kind: "link", title: "Tool shop" });
    expect((await tick()).jobs).toMatchObject([{ key: "suggest", ran: false, reason: "It used today's 1,000 tokens; it runs again tomorrow." }]);
    expect(setup.requests).toHaveLength(1);
  });

  it("uses a hosted engine only when the user allows it, and says why it waits otherwise", async () => {
    const setup = set_up({ hosted: true });
    only(setup, "suggest");
    const garden = setup.calls.add_context("Garden");
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/seeds", kind: "link", title: "Seed shop" });
    proposing(setup);
    expect((await tick()).jobs).toMatchObject([{ key: "suggest", ran: false, reason: expect.stringContaining("is hosted, and background work uses only an engine on this computer or your own network") }]);
    expect(job(setup, "suggest").skip_reason).toContain("unless you allow a hosted one");
    expect(setup.requests).toEqual([]);

    setup.calls.set_setting("background.hosted", true);
    await tick();
    expect(setup.requests).toHaveLength(1);
    // The source marks still hold: the unmarked link is withheld, and the hosted log has the run.
    expect(JSON.stringify(setup.requests[0])).not.toContain("Seed shop");
    expect(setup.calls.list_hosted_sends()[0]).toMatchObject({ kind: "reply", engine: "Fake" });

    setup.calls.set_setting("engine", "");
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/b", kind: "link", title: "B" });
    expect((await tick()).jobs).toMatchObject([{ key: "suggest", ran: false, reason: expect.stringContaining("No engine is set up") }]);
  });
});

describe("the digest", () => {
  it("is one Inbox entry a day saying what the loop did and what waits, and skipped when there is nothing to say", async () => {
    const setup = set_up();
    only(setup, "digest");
    expect(digest_lines(setup.database, setup.clock.now)).toEqual([]);
    expect((await tick()).jobs).toMatchObject([{ key: "digest", ran: false, reason: "Nothing changed, so there was nothing to do." }]);

    only(setup, "index", "rules", "tidy", "digest");
    const garden = setup.calls.add_context("Garden");
    setup.calls.add_entity("person", "Ada");
    setup.calls.add_entity("person", "Ada Byron", ["Ada"]);
    setup.calls.add_item([garden], "x-tasks", { source_id: "t1", kind: "task", title: "Order seeds", uri: "x-tasks://task/t1" });
    setup.calls.add_item([garden], "links", { source_id: "https://example.org/a", kind: "link", title: "Shop", snippet: "For x-tasks://task/t1." });
    setup.calls.set_maintenance_job("index", { budget: { runs_per_day: 1 } });
    await tick();
    setup.calls.add_context("Shed");
    setup.clock.now += 60_000;
    await tick();
    const digest = setup.calls.list_inbox().find((entry) => entry.kind === "digest")!;
    expect(digest.title).toMatch(/^Background work, 2026-11-2\d$/);
    expect(digest.run!.applied).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Refresh the index: Brought \d+ documents of the index up to date\./),
        "Links from rules: The rules made 1 link.",
        "Tidy the graph: Proposed joining 1 pair of entities that share a name.",
        expect.stringMatching(/^Refresh the index stopped for the day on Test laptop: It used today's 1 run/),
        "Waiting for you in the Inbox: 1.",
      ]),
    );
    // Once a day.
    setup.clock.now += 60_000;
    expect((await tick()).jobs.find((each) => each.key === "digest")).toMatchObject({ ran: false, reason: "It used today's 1 run; it runs again tomorrow." });
    expect(await setup.calls.dismiss_job_runs([digest.id])).toBe(1);
    expect(setup.calls.list_inbox().some((entry) => entry.kind === "digest")).toBe(false);
  });
});

describe("a job that fails", () => {
  it("is kept as failed and listed in the Inbox, opening Settings", async () => {
    const setup = set_up({ embedder: true });
    only(setup, "index", "embed");
    setup.hold.until = async () => {
      throw new Error("the model is away");
    };
    setup.calls.add_context("Garden");
    await tick();
    expect(setup.calls.list_job_runs("maintenance:embed")[0]).toMatchObject({ outcome: "error", note: "the model is away" });
    expect(mood_state(setup.database, setup.clock.now)).toMatchObject({ mood: "concerned", reason: "Embed documents failed.", by: "event" });
    expect(setup.calls.list_inbox()).toMatchObject([{ kind: "job_run", title: "Failed: Embed documents", made_by: "background maintenance", route: "#/settings" }]);
    // The Jobs page's list of the assistant's runs leaves them out.
    expect(setup.calls.list_job_runs()).toEqual([]);
  });
});
