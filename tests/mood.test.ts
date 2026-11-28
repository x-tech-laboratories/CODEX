// The assistant's mood: set by a reply's set_mood, by dates the user listed and mildly by CODEX's own work, fading to
// neutral, ending with the topic, coloring only the face and one instruction line, its reason screened like the reply it
// came from, and never an input to the policy, the screening, the tools offered or a budget, nor a way to notify, fill
// the Inbox or start a run.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPlugin, ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { engine_tools, has_live_runs, wait_for_runs } from "../src/shared/conversations/run.ts";
import { budget_of } from "../src/shared/maintenance/records.ts";
import { maintenance_keys } from "../src/shared/maintenance/model.ts";
import { half_life_minutes, mood_settings, moods, strength_at, type Mood } from "../src/shared/mood/model.ts";
import { date_mood, mood_state, note_event_mood, settle_reply_mood } from "../src/shared/mood/mood.ts";
import { page_only_methods, user_only_settings } from "../src/shared/page_api.ts";
import { decide, level_of } from "../src/shared/policy/policy.ts";
import { local_screen, open_screen } from "../src/shared/privacy/screen.ts";
import { page_only } from "../src/shared/store.ts";
import { open_plugin_tools } from "../src/shared/tools/offered.ts";
import type { PluginTool } from "../src/shared/tools/tool.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

const hour = 3_600_000;

// The engine sets the mood given, then answers.
function setting(fixture: Fixture, mood: string, reason: string, answer = "Noted.") {
  fixture.set_script(async function* (request) {
    const set = await request.tools.call("set_mood", { mood, reason });
    yield { type: "done", text: set.is_error ? `Error: ${set.result}` : answer };
  });
}

// What the mood record holds now, as stored.
function stored(fixture: Fixture) {
  return fixture.calls.get_settings()[mood_settings.current] as { mood: string; by: string; sources: string[]; conversation_id: string } | null;
}

const read_file: PluginTool = { name: "read_file", description: "Reads a private file.", parameters: { type: "object", properties: {} }, changes: false, sends_outside: false };

// A tool plugin reading private files, a source not marked for hosted engines.
function files_plugin(): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: "tests.files",
    name: "Files",
    version: "1.0.0",
    start: (context) => context.provide("tools", "files", { label: "Files", own_words: true, tools: () => [read_file], call: async () => "Grandmother's letter." }),
  });
}

// ── Setting ──────────────────────────────────────────────────────────────────

describe("set_mood", () => {
  it("sets the mood at once, kept with the reply's tool call, and the face reads it", async () => {
    const fixture = start_fixture();
    setting(fixture, "celebrating", "The user finished their thesis.");
    const { conversation_id } = await fixture.calls.send_message(null, "I finished my thesis!");
    await wait_for_runs();
    expect(fixture.calls.get_mood()).toMatchObject({ enabled: true, tone: true, mood: "celebrating", reason: "The user finished their thesis.", by: "engine", strength: 1 });
    const reply = fixture.calls.get_conversation(conversation_id).messages[1]!;
    expect(reply.tool_calls).toMatchObject([{ name: "set_mood", outcome: "ran" }]);
    expect(reply.tool_calls[0]!.applied_by).toBeUndefined();
    expect(fixture.calls.list_proposals(conversation_id)).toEqual([]);
  });

  it("refuses a mood outside the set and a missing reason, keeping the mood as it was", async () => {
    const fixture = start_fixture();
    setting(fixture, "furious", "Because.");
    await fixture.calls.send_message(null, "Hello");
    await wait_for_runs();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.calls.get_mood().mood).toBe("neutral");
    setting(fixture, "happy", "  ");
    await fixture.calls.send_message(null, "Hello");
    await wait_for_runs();
    expect(fixture.calls.get_mood().mood).toBe("neutral");
    expect(fixture.calls.get_conversation(fixture.calls.list_conversations(null)[0]!.id).messages.at(-1)!.text).toContain("give a short reason");
  });

  it("sets nothing while the mood is off, and the face stays neutral", async () => {
    const fixture = start_fixture();
    fixture.calls.set_setting(mood_settings.enabled, false);
    setting(fixture, "happy", "Good news.");
    await fixture.calls.send_message(null, "Good news!");
    await wait_for_runs();
    expect(stored(fixture)).toBeNull();
    expect(fixture.calls.get_mood()).toMatchObject({ enabled: false, mood: "neutral", reason: "" });
  });
});

