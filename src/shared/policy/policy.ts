// Which of CODEX's calls an engine is offered, which of them change something, the level each change has, and when a
// run that read other apps' text has to ask first whatever the level.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { MethodSpec } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { blueprints_feature } from "../blueprints/store.ts";
import { contexts_feature } from "../contexts/store.ts";
import { jobs_feature } from "../jobs/store.ts";
import { graph_feature } from "../graph/store.ts";
import { search_feature } from "../search/store.ts";
import { is_read_only } from "../page_api.ts";
import { settings_feature } from "../settings.ts";
import { default_level, is_policy_level, type PolicyLevel } from "./model.ts";

// ── Calls offered ────────────────────────────────────────────────────────────

// The setting holding each changing call's level, by call name.
export const policy_setting = "action_policy";

// Contexts calls left out: moving data in or out whole, and how a page lays its cards out.
const not_offered = new Set(["export_contexts", "import_contexts", "set_context_view", "set_card_places"]);

// The graph's and the blueprints' calls that only propose: what they make waits for the user, so they run without
// approval and are not changes under the policy.
export const proposing_calls: ReadonlySet<string> = new Set(["propose_entity", "propose_link", "propose_blueprint", "propose_blueprint_change"]);

// Only the contexts, items, collectors and feeds calls, the search, what a node is linked to, the blueprints' reads,
// the four proposing calls, and listing, adding, changing and removing the assistant's own jobs; never accounts, settings, plugins, sync, backups, History, the conversations, this policy,
// any other change to the graph or to a blueprint.
export const offered_api: Record<string, MethodSpec> = {
  ...Object.fromEntries(Object.entries(contexts_feature.api as Record<string, MethodSpec>).filter(([name]) => !not_offered.has(name))),
  search_index: search_feature.api.search_index as MethodSpec,
  get_node_links: graph_feature.api.get_node_links as MethodSpec,
  propose_entity: graph_feature.api.propose_entity as MethodSpec,
  propose_link: graph_feature.api.propose_link as MethodSpec,
  list_blueprints: blueprints_feature.api.list_blueprints as MethodSpec,
  get_blueprint: blueprints_feature.api.get_blueprint as MethodSpec,
  propose_blueprint: blueprints_feature.api.propose_blueprint as MethodSpec,
  propose_blueprint_change: blueprints_feature.api.propose_blueprint_change as MethodSpec,
  list_jobs: jobs_feature.api.list_jobs as MethodSpec,
  add_job: jobs_feature.api.add_job as MethodSpec,
  change_job: jobs_feature.api.change_job as MethodSpec,
  remove_job: jobs_feature.api.remove_job as MethodSpec,
};

// The core set offered to a model with a small context, each briefly described: the reads, the most-used changes, the
// graph's two proposing calls, so Suggest links works on a small model too, and reading one blueprint whole and the
// two blueprint proposing calls, so a small model can save and amend what the user teaches it; recall lists the rest.
export const core_tools: Record<string, string> = {
  list_contexts: "Lists the contexts as a tree, with their ids.",
  get_context: "Gets one context: its notes and the items it holds.",
  get_item: "Gets one item and the contexts holding it.",
  search_index: "Searches items, contexts and messages by their words and meaning.",
  add_context: "Adds a context; parent_id is null for the top level.",
  rename_context: "Renames a context.",
  set_context_notes: "Sets a context's notes, in Markdown.",
  set_item_note: "Sets the note on why an item is in a context.",
  move_item: "Moves an item from one context to another.",
  add_item_to_contexts: "Puts an item already kept in more contexts.",
  remove_item: "Takes an item out of a context; it stays in its own app.",
  propose_entity: "Proposes a person, organisation, topic or place found in the items.",
  propose_link: "Proposes a typed link between two contexts, items or entities.",
  get_blueprint: "Gets one blueprint whole.",
  propose_blueprint: "Proposes a blueprint: the rules and steps of a task the user taught you.",
  propose_blueprint_change: "Proposes a new version of a blueprint, with why.",
};

export function is_offered(method: string): boolean {
  return Object.hasOwn(offered_api, method);
}

// The offered calls that change something, each of which has a level.
export function changing_calls(): string[] {
  return Object.keys(offered_api).filter((method) => !is_read_only(method) && !proposing_calls.has(method));
}

// Reads that give back only what the user wrote in CODEX, its jobs included; every other offered read carries text from other apps, such
// as a collector's search, an item's title or a feed.
const own_reads = new Set(["list_contexts", "list_collectors", "list_jobs"]);

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
