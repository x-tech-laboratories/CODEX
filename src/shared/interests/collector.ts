// The internal collector that answers for findings from their own items, so a refresh keeps them as they are. It is
// CODEX's own: always on, never listed under Plugins.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { app_info, type FoundItem } from "../collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { items } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { finding_collector, finding_kind } from "./model.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export const findings_plugin_id = "codex.findings";

export const findings_label = "The assistant's findings";

// Each finding as it was saved; one whose item is gone is not found.
function found_findings(database: SqlDatabase, source_ids: string[]): Record<string, FoundItem> {
  if (source_ids.length === 0) return {};
  const rows = drizzle_of(database).select().from(items).where(and(eq(items.collector, finding_collector), inArray(items.source_id, source_ids))).all();
  return Object.fromEntries(
    rows.map((row) => {
      let detail: Record<string, string> = {};
      try {
        detail = JSON.parse(row.detail) as Record<string, string>;
      } catch {
        // A detail that cannot be read is kept empty.
      }
      return [row.source_id, { source_id: row.source_id, kind: finding_kind, title: row.title, snippet: row.snippet, uri: row.uri, status: row.status, detail }];
    }),
  );
}

export function findings_plugin(database: SqlDatabase): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    id: findings_plugin_id,
    name: findings_label,
    version: app_info.version,
    app: app_info.id,
    description: "What the assistant found researching its accepted interests on the web, kept as items in a context of its own.",
    start: (context) =>
      context.provide("collector", finding_collector, {
        label: findings_label,
        kinds: [finding_kind],
        pushed_from: "Saved by the Research interests maintenance job, from the web.",
        resolve: async (source_ids) => found_findings(database, source_ids),
      }),
  });
}
