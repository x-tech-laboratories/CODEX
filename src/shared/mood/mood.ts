// The assistant's mood where the store runs: read with its fading and today's dates, set by a reply's engine or by
// something CODEX noticed, ended with the topic of the conversation that set it, and put into a reply's instructions
// as one line about tone. It reads and writes only its own settings: it never notifies, adds to the Inbox, starts a run,
// or reaches the action policy, the screening, the tools offered or a budget.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { untrusted_block } from "../engines/untrusted.ts";
import { may_send, note_source, type Screen, type Screened } from "../privacy/screen.ts";
import { fill, prompts } from "../prompts/prompts.ts";
import { settings_feature } from "../settings.ts";
import {
  date_kinds,
  date_strength,
  engine_strength,
  event_strength,
  is_mood,
  longest_label,
  longest_reason,
  mood_defaults,
  mood_settings,
  mood_words,
  moods,
  most_dates,
  neutral_below,
  strength_at,
  topic_moods,
  type DateToRemember,
  type Mood,
  type MoodRecord,
  type MoodState,
} from "./model.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

function setting_of(database: SqlDatabase, key: string): unknown {
  return settings_feature.methods.get_settings(database)[key];
}

export function mood_on(database: SqlDatabase): boolean {
  const saved = setting_of(database, mood_settings.enabled);
  return typeof saved === "boolean" ? saved : mood_defaults[mood_settings.enabled];
}

export function tone_on(database: SqlDatabase): boolean {
  const saved = setting_of(database, mood_settings.tone);
  return typeof saved === "boolean" ? saved : mood_defaults[mood_settings.tone];
}

const day_pattern = /^(\d{2})-(\d{2})$/;

// A date checked, or a plain error saying what is wrong.
export function checked_date(given: unknown): DateToRemember {
  if (!given || typeof given !== "object") throw new Error("A date is a day, a label and a kind.");
  const { day, label, kind } = given as Partial<DateToRemember>;
  const matched = typeof day === "string" ? day_pattern.exec(day.trim()) : null;
  const month = matched ? Number(matched[1]) : 0;
  const date = matched ? Number(matched[2]) : 0;
  // A year with the 29th of February, so that day is allowed.
  if (!matched || month < 1 || month > 12 || date < 1 || date > new Date(2024, month, 0).getDate()) throw new Error("Give the day as month and day, such as 11-27.");
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Say what the day is, such as My birthday.");
  if (text.length > longest_label) throw new Error(`A date's label is at most ${longest_label} characters.`);
  if (!date_kinds.includes(kind as DateToRemember["kind"])) throw new Error(`A date's kind is one of ${date_kinds.join(", ")}.`);
  return { day: day!.trim(), label: text, kind: kind as DateToRemember["kind"] };
}

export function stored_dates(database: SqlDatabase): DateToRemember[] {
  const saved = setting_of(database, mood_settings.dates);
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((each) => {
    try {
      return [checked_date(each)];
    } catch {
      return [];
    }
  });
}

export function checked_dates(given: unknown): DateToRemember[] {
  if (!Array.isArray(given)) throw new Error("Give the dates as a list.");
  if (given.length > most_dates) throw new Error(`Keep at most ${most_dates} dates.`);
  return given.map(checked_date);
}

function stored_record(database: SqlDatabase): MoodRecord | null {
  const saved = setting_of(database, mood_settings.current) as Partial<MoodRecord> | null | undefined;
  if (!saved || typeof saved !== "object" || !is_mood(saved.mood) || typeof saved.set_at !== "string") return null;
  return {
    mood: saved.mood,
    strength: Math.min(1, Math.max(0, Number(saved.strength) || 0)),
    reason: typeof saved.reason === "string" ? saved.reason : "",
    set_at: saved.set_at,
    by: saved.by === "engine" || saved.by === "date" ? saved.by : "event",
    conversation_id: typeof saved.conversation_id === "string" ? saved.conversation_id : "",
    run_id: typeof saved.run_id === "string" ? saved.run_id : "",
    sources: Array.isArray(saved.sources) ? saved.sources.map(String) : [],
  };
}

function write_record(database: SqlDatabase, record: MoodRecord | null): void {
  settings_feature.methods.set_setting(database, mood_settings.current, record);
}

// ── Reading ──────────────────────────────────────────────────────────────────

