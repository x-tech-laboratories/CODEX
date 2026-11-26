// The internal collector that answers for blueprint items from the blueprints themselves, so a refresh keeps their
// titles and statuses like any other item's. It is CODEX's own: always on, never listed under Plugins.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { app_info } from "../collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { blueprint_collector, blueprint_kind } from "./model.ts";
import { found_blueprint_items } from "./records.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const blueprints_plugin_id = "codex.blueprints";

export const blueprints_label = "CODEX blueprints";

// The collector for the database the plugin host was opened on.
export function blueprints_plugin(database: SqlDatabase): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: blueprints_plugin_id,
    name: blueprints_label,
    version: app_info.version,
    app: app_info.id,
    description: "The blueprints, workflows taught to the assistant, kept as items in the contexts they apply in.",
    start: (context) =>
      context.provide("collector", blueprint_collector, {
        label: blueprints_label,
        kinds: [blueprint_kind],
        pushed_from: "Write one on the Blueprints page or from a context's menu, or ask the assistant to save a conversation as one.",
        resolve: async (source_ids) => found_blueprint_items(database, source_ids),
      }),
  });
}