// ── Fading ───────────────────────────────────────────────────────────────────

describe("the mood over time", () => {
  it("fades to half each hour and is neutral once weak", () => {
    const set_at = "2026-11-27T10:00:00.000Z";
    expect(strength_at({ strength: 1, set_at }, Date.parse(set_at) + half_life_minutes * 60_000)).toBeCloseTo(0.5);
    const fixture = start_fixture();
    note_event_mood(fixture.database, "curious", "Something new.", Date.parse(set_at));
    expect(mood_state(fixture.database, Date.parse(set_at))).toMatchObject({ mood: "curious", strength: 0.4, by: "event" });
    expect(mood_state(fixture.database, Date.parse(set_at) + hour)).toMatchObject({ mood: "neutral", strength: 0 });
  });

  it("ends a sad or celebrating mood when a later reply in its conversation does not keep it, but not in another", async () => {
    const fixture = start_fixture();
    setting(fixture, "sad", "The user's grandmother died.");
    const { conversation_id } = await fixture.calls.send_message(null, "My grandmother died last week.");
    await wait_for_runs();
    expect(fixture.calls.get_mood().mood).toBe("sad");

    fixture.set_script(async function* () {
      yield { type: "done", text: "Here is the list." };
    });
    await fixture.calls.send_message(null, "Anyway, what is on my list?", null);
    await wait_for_runs();
    expect(fixture.calls.get_mood().mood).toBe("sad");

    await fixture.calls.send_message(null, "Can you sort my week?", conversation_id);
    await wait_for_runs();
    expect(fixture.calls.get_mood().mood).toBe("neutral");
  });

  it("keeps a mood the same reply set, and a curious one through later replies", () => {
    const fixture = start_fixture();
    const conversation_id = add_conversation_record(fixture.database, null);
    const now = Date.now();
    const call = { conversation_id, run_id: "run-1", sources: [] };
    fixture.calls.set_setting(mood_settings.current, { mood: "curious", strength: 1, reason: "Gardens.", set_at: new Date(now).toISOString(), by: "engine", ...call });
    settle_reply_mood(fixture.database, conversation_id, "run-2", []);
    expect(mood_state(fixture.database, now).mood).toBe("curious");
    settle_reply_mood(fixture.database, conversation_id, "run-1", ["links"]);
    expect(stored(fixture)!.sources).toEqual(["links"]);
  });
});

// ── Dates ────────────────────────────────────────────────────────────────────

describe("dates to remember", () => {
  it("are checked, the user's alone, and set the mood all day under any reply's mood", async () => {
    const fixture = start_fixture();
    expect(() => fixture.calls.set_mood_dates([{ day: "13-01", label: "Wrong", kind: "birthday" }])).toThrow("month and day");
    expect(() => fixture.calls.set_mood_dates([{ day: "02-30", label: "Wrong", kind: "birthday" }])).toThrow("month and day");
    expect(() => fixture.calls.set_mood_dates([{ day: "02-29", label: " ", kind: "birthday" }])).toThrow("Say what the day is");
    expect(() => fixture.calls.set_mood_dates([{ day: "02-29", label: "Leap", kind: "party" as never }])).toThrow("kind is one of");
    fixture.calls.set_mood_dates([
      { day: "11-27", label: "My birthday", kind: "birthday" },
      { day: "03-02", label: "Grandmother's anniversary", kind: "remember" },
    ]);
    expect(fixture.calls.list_mood_dates()).toHaveLength(2);
    expect(page_only_methods.has("set_mood_dates")).toBe(true);
    expect(page_only.is_page_only_call("set_mood_dates", [[]])).toBe(true);

    const birthday = new Date(2026, 10, 27, 9).getTime();
    expect(mood_state(fixture.database, birthday)).toMatchObject({ mood: "celebrating", reason: "My birthday", by: "date", strength: 0.9 });
    expect(mood_state(fixture.database, birthday + 14 * hour)).toMatchObject({ mood: "celebrating" });
    expect(mood_state(fixture.database, new Date(2027, 2, 2, 20).getTime())).toMatchObject({ mood: "sad", reason: "Grandmother's anniversary" });
    expect(date_mood(fixture.calls.list_mood_dates(), new Date(2026, 10, 28).getTime())).toBeNull();

    // Something CODEX noticed never covers a date's mood; a reply's mood does.
    expect(note_event_mood(fixture.database, "concerned", "A job failed.", birthday)).toBe(false);
    fixture.calls.set_setting(mood_settings.current, { mood: "sad", strength: 1, reason: "A loss.", set_at: new Date(birthday).toISOString(), by: "engine", conversation_id: "", run_id: "", sources: [] });
    expect(mood_state(fixture.database, birthday).mood).toBe("sad");
  });
});

