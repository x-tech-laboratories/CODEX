// The assistant's task list: kept with its conversation, written by the run's set_task_list, which gives it back,
// told to the next reply while steps are open, reminded of after each call, kept by a specialist too, and cleared from the
// page; with the rule to work one step at a time in every run's and specialist's instructions.
import { afterEach, describe, expect, it } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { one_at_a_time_line } from "../src/shared/conversations/instructions.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { engine_tools, wait_for_runs, type ToolContext } from "../src/shared/conversations/run.ts";
import { own_specialists, specialist_instructions } from "../src/shared/conversations/specialists.ts";
import {
  calls_before_nudge,
  clean_steps,
  current_step,
  longest_step,
  most_steps,
  no_list_reminder,
  parse_task_list,
  task_list_part,
  task_list_reminder,
  task_list_text,
} from "../src/shared/conversations/task_list.ts";
import { open_screen } from "../src/shared/privacy/screen.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

async function talk(fixture: Fixture, text: string, conversation_id?: string | null): Promise<string> {
  const { conversation_id: id } = await fixture.calls.send_message(null, text, conversation_id);
  await wait_for_runs();
  return id;
}

// A run's tools in a conversation, keeping its task list unless told not to.
async function tools_of(fixture: Fixture, task_list = true) {
  const conversation_id = add_conversation_record(fixture.database, null);
  const context: ToolContext = {
    database: () => fixture.database,
    call: async (method, args) => (fixture.calls as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args),
    conversation_id,
    presence: "conversation",
    has_outside_content: false,
    screen: await open_screen(fixture.database, false),
    task_list,
  };
  return { conversation_id, tools: engine_tools(context) };
}

describe("a task list's steps", () => {
  it("are cleaned to a step, a known status and a note, todo unless given", () => {
    expect(clean_steps([{ step: "  Look at   the first  " }, { step: "Decide", status: "doing", note: "Kept: about the garden." }])).toEqual([
      { step: "Look at the first", status: "todo", note: "" },
      { step: "Decide", status: "doing", note: "Kept: about the garden." },
    ]);
    expect(clean_steps([{ step: "x".repeat(longest_step + 50) }])[0]!.step).toHaveLength(longest_step);
  });

  it("refuse what is not a list of steps, a step with no text, an unknown status and too many", () => {
    expect(() => clean_steps("one")).toThrow("steps must be a list.");
    expect(() => clean_steps([{ step: " " }])).toThrow("Step 1 has no text.");
    expect(() => clean_steps([{ step: "A", status: "maybe" }])).toThrow("Step 1's status must be one of todo, doing, done, skipped.");
    expect(() => clean_steps(Array.from({ length: most_steps + 1 }, () => ({ step: "A" })))).toThrow(`at most ${most_steps} steps`);
  });

  it("read back from what was kept, leaving out whatever no longer reads as a step", () => {
    expect(parse_task_list('[{"step":"A","status":"done"},{"step":""},7]')).toEqual([{ step: "A", status: "done", note: "" }]);
    expect(parse_task_list("not json")).toEqual([]);
  });

  it("say which step is being worked on, where the list stands, and nothing once every step is closed", () => {
    const steps = clean_steps([{ step: "First", status: "done", note: "kept" }, { step: "Second" }, { step: "Third", status: "doing" }]);
    expect(current_step(steps)).toMatchObject({ at: 2 });
    expect(task_list_text(steps)).toBe("1. [done] First — kept\n2. [todo] Second\n3. [doing] Third");
    expect(task_list_reminder(steps)).toBe("[Task list: 1 of 3 steps closed; now step 3: “Third”. When it is done, mark it done in set_task_list with what you decided, then start the next.]");
    expect(task_list_part(steps)).toContain("Carry on from the step being worked on");
    const closed = clean_steps([{ step: "First", status: "done" }, { step: "Second", status: "skipped" }]);
    expect(task_list_reminder(closed)).toBe("");
    expect(task_list_part(closed)).toBe("");
  });
});

