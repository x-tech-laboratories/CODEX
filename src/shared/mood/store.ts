// The mood feature: the assistant's mood as the face shows it, readable by anyone, and the dates it remembers, which
// only the user at the page sets. The mood itself is written only by CODEX's own code, never through a call.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature } from "../feature.ts";
import { settings_feature } from "../settings.ts";
import { date_kinds, mood_defaults, mood_settings, most_dates, type DateToRemember, type MoodState } from "./model.ts";
import { checked_dates, mood_state, stored_dates } from "./mood.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

function get_mood(database: SqlDatabase): MoodState {
  return mood_state(database, Date.now());
}

function list_mood_dates(database: SqlDatabase): DateToRemember[] {
  return stored_dates(database);
}

function set_mood_dates(database: SqlDatabase, dates: DateToRemember[]): void {
  settings_feature.methods.set_setting(database, mood_settings.dates, checked_dates(dates));
}

// ── Feature ──────────────────────────────────────────────────────────────────

export const mood_feature = define_feature({
  id: "mood",
  migrations: [],
  tables: [],
  methods: { get_mood, list_mood_dates, set_mood_dates },
  api: {
    get_mood: {
      description:
        "Gets the assistant's mood as its face shows it now: whether the mood is on and colours replies, the mood (neutral, happy, celebrating, sad, curious or concerned), its strength from 0 to 1 as it fades, why, when it was set and by what (the engine in a reply, a date the user listed, or something CODEX noticed in its own work).",
      params: [],
    },
    list_mood_dates: {
      description: "Lists the dates the user asked the assistant to remember each year: the month and day, what it is, and whether it is a birthday, a day to celebrate or a day to remember quietly.",
      params: [],
    },
    set_mood_dates: {
      description: "Replaces the dates the assistant remembers each year. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        {
          name: "dates",
          schema: {
            type: "array",
            maxItems: most_dates,
            description: "Every date, each a month and day, a label and a kind.",
            items: {
              type: "object",
              properties: {
                day: { type: "string", description: "Month and day, such as 11-27." },
                label: { type: "string", description: "What it is, such as My birthday." },
                kind: { type: "string", enum: date_kinds, description: "birthday or celebrate: the assistant celebrates all day; remember: it is quietly sad." },
              },
              required: ["day", "label", "kind"],
              additionalProperties: false,
            },
          },
        },
      ],
    },
  },
  setting_defaults: mood_defaults,
});
