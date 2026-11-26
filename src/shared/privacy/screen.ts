// What a run may show its engine of each source's items, and what reading them does to the run: a hosted engine is
// never given items from a source not marked for hosted engines, and only items from a source not marked trusted make
// the run's changes wait for the user. A screen also counts what it let through and held back, for the log.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { settings_feature } from "../settings.ts";
import { mark_names, unmarked, type SourceCount, type SourceMark } from "./model.ts";

// ── Marks ────────────────────────────────────────────────────────────────────

// The setting holding each collector plugin's marks, by plugin id.
export const marks_setting = "source_marks";

export function stored_marks(database: SqlDatabase): Record<string, SourceMark> {
  const saved = settings_feature.methods.get_settings(database)[marks_setting];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const marks: Record<string, SourceMark> = {};
  for (const [plugin_id, value] of Object.entries(saved as Record<string, unknown>)) {
    const given = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    marks[plugin_id] = Object.fromEntries(mark_names.map((name) => [name, given[name] === true])) as unknown as SourceMark;
  }
  return marks;
}

// ── Screen ───────────────────────────────────────────────────────────────────

export interface Screen {
  // The engine the run answers with is hosted.
  is_hosted: boolean;
  // Each collector's marks, by collector id; a collector not running, or of no known plugin, is unmarked.
  mark_of: (collector: string) => SourceMark;
  label_of: (collector: string) => string;
  // Every collector running when the screen was made, by id.
  collectors: string[];
  // What the run let through and held back so far: each collector's entries by a key such as the item's id.
  included: Map<string, Set<string>>;
  withheld: Map<string, Set<string>>;
}

function make_screen(is_hosted: boolean, marks: Map<string, SourceMark>, labels: Map<string, string>): Screen {
  return {
    is_hosted,
    mark_of: (collector) => marks.get(collector) ?? unmarked,
    label_of: (collector) => labels.get(collector) ?? collector,
    collectors: [...labels.keys()],
    included: new Map(),
    withheld: new Map(),
  };
}

// A screen for a local engine with no source marked: nothing is withheld, and every source's items are outside content.
export function local_screen(): Screen {
  return make_screen(false, new Map(), new Map());
}

// The marks as they stand now, for a run answered by a hosted or a local engine.
export async function open_screen(database: SqlDatabase, is_hosted: boolean): Promise<Screen> {
  const stored = stored_marks(database);
  const collectors = (await open_plugin_host(database)).providers("collector");
  const marks = new Map(collectors.map(({ id, plugin_id }) => [id, stored[plugin_id] ?? unmarked]));
  return make_screen(is_hosted, marks, new Map(collectors.map(({ id, value }) => [id, value.label])));
}

export function may_send(screen: Screen, collector: string): boolean {
  return !screen.is_hosted || screen.mark_of(collector).send_to_hosted;
}

export function is_trusted(screen: Screen, collector: string): boolean {
  return screen.mark_of(collector).trusted;
}

// What one read or instruction gave the engine: the collectors whose items it holds, and how many of each were withheld.
export interface Screened<Value> {
  value: Value;
  sources: Set<string>;
  withheld: Map<string, number>;
}

function note(into: Map<string, Set<string>>, collector: string, key: string): void {
  const keys = into.get(collector) ?? new Set<string>();
  keys.add(key);
  into.set(collector, keys);
}

// Keeps the entries the engine may be sent, noting each kept or withheld by its collector and key.
export function screen_entries<Entry>(screen: Screen, entries: Entry[], collector_of: (entry: Entry) => string, key_of: (entry: Entry) => string): Screened<Entry[]> {
  const kept: Entry[] = [];
  const sources = new Set<string>();
  const withheld = new Map<string, number>();
  for (const entry of entries) {
    const collector = collector_of(entry);
    if (may_send(screen, collector)) {
      kept.push(entry);
      sources.add(collector);
      note(screen.included, collector, key_of(entry));
    } else {
      withheld.set(collector, (withheld.get(collector) ?? 0) + 1);
      note(screen.withheld, collector, key_of(entry));
    }
  }
  return { value: kept, sources, withheld };
}

// Whether any of the collectors' items count as outside content.
export function taints(screen: Screen, sources: Iterable<string>): boolean {
  return [...sources].some((collector) => !is_trusted(screen, collector));
}

// One line telling the engine how many items were held back and why, so it can tell the user; empty when none were.
export function withheld_line(screen: Screen, withheld: Map<string, number>): string {
  const counts = [...withheld].filter(([, count]) => count > 0);
  if (counts.length === 0) return "";
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const each = counts.map(([collector, count]) => `${count} from ${screen.label_of(collector)}`).join(", ");
  return `[Withheld: ${total} ${total === 1 ? "item" : "items"} (${each}), because the user has not marked ${counts.length === 1 ? "that source" : "those sources"} “May be sent to a hosted engine” in CODEX's Settings. Tell the user if they would have helped.]`;
}

// How many of each source's entries a run sent or withheld, for the log.
export function counts_of(screen: Screen, from: Map<string, Set<string>>): SourceCount[] {
  return [...from]
    .map(([collector, keys]) => ({ collector, label: screen.label_of(collector), count: keys.size }))
    .sort((first, second) => first.label.localeCompare(second.label));
}
