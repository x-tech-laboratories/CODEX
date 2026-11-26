// The shapes the mood feature hands the page and other programs: the assistant's one small mood, what set it and why,
// fading back to neutral over time, and the dates the user asked it to remember. The mood changes the face and, if the
// user allows, the tone of a reply; nothing else reads it. The page imports only these.

// ── Moods ────────────────────────────────────────────────────────────────────

// The moods the assistant may be in, each one the face can show.
export type Mood = "neutral" | "happy" | "celebrating" | "sad" | "curious" | "concerned";

export const moods: Mood[] = ["neutral", "happy", "celebrating", "sad", "curious", "concerned"];

export function is_mood(value: unknown): value is Mood {
  return typeof value === "string" && (moods as string[]).includes(value);
}

// Each mood in plain words, for the face's label and the instructions.
export const mood_words: Record<Mood, string> = {
  neutral: "neutral",
  happy: "happy",
  celebrating: "celebrating",
  sad: "sad",
  curious: "curious",
  concerned: "a little concerned",
};

// What set the mood: the engine during a reply, a date the user listed, or something CODEX noticed in its own work.
export type MoodMaker = "engine" | "date" | "event";

export interface MoodRecord {
  mood: Mood;
  // From 0 to 1 when it was set; it fades from there.
  strength: number;
  // Why, in a short plain line.
  reason: string;
  set_at: string;
  by: MoodMaker;
  // The conversation and reply it was set in, for a mood the engine set; empty otherwise.
  conversation_id: string;
  run_id: string;
  // The sources the reply it came from had read, so its reason reaches only an engine those may reach.
  sources: string[];
}

// ── Fading ───────────────────────────────────────────────────────────────────

// How long a mood takes to fade to half its strength.
export const half_life_minutes = 60;

// Below this strength the face is neutral again.
export const neutral_below = 0.25;

// How strong the things CODEX notices are: mild, so they fade within the hour and give way to any reply's mood.
export const event_strength = 0.4;
export const engine_strength = 1;
// A date's mood holds all day at this strength, under a mood a reply sets.
export const date_strength = 0.9;

export const longest_reason = 160;

// The mood's strength at the moment given, halving every half-life.
export function strength_at(record: Pick<MoodRecord, "strength" | "set_at">, now: number): number {
  const elapsed = Math.max(0, now - Date.parse(record.set_at));
  if (!Number.isFinite(elapsed)) return 0;
  return record.strength * 0.5 ** (elapsed / (half_life_minutes * 60_000));
}

// The moods a reply in a conversation sets that last only while the conversation stays on that topic.
export const topic_moods: ReadonlySet<Mood> = new Set(["sad", "celebrating"]);

// ── Dates ────────────────────────────────────────────────────────────────────

// A date the user asked the assistant to remember each year: a birthday, or another day to celebrate or to be quiet on.
export type DateKind = "birthday" | "celebrate" | "remember";

export const date_kinds: DateKind[] = ["birthday", "celebrate", "remember"];

export interface DateToRemember {
  // Month and day, such as 11-27.
  day: string;
  // What it is, such as "My birthday" or "Grandmother's anniversary".
  label: string;
  kind: DateKind;
}

export const date_kind_words: Record<DateKind, string> = {
  birthday: "Your birthday: celebrating",
  celebrate: "A day to celebrate",
  remember: "A day to remember quietly: sad",
};

export const longest_label = 80;
export const most_dates = 50;

// ── Settings ─────────────────────────────────────────────────────────────────

// The synced settings behind the mood: its switch, whether it colours replies, the dates, and the mood itself, which
// only CODEX's own code writes; all four are the user's alone over the API.
export const mood_settings = {
  enabled: "mood.enabled",
  tone: "mood.tone",
  dates: "mood.dates",
  current: "mood.current",
} as const;

export const mood_defaults = {
  [mood_settings.enabled]: true,
  [mood_settings.tone]: true,
  [mood_settings.dates]: [] as DateToRemember[],
  [mood_settings.current]: null as MoodRecord | null,
};

// ── State ────────────────────────────────────────────────────────────────────

// The mood as the face shows it now, after fading and today's dates.
export interface MoodState {
  // The mood is turned on; off, the face stays neutral and the mood is not set.
  enabled: boolean;
  // The mood colours the tone of replies.
  tone: boolean;
  mood: Mood;
  // Its strength now, from 0 to 1.
  strength: number;
  reason: string;
  set_at: string;
  by: MoodMaker | "";
}