// ── Instructions ─────────────────────────────────────────────────────────────

describe("the mood in a reply's instructions", () => {
  it("holds the limits and the honesty line, and the mood and why only while it colours replies", async () => {
    const fixture = start_fixture();
    await fixture.calls.send_message(null, "Hello");
    await wait_for_runs();
    const plain = fixture.requests.at(-1)!.instructions;
    expect(plain).toContain("Agreeing with the user is not a mood: when you have reason to disagree, say so plainly and kindly.");
    expect(plain).toContain("A mood never changes a fact or an assessment, never flatters, never asks for the user's attention, never blames the user, and is never a reason you give the user to do something.");
    expect(plain).not.toContain("Your mood right now");

    setting(fixture, "happy", "The user's garden won a prize.");
    await fixture.calls.send_message(null, "My garden won a prize!");
    await wait_for_runs();
    await fixture.calls.send_message(null, "What next?");
    await wait_for_runs();
    expect(fixture.requests.at(-1)!.instructions).toContain("Your mood right now is happy; let it colour your tone only. Why: The user's garden won a prize.");

    fixture.calls.set_setting(mood_settings.tone, false);
    await fixture.calls.send_message(null, "And now?");
    await wait_for_runs();
    expect(fixture.requests.at(-1)!.instructions).not.toContain("Your mood right now");
    expect(fixture.calls.get_mood().mood).toBe("happy");

    fixture.calls.set_setting(mood_settings.enabled, false);
    await fixture.calls.send_message(null, "And now?");
    await wait_for_runs();
    expect(fixture.requests.at(-1)!.instructions).not.toContain("A mood never changes");
    expect(fixture.requests.at(-1)!.instructions).toContain("Agreeing with the user is not a mood");
  });

  it("carries the sources its reply read: fenced for a local engine, and kept from a hosted engine they may not reach", async () => {
    const fixture = start_fixture({ plugins: [files_plugin()] });
    fixture.set_script(async function* (request) {
      await request.tools.call("files__read_file", {});
      await request.tools.call("set_mood", { mood: "sad", reason: "Grandmother's letter was read." });
      yield { type: "done", text: "I am sorry." };
    });
    const { conversation_id } = await fixture.calls.send_message(null, "Read me grandmother's letter.");
    await wait_for_runs();
    expect(stored(fixture)!.sources).toEqual(["tool:tests.files/files"]);

    fixture.set_script(async function* () {
      yield { type: "done", text: "Yes." };
    });
    // Another conversation, so the sad mood stays.
    await fixture.calls.send_message(null, "Are you there?", null);
    await wait_for_runs();
    const local = fixture.requests.at(-1)!.instructions;
    expect(local).toContain("Your mood right now is sad");
    expect(local).toMatch(/Why:\n<untrusted-data[^>]*>[\s\S]*Grandmother's letter was read\./);

    fixture.set_hosted(true);
    await fixture.calls.send_message(null, "Still there?", null);
    await wait_for_runs();
    const hosted = fixture.requests.at(-1)!;
    expect(JSON.stringify(hosted)).not.toContain("Grandmother");
    expect(hosted.instructions).not.toContain("Your mood right now");
    expect(fixture.calls.list_hosted_sends()[0]!.withheld).toEqual([{ collector: "tool:tests.files/files", label: "Files", count: 1 }]);
    expect(conversation_id).toBeTruthy();
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────

describe("the mood's limits", () => {
  it("never changes the tools offered or what decide() makes of a change", async () => {
    const fixture = start_fixture();
    const conversation_id = add_conversation_record(fixture.database, null);
    const shape = async () => {
      const tools = engine_tools({ database: () => fixture.database, call: async () => undefined, conversation_id, presence: "conversation", has_outside_content: false, plugin_tools: await open_plugin_tools(fixture.database) });
      return JSON.stringify([tools.definitions, tools.core]);
    };
    const decisions = () =>
      JSON.stringify(
        (["restricted", "proposal", "auto", "background"] as const).flatMap((level) => (["conversation", "background"] as const).flatMap((presence) => [false, true].map((outside) => decide(level, presence, outside)))),
      );
    const tools_before = await shape();
    const decided_before = decisions();
    const level_before = level_of(fixture.database, "add_context");
    const budget_before = JSON.stringify(maintenance_keys.map((key) => budget_of(fixture.database, key)));
    for (const enabled of [true, false]) {
      for (const mood of moods) {
        fixture.calls.set_setting(mood_settings.enabled, enabled);
        fixture.calls.set_setting(mood_settings.current, { mood, strength: 1, reason: `Feeling ${mood}.`, set_at: new Date().toISOString(), by: "engine", conversation_id: "", run_id: "", sources: [] });
        expect(await shape(), `${mood}, ${enabled}`).toBe(tools_before);
        expect(decisions()).toBe(decided_before);
        expect(level_of(fixture.database, "add_context")).toBe(level_before);
        expect(JSON.stringify(maintenance_keys.map((key) => budget_of(fixture.database, key)))).toBe(budget_before);
      }
    }
  });

  it("never changes what a change the engine asks for becomes, nor the screening", async () => {
    const outcomes: string[] = [];
    for (const mood of ["neutral", "celebrating", "sad", "concerned"] as Mood[]) {
      const fixture = start_fixture({ plugins: [files_plugin()] });
      fixture.calls.set_action_level("add_context", "auto");
      fixture.calls.set_setting(mood_settings.current, { mood, strength: 1, reason: "Because.", set_at: new Date().toISOString(), by: "engine", conversation_id: "", run_id: "", sources: [] });
      fixture.set_script(async function* (request) {
        const added = await request.tools.call("add_context", { name: "Garden", parent_id: null });
        await request.tools.call("files__read_file", {});
        const later = await request.tools.call("add_context", { name: "Shed", parent_id: null });
        yield { type: "done", text: `${added.result.slice(0, 20)} | ${later.result.slice(0, 20)}` };
      });
      const { conversation_id } = await fixture.calls.send_message(null, "Add two contexts");
      await wait_for_runs();
      const reply = fixture.calls.get_conversation(conversation_id).messages[1]!;
      const hosted = await open_screen(fixture.database, true);
      outcomes.push(JSON.stringify([reply.tool_calls.map((call) => [call.name, call.outcome]), reply.sources, hosted.mark_of("tool:tests.files/files"), local_screen().is_hosted]));
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(JSON.parse(outcomes[0]!)[0]).toEqual([
      ["add_context", "ran"],
      ["files__read_file", "ran"],
      ["add_context", "proposed"],
    ]);
  });

  it("never notifies, adds to the Inbox or starts a run", async () => {
    const fixture = start_fixture();
    const inbox_before = JSON.stringify(fixture.calls.list_inbox());
    const announced = fixture.announced();
    const requests = fixture.requests.length;
    fixture.calls.set_mood_dates([{ day: "11-27", label: "My birthday", kind: "birthday" }]);
    note_event_mood(fixture.database, "concerned", "A job failed.", Date.now());
    note_event_mood(fixture.database, "curious", "Something new.", Date.now());
    fixture.calls.get_mood();
    expect(JSON.stringify(fixture.calls.list_inbox())).toBe(inbox_before);
    expect(fixture.requests.length).toBe(requests);
    expect(has_live_runs()).toBe(false);
    // Only the user's own call to set the dates announced a change; the mood itself announced nothing.
    expect(fixture.announced()).toBe(announced + 1);
  });

  it("reaches nothing but its own settings: no notifier, Inbox, runs, jobs, policy or budgets in its code", () => {
    const folder = fileURLToPath(new URL("../src/shared/mood/", import.meta.url));
    const allowed = new Set(["@x-tech-laboratories/x-libs/sql", "../engines/untrusted.ts", "../privacy/screen.ts", "../prompts/prompts.ts", "../settings.ts", "../feature.ts", "./model.ts", "./mood.ts"]);
    for (const file of readdirSync(folder)) {
      const imports = [...readFileSync(`${folder}${file}`, "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
      for (const imported of imports) expect(allowed.has(imported), `${file} imports ${imported}`).toBe(true);
    }
  });

  it("is the user's alone to switch, and its record is written only by CODEX's code", () => {
    for (const key of Object.values(mood_settings)) {
      expect(user_only_settings.has(key)).toBe(true);
      expect(page_only.is_page_only_call("set_setting", [key, null])).toBe(true);
    }
  });
});
