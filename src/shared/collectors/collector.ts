// What a collector is: a plugin that finds items in another app and says what became of them, so a context only ever
// keeps pointers. The store and the page both read this file, so it imports nothing either would not.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { AppInfo } from "@x-tech-laboratories/x-libs/plugins";

import package_json from "../../../package.json" with { type: "json" };

// ── App ──────────────────────────────────────────────────────────────────────

export const app_info: AppInfo = { id: "x-context", version: package_json.version };

// The setting holding every plugin's on or off and its own settings, synced like any other.
export const plugins_setting = "plugins";

// ── Items ────────────────────────────────────────────────────────────────────

// What a collector hands back for one item it found or looked up again.
export interface FoundItem {
  // The item's id in its own app, stable for as long as the item exists.
  source_id: string;
  kind: string;
  title: string;
  snippet?: string;
  uri?: string;
  status?: string;
  detail?: Record<string, string>;
}

// The fields a collector that takes items typed in by hand asks for, such as a web address and its title.
export interface ManualField {
  key: string;
  label: string;
  placeholder?: string;
  is_required?: boolean;
}

// A group in a collector's app a context can follow, such as an X-Tasks tag or a task with its subtasks.
export interface Feed {
  // Stable in its app, such as "tag:<id>".
  id: string;
  label: string;
  // What sort of group it is, such as "Tag" or "Task with subtasks".
  kind: string;
  // The larger group it belongs to in its app, such as an X-Tasks filter group, from which contexts are made together.
  group?: FeedGroup;
}

// A set of feeds an app keeps together, such as an X-Tasks filter group and its tags.
export interface FeedGroup {
  id: string;
  label: string;
}

// ── Collectors ───────────────────────────────────────────────────────────────

export interface Collector {
  label: string;
  // The kinds of item it brings, such as ["task"].
  kinds: string[];
  // Finds items by the text typed, best first; left out by a collector that only takes items pushed to it.
  search?: (query: string) => Promise<FoundItem[]>;
  // What each id is now, by source id; an id missing from the answer is gone from its app.
  resolve?: (source_ids: string[]) => Promise<Record<string, FoundItem>>;
  // The fields of an item typed in by hand, and the item they make.
  manual?: { fields: ManualField[]; make: (values: Record<string, string>) => FoundItem };
  // What a person does to send items here from elsewhere, such as installing a mail add-on.
  pushed_from?: string;
  // The groups a context can follow, and the items each holds now.
  feeds?: { list: () => Promise<Feed[]>; items: (feed_id: string) => Promise<FoundItem[]> };
}

// A collector as the page and other programs see it.
export interface CollectorSummary {
  id: string;
  plugin_id: string;
  label: string;
  kinds: string[];
  can_search: boolean;
  can_refresh: boolean;
  can_follow: boolean;
  manual_fields: ManualField[];
  pushed_from: string;
}

// The one id every device gives the same item from the same collector.
export function item_id_of(collector: string, source_id: string): string {
  return `${collector}:${source_id}`;
}

// What a membership's via holds for a feed, such as "x-tasks:tag:<id>".
export function feed_key(collector: string, feed_id: string): string {
  return `${collector}:${feed_id}`;
}
