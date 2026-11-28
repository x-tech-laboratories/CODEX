// Settings every device shares, such as how often items are refreshed, kept as JSON values by key in the X-Libs
// settings store, each feature declaring its own keys with who may write them and how their secrets are hidden.

// ── Imports ──────────────────────────────────────────────────────────────────

import { hide_secrets, keep_secrets, type PluginRecords } from "@x-tech-laboratories/x-libs/plugins";
import { create_settings_store, settings_of, type SettingSpec } from "@x-tech-laboratories/x-libs/settings";

import { plugins_setting } from "./collectors/collector.ts";
import { bundled_manifests } from "./collectors/manifests.ts";
import { define_feature } from "./feature.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export { read_setting, settings_of, write_setting, type Settings } from "@x-tech-laboratories/x-libs/settings";

export const common_setting_defaults = {
  // How many minutes apart the daemon asks each collector what became of its items.
  refresh_minutes: 30,
};

function records_of(value: unknown): PluginRecords {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PluginRecords) : {};
}

const common_settings: Record<string, SettingSpec> = {
  ...settings_of(common_setting_defaults),
  // Every collector and engine plugin's on or off and settings, its keys hidden.
  [plugins_setting]: {
    user_only: true,
    hide: (value) => hide_secrets(bundled_manifests, records_of(value)),
    keep: (stored, incoming) => keep_secrets(bundled_manifests, records_of(stored), records_of(incoming)),
  },
};

// ── Store ────────────────────────────────────────────────────────────────────

// The settings feature over every other feature's settings, so they share one table and one set of calls.
export function create_settings_feature(features: readonly { settings?: Record<string, SettingSpec> }[]) {
  const store = create_settings_store([common_settings, ...features.map((feature) => feature.settings ?? {})], {
    app: { id: "codex", name: "CODEX" },
    descriptions: {
      get_settings:
        "Every setting by key, the ones never set at their defaults. refresh_minutes is how often the daemon asks each collector what became of its items, plugins holds each collector and engine plugin's on or off and settings, with its keys hidden, engine names the engine that answers the conversations, keep_thinking whether each reply keeps its model's thinking (on unless false), action_policy the level of each change the assistant could make, source_marks each collector plugin's marks for hosted engines and trust, hosted_log.keep_days how long the log of what hosted engines were sent is kept, and item_sources the apps read through the standard item calls, with their tokens hidden.",
      set_setting:
        "Sets one setting by key to any JSON value. The settings that keep the user in charge (action_policy, source_marks, engine, embedder, hosted_log.keep_days, plugins and item_sources) can be changed only by the user at CODEX's own page; tokens and MCP clients are refused.",
    },
    key_example: "refresh_minutes",
  });
  const feature = define_feature({ id: store.id, migrations: store.migrations, tables: store.tables, methods: { ...store.methods }, api: store.api });
  return { store, feature };
}
