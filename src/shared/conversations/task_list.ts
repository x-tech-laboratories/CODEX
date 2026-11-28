// The assistant's task list for the job in hand in one conversation: the steps it wrote, each with its status and a note
// of what it decided, kept with the conversation so a later reply carries on where the last one stopped. The run is told
// it at the start, reminded of it after each call, and keeps it with set_task_list, whose answer gives it back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of } from "../feature.ts";
import { conversation_row } from "./records.ts";
import { conversations } from "./schema.ts";

// ── Steps ────────────────────────────────────────────────────────────────────

export const task_statuses = ["todo", "doing", "done", "skipped"] as const;

export type TaskStatus = (typeof task_statuses)[number];

export interface TaskStep {
  step: string;
  status: TaskStatus;
  // What was decided or found, kept short; empty until there is something to say.
  note: string;
}

export const most_steps = 40;
export const longest_step = 200;
export const longest_note = 300;

function is_status(value: unknown): value is TaskStatus {
  return typeof value === "string" && (task_statuses as readonly string[]).includes(value);
}

function flat(text: string, most: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
}

// The steps given, cleaned: each a non-empty step with a known status; throws in plain words on anything else.
export function clean_steps(given: unknown): TaskStep[] {
  if (!Array.isArray(given)) throw new Error("steps must be a list.");
  if (given.length > most_steps) throw new Error(`A task list holds at most ${most_steps} steps; group the work into fewer.`);
  return given.map((each, at) => {
    const entry = each && typeof each === "object" && !Array.isArray(each) ? (each as Record<string, unknown>) : {};
    const step = typeof entry.step === "string" ? flat(entry.step, longest_step) : "";
    if (!step) throw new Error(`Step ${at + 1} has no text.`);
    const status = entry.status ?? "todo";
    if (!is_status(status)) throw new Error(`Step ${at + 1}'s status must be one of ${task_statuses.join(", ")}.`);
    return { step, status, note: typeof entry.note === "string" ? flat(entry.note, longest_note) : "" };
  });
}

// A stored list read back, leaving out whatever no longer reads as a step.
export function parse_task_list(stored: string): TaskStep[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((each) => {
      try {
        return clean_steps([each]);
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

export function read_task_list(database: SqlDatabase, conversation_id: string): TaskStep[] {
  return parse_task_list(conversation_row(database, conversation_id).task_list);
}

// Replaces the conversation's task list with the steps given and gives back what was kept; an empty list clears it.
export function write_task_list(database: SqlDatabase, conversation_id: string, given: unknown): TaskStep[] {
  conversation_row(database, conversation_id);
  const steps = clean_steps(given);
  drizzle_of(database).update(conversations).set({ task_list: JSON.stringify(steps) }).where(eq(conversations.id, conversation_id)).run();
  return steps;
}

// ── Words ────────────────────────────────────────────────────────────────────

export function is_open(step: TaskStep): boolean {
  return step.status === "todo" || step.status === "doing";
}

// The list as numbered lines, each with its status and note.
export function task_list_text(steps: TaskStep[]): string {
  return steps.map((each, at) => `${at + 1}. [${each.status}] ${each.step}${each.note ? ` — ${each.note}` : ""}`).join("\n");
}

// The step being worked on: the first marked doing, or else the first still to do; null when every step is closed.
export function current_step(steps: TaskStep[]): { at: number; step: TaskStep } | null {
  const doing = steps.findIndex((each) => each.status === "doing");
  const at = doing >= 0 ? doing : steps.findIndex((each) => each.status === "todo");
  return at >= 0 ? { at, step: steps[at]! } : null;
}

// What a run's instructions say of a list kept earlier in the conversation; empty when it has none still open.
export function task_list_part(steps: TaskStep[]): string {
  if (!steps.some(is_open)) return "";
  return [
    "Your task list in this conversation, from earlier replies:",
    task_list_text(steps),
    "Carry on from the step being worked on unless the user now asks for something else; then replace the list with set_task_list, or clear it with an empty one.",
  ].join("\n");
}

// The short line after each call while a list is open, so the run keeps its place and its list current.
export function task_list_reminder(steps: TaskStep[]): string {
  const now = current_step(steps);
  if (!now) return "";
  const done = steps.filter((each) => !is_open(each)).length;
  return `[Task list: ${done} of ${steps.length} steps closed; now step ${now.at + 1}: “${now.step.step}”. When it is done, mark it done in set_task_list with what you decided, then start the next.]`;
}

// The line after a few calls with no list, nudging a job of several steps to write one.
export const no_list_reminder = "[If this job has several steps or several things to go through, write them with set_task_list first, then take them one at a time.]";

// How many calls a run makes before it is nudged to write a list.
export const calls_before_nudge = 3;

// ── Tools ────────────────────────────────────────────────────────────────────

export const set_task_list_tool = {
  name: "set_task_list",
  description: "Writes your task list for this job, replacing the last: every step in order with its status and a note of what you decided. Keep it current as steps close; the next reply sees it. An empty list clears it.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        maxItems: most_steps,
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: { type: "string", enum: [...task_statuses] },
            note: { type: "string" },
          },
          required: ["step"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
} as const;

export const set_task_list_brief = "Writes your task list for this job: every step with its status and a note.";

// The answer to set_task_list, in words: the list as kept and what to do next.
export function engine_set_answer(steps: TaskStep[]): string {
  if (steps.length === 0) return "Your task list is cleared.";
  const now = current_step(steps);
  return `Kept:\n${task_list_text(steps)}\n${now ? `Now step ${now.at + 1}: “${now.step.step}”. Do it, then mark it done.` : "Every step is closed: give the user your answer."}`;
}