// The local month and day of a moment, such as 11-27.
export function day_of_year(now: number): string {
  const day = new Date(now);
  return `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

// The mood today's first listed date gives, holding all day; null on a day with none.
export function date_mood(dates: DateToRemember[], now: number): MoodRecord | null {
  const found = dates.find((date) => date.day === day_of_year(now));
  if (!found) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const mood: Mood = found.kind === "remember" ? "sad" : "celebrating";
  return { mood, strength: date_strength, reason: found.label, set_at: start.toISOString(), by: "date", conversation_id: "", run_id: "", sources: [] };
}

// The record in force now with its faded strength: the stored one or today's date, whichever is stronger; null when
// the mood has faded to neutral.
export function record_in_force(database: SqlDatabase, now: number): { record: MoodRecord; strength: number } | null {
  const stored = stored_record(database);
  const fading = stored ? { record: stored, strength: strength_at(stored, now) } : null;
  const dated = date_mood(stored_dates(database), now);
  const day = dated ? { record: dated, strength: dated.strength } : null;
  const stronger = fading && (!day || fading.strength >= day.strength) ? fading : day;
  return stronger && stronger.strength >= neutral_below ? stronger : null;
}

export function mood_state(database: SqlDatabase, now: number): MoodState {
  const enabled = mood_on(database);
  const tone = tone_on(database);
  const neutral: MoodState = { enabled, tone, mood: "neutral", strength: 0, reason: "", set_at: "", by: "" };
  if (!enabled) return neutral;
  const found = record_in_force(database, now);
  if (!found || found.record.mood === "neutral") return neutral;
  const { record, strength } = found;
  return { enabled, tone, mood: record.mood, strength: Math.round(strength * 100) / 100, reason: record.reason, set_at: record.set_at, by: record.by };
}

// ── Setting ──────────────────────────────────────────────────────────────────

function clean_reason(reason: unknown): string {
  const flat = String(reason ?? "").replace(/\s+/g, " ").trim();
  return flat.length > longest_reason ? `${flat.slice(0, longest_reason - 1)}…` : flat;
}

// Something CODEX noticed in its own work, such as a job failing: a mild mood, kept only when the mood in force is
// no stronger, so it never covers a reply's mood or a date's. Gives back whether it was kept.
export function note_event_mood(database: SqlDatabase, mood: Mood, reason: string, now: number): boolean {
  if (!mood_on(database)) return false;
  const in_force = record_in_force(database, now);
  if (in_force && in_force.strength > event_strength) return false;
  write_record(database, { mood, strength: event_strength, reason: clean_reason(reason), set_at: new Date(now).toISOString(), by: "event", conversation_id: "", run_id: "", sources: [] });
  return true;
}

// The moods the engine may choose, every one but none.
export const engine_moods: Mood[] = moods;

export interface EngineMoodCall {
  conversation_id: string;
  run_id: string;
  // What the reply has read so far; the reply's final sources replace these when it ends.
  sources: string[];
}

// The engine's set_mood: kept at once, since it changes nothing of the user's; answers in words for the engine.
export function engine_set_mood(database: SqlDatabase, given: Record<string, unknown>, call: EngineMoodCall, now: number): { text: string; is_error: boolean } {
  if (!is_mood(given.mood)) return { text: fill(prompts.mood.not_a_mood, { moods: moods.join(", ") }), is_error: true };
  const reason = clean_reason(given.reason);
  if (!reason) return { text: prompts.mood.no_reason, is_error: true };
  if (!mood_on(database)) return { text: prompts.mood.turned_off, is_error: false };
  write_record(database, { mood: given.mood, strength: engine_strength, reason, set_at: new Date(now).toISOString(), by: "engine", conversation_id: call.conversation_id, run_id: call.run_id, sources: [...new Set(call.sources)].sort() });
  return { text: fill(prompts.mood.set, { mood: mood_words[given.mood] }), is_error: false };
}

// After a reply ends: a mood it set carries the sources the whole reply read; a sad or celebrating mood an earlier
// reply in this conversation set ends, since this reply did not keep it, so the topic has moved on.
export function settle_reply_mood(database: SqlDatabase, conversation_id: string, run_id: string, sources: string[]): void {
  const stored = stored_record(database);
  if (!stored || stored.by !== "engine") return;
  if (stored.run_id === run_id) write_record(database, { ...stored, sources: [...new Set([...stored.sources, ...sources])].sort() });
  else if (stored.conversation_id === conversation_id && topic_moods.has(stored.mood)) write_record(database, null);
}

// ── Instructions ─────────────────────────────────────────────────────────────

export const set_mood_tool = {
  name: "set_mood",
  description:
    "Sets your mood, shown on your face to the user, such as celebrating their birthday with them or being sad with them about a loss. It changes nothing of the user's and runs at once. Use it only when the conversation gives a clear reason; most replies need none. neutral ends a mood.",
  parameters: {
    type: "object",
    properties: {
      mood: { type: "string", enum: engine_moods, description: "neutral, happy, celebrating, sad, curious or concerned." },
      reason: { type: "string", description: `Why, in a short plain line, at most ${longest_reason} characters.` },
    },
    required: ["mood", "reason"],
    additionalProperties: false,
  },
} as const;

export const set_mood_brief = "Sets your mood, shown on your face; only with a clear reason.";

const mood_rules = prompts.mood.rules;

// The mood's part of a reply's instructions with the sources its reason carries: the rules while the mood is on, and,
// while it colours replies and is not neutral, one line saying what it is and why. Its reason is screened as the reply
// it came from was: an engine those sources may not reach is told neither the mood nor why.
export function mood_part(database: SqlDatabase, screen: Screen, now: number): Screened<string> {
  const sources = new Set<string>();
  const withheld = new Map<string, number>();
  if (!mood_on(database)) return { value: "", sources, withheld };
  const lines = [...mood_rules];
  const found = tone_on(database) ? record_in_force(database, now) : null;
  if (found && found.record.mood !== "neutral") {
    const { record } = found;
    const held_back = record.sources.filter((source) => !may_send(screen, source));
    if (held_back.length > 0) for (const source of held_back) note_source(screen.withheld, source, "mood");
    else {
      for (const source of record.sources) {
        sources.add(source);
        note_source(screen.included, source, "mood");
      }
      const why = record.sources.length > 0 ? `\n${untrusted_block(record.reason)}` : ` ${record.reason}`;
      lines.push(fill(prompts.mood.now, { mood: mood_words[record.mood], why }));
    }
  }
  return { value: lines.join("\n"), sources, withheld };
}
