// What a run may show its engine of each source's items, and what reading them does to the run: a hosted engine is
// never given items from a source not marked for hosted engines, and only items from a source not marked trusted make
// the run's changes wait for the user. A screen also counts what it let through and held back, for the log.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { conversation_collector } from "../conversations/model.ts";
import { settings_feature } from "../settings.ts";
import { mark_names, unmarked, type SourceCount, type SourceMark } from "./model.ts";
import { unrecorded_label, unrecorded_source } from "./sources.ts";

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

// CODEX's own conversations as items: their titles are the user's words, and a run is never shown their exchanges.
const own_mark: SourceMark = { send_to_hosted: true, trusted: true };

function make_screen(is_hosted: boolean, marks: Map<string, SourceMark>, labels: Map<string, string>): Screen {
  return {
    is_hosted,
    mark_of: (collector) => (collector === conversation_collector ? own_mark : (marks.get(collector) ?? unmarked)),
    label_of: (collector) => (collector === unrecorded_source ? unrecorded_label : (labels.get(collector) ?? collector)),
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

// What one read or instruction gave the engine: the collectors whose items it holds, and how many of each were withheld,
// with what each withheld entry was, such as "message", when not every one was an item.
export interface Screened<Value> {
  value: Value;
  sources: Set<string>;
  withheld: Map<string, number>;
  withheld_kinds?: Map<string, number>;
}

function count_kind(screened: { withheld_kinds?: Map<string, number> }, kind: string): void {
  const kinds = (screened.withheld_kinds ??= new Map());
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}

export function note_source(into: Map<string, Set<string>>, collector: string, key: string): void {
  const keys = into.get(collector) ?? new Set<string>();
  keys.add(key);
  into.set(collector, keys);
}

// Keeps the entries the engine may be sent, noting each kept or withheld by its collector and key.
export function screen_entries<Entry>(screen: Screen, entries: Entry[], collector_of: (entry: Entry) => string, key_of: (entry: Entry) => string, kind_of: (entry: Entry) => string = () => "item"): Screened<Entry[]> {
  const kept: Entry[] = [];
  const sources = new Set<string>();
  const withheld = new Map<string, number>();
  const screened: Screened<Entry[]> = { value: kept, sources, withheld };
  for (const entry of entries) {
    const collector = collector_of(entry);
    if (may_send(screen, collector)) {
      kept.push(entry);
      sources.add(collector);
      note_source(screen.included, collector, key_of(entry));
    } else {
      withheld.set(collector, (withheld.get(collector) ?? 0) + 1);
      note_source(screen.withheld, collector, key_of(entry));
      count_kind(screened, kind_of(entry));
    }
  }
  return screened;
}

// Keeps the entries the engine may be sent when each carries several sources, or none: one is kept only when every
// source it carries may be sent, and one withheld is counted once, under the first source that may not.
export function screen_sourced<Entry>(screen: Screen, entries: Entry[], sources_of: (entry: Entry) => string[], key_of: (entry: Entry) => string, kind_of: (entry: Entry) => string = () => "item"): Screened<Entry[]> {
  const kept: Entry[] = [];
  const sources = new Set<string>();
  const withheld = new Map<string, number>();
  const screened: Screened<Entry[]> = { value: kept, sources, withheld };
  for (const entry of entries) {
    const carried = sources_of(entry);
    const blocked = carried.find((source) => !may_send(screen, source));
    if (blocked === undefined) {
      kept.push(entry);
      for (const source of carried) {
        sources.add(source);
        note_source(screen.included, source, key_of(entry));
      }
    } else {
      withheld.set(blocked, (withheld.get(blocked) ?? 0) + 1);
      note_source(screen.withheld, blocked, key_of(entry));
      count_kind(screened, kind_of(entry));
    }
  }
  return screened;
}

// Several screened parts' withheld counts as one, by source and by what was withheld.
export function merge_withheld(parts: { withheld: Map<string, number>; withheld_kinds?: Map<string, number> }[]): { withheld: Map<string, number>; withheld_kinds: Map<string, number> } {
  const withheld = new Map<string, number>();
  const withheld_kinds = new Map<string, number>();
  for (const part of parts) {
    for (const [collector, count] of part.withheld) withheld.set(collector, (withheld.get(collector) ?? 0) + count);
    const kinds = part.withheld_kinds ?? new Map([["item", [...part.withheld.values()].reduce((sum, count) => sum + count, 0)]]);
    for (const [kind, count] of kinds) if (count > 0) withheld_kinds.set(kind, (withheld_kinds.get(kind) ?? 0) + count);
  }
  return { withheld, withheld_kinds };
}

// Whether any of the collectors' items count as outside content.
export function taints(screen: Screen, sources: Iterable<string>): boolean {
  return [...sources].some((collector) => !is_trusted(screen, collector));
}

// What was withheld in plain words, such as "2 items and 1 message"; every one an item unless told otherwise.
function withheld_words(total: number, kinds: Map<string, number> | undefined): string {
  const counted = [...(kinds ?? new Map([["item", total]]))].filter(([, count]) => count > 0);
  const order = ["item", "message", "event", "feed", "followed feed", "group", "problem line", "node", "link", "entity"];
  counted.sort(([first], [second]) => (order.indexOf(first) + 1 || order.length + 1) - (order.indexOf(second) + 1 || order.length + 1) || first.localeCompare(second));
  const words = counted.map(([kind, count]) => `${count} ${count === 1 ? kind : `${kind}s`}`);
  return words.length <= 1 ? (words[0] ?? `${total} items`) : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// One line telling the engine how much was held back, of what and why, so it can tell the user; empty when nothing was.
export function withheld_line(screen: Screen, withheld: Map<string, number>, kinds?: Map<string, number>): string {
  const counts = [...withheld].filter(([, count]) => count > 0).sort(([first], [second]) => screen.label_of(first).localeCompare(screen.label_of(second)));
  if (counts.length === 0) return "";
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const each = counts.map(([collector, count]) => `${count} from ${screen.label_of(collector)}`).join(", ");
  return `[Withheld: ${withheld_words(total, kinds)} (${each}), because the user has not marked ${counts.length === 1 ? "that source" : "those sources"} “May be sent to a hosted engine” in CODEX's Settings. Tell the user if they would have helped.]`;
}

// How many of each source's entries a run sent or withheld, for the log.
export function counts_of(screen: Screen, from: Map<string, Set<string>>): SourceCount[] {
  return [...from]
    .map(([collector, keys]) => ({ collector, label: screen.label_of(collector), count: keys.size }))
    .sort((first, second) => first.label.localeCompare(second.label));
}
