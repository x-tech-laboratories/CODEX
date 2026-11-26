// Which of CODEX's calls an engine is offered, which of them change something, the level each change has, and when a
// run that read other apps' text has to ask first whatever the level.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { MethodSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { contexts_feature } from "../contexts/store.ts";
import { search_feature } from "../search/store.ts";
import { is_read_only } from "../page_api.ts";
import { settings_feature } from "../settings.ts";
import { default_level, is_policy_level, type PolicyLevel } from "./model.ts";

// ── Calls offered ────────────────────────────────────────────────────────────

// The setting holding each changing call's level, by call name.
export const policy_setting = "action_policy";

// Contexts calls left out: moving data in or out whole, and how a page lays its cards out.
const not_offered = new Set(["export_contexts", "import_contexts", "set_context_view", "set_card_places"]);

// Only the contexts, items, collectors and feeds calls, and the search; never accounts, settings, plugins, sync,
// backups, History, the conversations or this policy.
export const offered_api: Record<string, MethodSpec> = {
  ...Object.fromEntries(Object.entries(contexts_feature.api as Record<string, MethodSpec>).filter(([name]) => !not_offered.has(name))),
  search_index: search_feature.api.search_index as MethodSpec,
};

export function is_offered(method: string): boolean {
  return Object.hasOwn(offered_api, method);
}

// The offered calls that change something, each of which has a level.
export function changing_calls(): string[] {
  return Object.keys(offered_api).filter((method) => !is_read_only(method));
}

// Reads that give back only what the user wrote in CODEX; every other offered read carries text from other apps, such
// as a collector's search, an item's title or a feed.
const own_reads = new Set(["list_contexts", "list_collectors"]);

// Changes whose answer carries text from other apps: what a refresh found, or the items a feed brought.
const changes_with_outside_content = new Set(["refresh_items", "follow_feed"]);

export function brings_outside_content(method: string): boolean {
  return is_read_only(method) ? !own_reads.has(method) : changes_with_outside_content.has(method);
}

// ── Levels ───────────────────────────────────────────────────────────────────

export function stored_levels(database: SqlDatabase): Record<string, PolicyLevel> {
  const saved = settings_feature.methods.get_settings(database)[policy_setting];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter((entry): entry is [string, PolicyLevel] => is_policy_level(entry[1])));
}

export function level_of(database: SqlDatabase, method: string): PolicyLevel {
  return stored_levels(database)[method] ?? default_level;
}

// Who is there when a change is asked for: a conversation has the user in it; a background job has nobody.
export type Presence = "conversation" | "background";

export type Decision = { action: "refuse" } | { action: "propose"; reason: "level" | "outside content" } | { action: "run"; level: PolicyLevel };

// What to do with a change: a run that read outside content asks first for anything it would otherwise make itself.
export function decide(level: PolicyLevel, presence: Presence, has_outside_content: boolean): Decision {
  if (level === "restricted") return { action: "refuse" };
  if (level === "proposal") return { action: "propose", reason: "level" };
  if (level === "auto" && presence === "background") return { action: "propose", reason: "level" };
  if (has_outside_content) return { action: "propose", reason: "outside content" };
  return { action: "run", level };
}
