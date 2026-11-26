// Which of RoboBuddy's moods the assistant's face shows: asleep with no engine or no store to reach, thinking while a
// reply is written, happy or sad for a moment after one ends, and otherwise the assistant's own mood while it is on.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mood_words, type Mood, type MoodState } from "../../shared/mood/model.ts";

// ── Moods ────────────────────────────────────────────────────────────────────

export type MascotMood = "default" | "thinking" | "happy" | "sad" | "asleep" | "laughing" | "curious" | "worried";

// RoboBuddy's own mood for each of the assistant's.
export const face_of: Record<Mood, MascotMood> = {
  neutral: "default",
  happy: "happy",
  celebrating: "laughing",
  sad: "sad",
  curious: "curious",
  concerned: "worried",
};

// The face's screen, the 26 by 18 screen inside the robot head at five pixels a unit.
export const mascot_screen = { width: 130, height: 90 };
export const moment_ms = 3000;

// ── Head ─────────────────────────────────────────────────────────────────────

// The part of CODEX's icon the head shows, and the screen inside it, in the icon's units.
export const mascot_view = { x: 13.5, y: 16.5, width: 37, height: 30.5 };
export const mascot_screen_box = { x: 19, y: 28, width: 26, height: 18 };

// Where the screen sits in the head, as percentages of the head's box, for a canvas laid over it.
export function screen_placement(): { left: string; top: string; width: string; height: string } {
  const percent = (part: number, whole: number) => `${(part / whole) * 100}%`;
  return {
    left: percent(mascot_screen_box.x - mascot_view.x, mascot_view.width),
    top: percent(mascot_screen_box.y - mascot_view.y, mascot_view.height),
    width: percent(mascot_screen_box.width, mascot_view.width),
    height: percent(mascot_screen_box.height, mascot_view.height),
  };
}

export interface MascotState {
  // An engine is chosen and running.
  has_engine: boolean;
  // The store answered the last time the pane asked.
  is_reachable: boolean;
  // A reply is being written in the open conversation.
  is_running: boolean;
  // The assistant's own mood, neutral while the mood is off.
  mood?: Mood;
}

// The mood that lasts while the state holds, most urgent first.
export function lasting_mood(state: MascotState): MascotMood {
  if (!state.is_reachable || !state.has_engine) return "asleep";
  if (state.is_running) return "thinking";
  return face_of[state.mood ?? "neutral"];
}

// The mood shown for a moment after a reply ends: happy when it finished, sad when it failed, none when it was stopped.
export function moment_after(error: string): MascotMood | null {
  if (error === "") return "happy";
  if (error === "Stopped.") return null;
  return "sad";
}

// ── Words ────────────────────────────────────────────────────────────────────

const maker_words = { engine: "Set in a reply.", date: "From a date you listed.", event: "From CODEX's own background work.", "": "" } as const;

// The mood and why, in plain words, for the face's hover text and the note it opens.
export function mood_summary(state: MoodState | null | undefined): string {
  if (!state) return "";
  if (!state.enabled) return "The mood is off, so the face stays neutral.";
  if (state.mood === "neutral") return "Neutral: nothing in particular.";
  const name = mood_words[state.mood];
  return [`${name.charAt(0).toUpperCase()}${name.slice(1)}${state.reason ? `: ${state.reason}` : "."}`, maker_words[state.by]].filter(Boolean).join(" ");
}
