// When a job falls due: every so many minutes, hours or days after it last ran, or at a time on chosen weekdays, in
// this device's local time. However many times it was missed, it is due once, so missed runs never pile up.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { IntervalUnit, JobSchedule } from "./model.ts";

// ── Checking ─────────────────────────────────────────────────────────────────

const unit_ms: Record<IntervalUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

const weekday_names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The schedule given, checked, or a plain reason it is not one.
export function checked_schedule(given: unknown): JobSchedule {
  const value = (given ?? {}) as Record<string, unknown>;
  if (value.kind === "every") {
    const every = Number(value.every);
    const unit = String(value.unit) as IntervalUnit;
    if (!(unit in unit_ms)) throw new Error('A schedule\'s unit is "minutes", "hours" or "days".');
    if (!Number.isInteger(every) || every < 1) throw new Error("A schedule runs every whole number of minutes, hours or days, one or more.");
    if (unit === "minutes" && every < 5) throw new Error("A job runs at most every 5 minutes.");
    return { kind: "every", every, unit };
  }
  if (value.kind === "at") {
    const time = String(value.time ?? "");
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) throw new Error("A schedule's time is a 24-hour time such as 07:30.");
    const weekdays = Array.isArray(value.weekdays) ? [...new Set(value.weekdays.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort() : [];
    if (weekdays.length === 0) throw new Error("A schedule at a time runs on one weekday or more, 0 being Sunday.");
    return { kind: "at", time: `${match[1]!.padStart(2, "0")}:${match[2]}`, weekdays };
  }
  throw new Error('A schedule is { kind: "every", every, unit } or { kind: "at", time, weekdays }.');
}

// The schedule in plain words, such as "every 2 hours" or "at 07:30 on Monday and Friday".
export function describe_schedule(schedule: JobSchedule): string {
  if (schedule.kind === "every") return schedule.every === 1 ? `every ${schedule.unit.slice(0, -1)}` : `every ${schedule.every} ${schedule.unit}`;
  const days = schedule.weekdays.length === 7 ? "every day" : schedule.weekdays.length === 5 && schedule.weekdays.every((day) => day >= 1 && day <= 5) ? "on weekdays" : `on ${list(schedule.weekdays.map((day) => weekday_names[day]!))}`;
  return `at ${schedule.time} ${days}`;
}

function list(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// ── Due ──────────────────────────────────────────────────────────────────────

// The latest moment at or before now the schedule names, or null when an "every" schedule has no start yet.
function latest_slot(schedule: Extract<JobSchedule, { kind: "at" }>, now: number): number | null {
  const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() <= now && schedule.weekdays.includes(day.getDay())) return day.getTime();
  }
  return null;
}

// The next moment the schedule names after the moment given.
function next_slot(schedule: Extract<JobSchedule, { kind: "at" }>, after: number): number {
  const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
  for (let ahead = 0; ahead <= 8; ahead++) {
    const day = new Date(after);
    day.setDate(day.getDate() + ahead);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() > after && schedule.weekdays.includes(day.getDay())) return day.getTime();
  }
  return after + unit_ms.days;
}

// Whether the job is due now, given when it last ran or was made: once, however many times it was missed.
export function is_due(schedule: JobSchedule, since: number, now: number): boolean {
  if (schedule.kind === "every") return now - since >= schedule.every * unit_ms[schedule.unit];
  const slot = latest_slot(schedule, now);
  return slot !== null && slot > since;
}

// When the job falls due next, given when it last ran or was made.
export function next_due(schedule: JobSchedule, since: number): number {
  if (schedule.kind === "every") return since + schedule.every * unit_ms[schedule.unit];
  return next_slot(schedule, since);
}

// The start of the local day holding the moment given.
export function start_of_day(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
