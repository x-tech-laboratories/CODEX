// Settings every device shares, such as how often items are refreshed, kept as JSON values by key so each feature can add its own.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "./api_schemas.ts";
import { define_feature } from "./feature.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export type Settings = Record<string, unknown>;

export const common_setting_defaults = {
  // How many minutes apart the daemon asks each collector what became of its items.
  refresh_minutes: 30,
} satisfies Settings;

// ── Store ────────────────────────────────────────────────────────────────────

export const settings_feature = define_feature({
  id: "settings",
  migrations: [`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`],
  tables: [{ name: "settings", key_columns: ["key"] }],
  methods: {
    // Only the values set; the page lays them over the defaults.
    get_settings: (database: SqlDatabase): Settings => {
      const rows = database.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
      return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    },
    set_setting: (database: SqlDatabase, key: string, value: unknown): void => {
      database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
    },
  },
  api: {
    get_settings: {
      description:
        "The settings stored, by key; a key missing here has its default. refresh_minutes is how often the daemon asks each collector what became of its items, plugins holds each collector and engine plugin's on or off and settings, with its keys hidden, engine names the engine that answers the conversations, action_policy the level of each change the assistant could make, source_marks each collector plugin's marks for hosted engines and trust, and hosted_log.keep_days how long the log of what hosted engines were sent is kept.",
      params: [],
    },
    set_setting: {
      description:
        "Sets one setting by key to any JSON value. The settings that keep the user in charge (action_policy, source_marks, engine, embedder, hosted_log.keep_days and plugins) can be changed only by the user at CODEX's own page; tokens and MCP clients are refused.",
      params: [{ name: "key", schema: text("The setting's key, such as refresh_minutes.") }, { name: "value", schema: { description: "The new value." } }],
    },
  },
  setting_defaults: common_setting_defaults,
});