describe("a run's task list", () => {
  it("is written by set_task_list, kept with the conversation and given back", async () => {
    const fixture = start_fixture();
    const { conversation_id, tools } = await tools_of(fixture);
    expect(tools.definitions.map((each) => each.name)).toContain("set_task_list");
    expect(tools.core!.map((each) => each.name)).toContain("set_task_list");

    const set = await tools.call("set_task_list", { steps: [{ step: "Review the first proposal", status: "doing" }, { step: "Review the second" }] });
    expect(set).toMatchObject({ is_error: false });
    expect(set.result).toContain("Now step 1: “Review the first proposal”.");
    expect(fixture.calls.get_conversation(conversation_id).task_list).toEqual([
      { step: "Review the first proposal", status: "doing", note: "" },
      { step: "Review the second", status: "todo", note: "" },
    ]);
    expect(set.result).toContain("1. [doing] Review the first proposal\n2. [todo] Review the second");

    const bad = await tools.call("set_task_list", { steps: [{ step: "" }] });
    expect(bad).toMatchObject({ is_error: true, result: "Tool error: Step 1 has no text." });
    expect(fixture.calls.get_conversation(conversation_id).task_list).toHaveLength(2);

    expect((await tools.call("set_task_list", { steps: [] })).result).toBe("Your task list is cleared.");
    expect(fixture.calls.get_conversation(conversation_id).task_list).toEqual([]);
  });

  it("is reminded after each other call while a step is open, and nudged once a few calls into a job with none", async () => {
    const fixture = start_fixture();
    const { tools } = await tools_of(fixture);
    const reads = [];
    for (let made = 0; made < calls_before_nudge + 1; made += 1) reads.push((await tools.call("list_contexts", {})).result);
    expect(reads.map((each) => each.endsWith(no_list_reminder))).toEqual(Array.from({ length: calls_before_nudge + 1 }, (_, at) => at + 1 === calls_before_nudge));

    await tools.call("set_task_list", { steps: [{ step: "Done already", status: "done" }, { step: "Look at the contexts" }] });
    expect((await tools.call("list_contexts", {})).result).toMatch(/\n\[Task list: 1 of 2 steps closed; now step 2: “Look at the contexts”\./);
    // Writing the list carries no reminder.
    expect((await tools.call("set_task_list", { steps: [{ step: "Done already", status: "done" }, { step: "Look at the contexts" }] })).result).not.toContain("[Task list:");
    await tools.call("set_task_list", { steps: [{ step: "Done already", status: "done" }, { step: "Look at the contexts", status: "done" }] });
    expect((await tools.call("list_contexts", {})).result).not.toContain("[Task list:");
  });

  it("is not a run's that does not keep one", async () => {
    const fixture = start_fixture();
    const { tools } = await tools_of(fixture, false);
    expect(tools.definitions.map((each) => each.name)).not.toContain("set_task_list");
    expect((await tools.call("set_task_list", { steps: [] })).result).toBe("There is no tool named set_task_list.");
    for (let made = 0; made < calls_before_nudge + 1; made += 1) expect((await tools.call("list_contexts", {})).result).not.toMatch(/\[(Task list|If this job)/);
  });

  it("left open by one reply is told to the next, which carries on from it", async () => {
    const fixture = start_fixture();
    fixture.set_script(async function* (request) {
      await request.tools.call("set_task_list", { steps: [{ step: "First", status: "done", note: "kept" }, { step: "Second" }] });
      yield { type: "done", text: "One done." };
    });
    const conversation_id = await talk(fixture, "Review them all.");
    fixture.set_script(async function* () {
      yield { type: "done", text: "Carrying on." };
    });
    await talk(fixture, "Carry on.", conversation_id);
    const told = fixture.requests.at(-1)!;
    expect(told.instructions).toContain("Your task list in this conversation, from earlier replies:\n1. [done] First — kept\n2. [todo] Second");
    expect(told.instructions_with_specialists).toContain("2. [todo] Second");
  });

  it("is cleared from the page", async () => {
    const fixture = start_fixture();
    const { conversation_id, tools } = await tools_of(fixture);
    await tools.call("set_task_list", { steps: [{ step: "A" }] });
    expect(fixture.calls.set_conversation_task_list(conversation_id, [])).toEqual([]);
    expect(fixture.calls.get_conversation(conversation_id).task_list).toEqual([]);
  });
});

describe("working one step at a time", () => {
  it("is in every run's instructions and every specialist's", async () => {
    const fixture = start_fixture();
    fixture.set_script(async function* () {
      yield { type: "done", text: "Hello." };
    });
    await talk(fixture, "Hello.");
    const told = fixture.requests.at(-1)!;
    expect(told.instructions).toContain("Work one step at a time: for a job of several steps, list them with set_task_list");
    expect(told.instructions).toContain(one_at_a_time_line);
    expect(told.instructions_with_specialists).toContain(one_at_a_time_line);
    const graph = own_specialists.find((each) => each.name === "ask_graph")!;
    expect(specialist_instructions({ name: graph.name, label: graph.label, tools: [], own: { calls: graph.calls ?? [] }, guidance: { own: graph.guidance, own_words: true, user: "" } } as never, "")).toContain(one_at_a_time_line);
  });
});
