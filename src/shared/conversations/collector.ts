// The internal collector that answers for conversation items from the conversations themselves, so a refresh keeps
// their titles and latest exchanges like any other item's. It is CODEX's own: always on, never listed under Plugins,
// and never an outside source.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { app_info } from "../collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { conversation_collector, conversation_kind } from "./model.ts";
import { found_items } from "./records.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const conversations_plugin_id = "codex.conversations";

export const conversations_label = "CODEX conversations";

// The collector for the database the plugin host was opened on.
export function conversations_plugin(database: SqlDatabase): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: conversations_plugin_id,
    name: conversations_label,
    version: app_info.version,
    app: app_info.id,
    description: "The conversations with the assistant, kept as items in the contexts that hold them.",
    start: (context) =>
      context.provide("collector", conversation_collector, {
        label: conversations_label,
        kinds: [conversation_kind],
        pushed_from: "Start a conversation in the Assistant pane with New conversation; it joins the context the pane is open on.",
        resolve: async (source_ids) => found_items(database, source_ids),
      }),
  });
}
