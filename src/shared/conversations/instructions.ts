// What the engine is told before the conversation: who it is, today's date, the context the user has open with what it
// holds, and the rules. What other apps wrote, such as item titles and snippets, goes inside the untrusted fence, and a
// hosted engine is told only how many items it was not sent from sources not marked for one. The context's other
// conversations are CODEX's own and are named by their titles alone. Each listing is capped, so a full context cannot
// crowd a small model's context.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { blueprint_collector } from "../blueprints/model.ts";
import type { CollectorSummary } from "../collectors/collector.ts";
import { contexts_feature } from "../contexts/store.ts";
import { context_or_global, global_context_id, type ContextItem } from "../contexts/model.ts";
import { contexts } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { finding_collector } from "../interests/model.ts";
import { fill, fill_each, prompts } from "../prompts/prompts.ts";
import { item_sources, local_screen, may_send, screen_sourced, withheld_line, type Screen, type Screened } from "../privacy/screen.ts";
import { conversation_collector, conversation_of_item } from "./model.ts";
import { conversation_row } from "./records.ts";

// ── Instructions ─────────────────────────────────────────────────────────────

// The open context's listings, each capped by count and by characters; a line says how many more there are.
export const listing_caps = {
  items: { most: 30, chars: 3000 },
  children: { most: 20, chars: 1000 },
  conversations: { most: 10, chars: 600 },
  entities: { most: 30, chars: 1500 },
  links: { most: 30, chars: 2500 },
};

const longest_snippet = 120;

// Global's notes reach every conversation, so a long one is cut to this many characters, with a line on reading the rest.
export const longest_global_notes = 1500;

// Global's notes as they go into the instructions: whole when they fit, otherwise cut with a line saying where the rest is.
export function global_notes_of(notes: string): string {
  const trimmed = notes.trim();
  if (trimmed.length <= longest_global_notes) return trimmed;
  return `${trimmed.slice(0, longest_global_notes - 1)}…\n${fill(prompts.conversation.global_notes_go_on, { id: global_context_id })}`;
}

// The user's standing guidance from Global's notes, for a conversation in any other context; empty when there is none.
function global_guidance(database: SqlDatabase): string {
  const global = drizzle_of(database).select({ name: contexts.name, notes: contexts.notes }).from(contexts).where(eq(contexts.id, global_context_id)).get();
  if (!global?.notes.trim()) return "";
  return fill(prompts.conversation.global_guidance, { name: global.name, notes: global_notes_of(global.notes) });
}

// Who the engine is and the rules, whichever tools it has.
// What to do when a tool or specialist cannot give what is needed, said to the run and to every specialist.
export const give_up_line = prompts.conversation.give_up;

// How to go through a job: one small step at a time, keeping the task list, so a small model never holds it all at once.
export const one_at_a_time_line = prompts.conversation.one_at_a_time;

export const work_line = fill(prompts.conversation.work, { one_at_a_time: one_at_a_time_line });

const identity = fill_each(prompts.conversation.identity, { give_up: give_up_line, work: work_line });

// What the engine is told of CODEX's own calls when it has them itself, or instead the specialists' lines, whose own
// instructions say how each part works.
function identity_of(with_specialists: boolean): string {
  return [...identity, ...(with_specialists ? prompts.conversation.with_specialists : prompts.conversation.own_calls)].join("\n");
}

// CODEX's own collectors, which are not source apps.
export const own_collectors: ReadonlySet<string> = new Set([conversation_collector, blueprint_collector, finding_collector]);

// The source apps CODEX can read now, by the collector id each call takes, and how to read them.
export function sources_part(all: CollectorSummary[], with_specialists = false): string {
  const collectors = all.filter((each) => !own_collectors.has(each.id) && (each.can_search || each.can_refresh));
  if (collectors.length === 0) return prompts.sources.none;
  const named = collectors.map((each) => fill(each.can_search ? prompts.sources.entry : prompts.sources.entry_cannot_search, { label: each.label, id: each.id })).join(", ");
  return fill(with_specialists ? prompts.sources.connected_with_specialists : prompts.sources.connected, { named });
}

export function shortened(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > longest_snippet ? `${flat.slice(0, longest_snippet - 1)}…` : flat;
}

function item_line(item: ContextItem): string {
  const facts = [`[${item.kind}] ${shortened(item.title)}`, item.status ? `status: ${item.status}` : "", `id: ${item.id}`, item.snippet ? `snippet: ${shortened(item.snippet)}` : "", item.note ? `note: ${shortened(item.note)}` : ""];
  return `- ${facts.filter(Boolean).join("; ")}`;
}

// The first entries whose text fits in the characters, at most `most` of them, and always the first.
export function capped<Entry>(entries: Entry[], text_of: (entry: Entry) => string, cap: { most: number; chars: number }): Entry[] {
  const kept: Entry[] = [];
  let chars = 0;
  for (const entry of entries.slice(0, cap.most)) {
    chars += text_of(entry).length + 2;
    if (chars > cap.chars && kept.length > 0) break;
    kept.push(entry);
  }
  return kept;
}

// The open context: its name, where it sits in the tree, its notes, the contexts inside it, the items it may be sent and
// its other conversations by title.
function context_part(database: SqlDatabase, context_id: string, conversation_id: string | null, screen: Screen): Screened<string> {
  const context = contexts_feature.methods.get_context(database, context_id);
  const all = contexts_feature.methods.list_contexts(database, true);
  const by_id = new Map(all.map((each) => [each.id, each]));
  const path: string[] = [];
  for (let at = by_id.get(context_id); at; at = at.parent_id ? by_id.get(at.parent_id) : undefined) {
    path.unshift(at.name);
    if (path.length > all.length) break;
  }
  const children = all.filter((each) => each.parent_id === context_id);
  // Blueprints are recalled on their own when they match, so they are not listed here.
  const held = context.items.filter((item) => item.collector !== conversation_collector && item.collector !== blueprint_collector);
  const others = context.items.filter((item) => item.collector === conversation_collector && conversation_of_item(item.id) !== conversation_id && item.status !== "missing");
  // The newest items it may be sent, as many as the caps allow, and every one withheld, counted; a finding carries the
  // web results it was written from as well as its own collector.
  const sendable = (item: ContextItem) => item_sources(item).every((source) => may_send(screen, source));
  const chosen = new Set(capped(held.filter(sendable), item_line, listing_caps.items));
  const screened = screen_sourced(screen, held.filter((item) => chosen.has(item) || !sendable(item)), item_sources, (item) => item.id);
  const listed = screened.value;
  const child_text = (child: (typeof children)[number]) => `"${child.name}" (id ${child.id})`;
  const listed_children = capped(children, child_text, listing_caps.children);
  const is_global = context_id === global_context_id;
  const notes = is_global ? global_notes_of(context.notes) : context.notes.trim();
  const words = prompts.open_context;
  const opened = is_global ? words.global : context.is_archived ? words.open_archived : words.open;
  const lines = [
    fill(opened, { name: context.name, id: context.id }),
    fill(words.where, { path: path.join(" › ") }),
    notes ? fill(is_global ? words.notes_global : words.notes, { notes }) : words.no_notes,
  ];
  if (children.length === 0) lines.push(words.no_children);
  else {
    const more = children.length - listed_children.length;
    lines.push(fill(more > 0 ? words.children_more : words.children, { listed: listed_children.map(child_text).join(", "), more }));
  }
  if (held.length === 0) lines.push(words.no_items);
  else {
    lines.push(fill(words.items, { count: held.length }));
    if (listed.length > 0) lines.push(untrusted_block(listed.map(item_line).join("\n")));
    const withheld = withheld_line(screen, screened.withheld, screened.withheld_kinds);
    if (withheld) lines.push(withheld);
    const more = held.length - listed.length - [...screened.withheld.values()].reduce((sum, count) => sum + count, 0);
    if (more > 0) lines.push(fill(words.items_more, { more }));
  }
  if (others.length > 0) {
    const other_text = (item: (typeof others)[number]) => `"${shortened(item.title)}" (id ${item.id})`;
    const listed_others = capped(others, other_text, listing_caps.conversations);
    const more = others.length - listed_others.length;
    lines.push(fill(more > 0 ? words.conversations_more : words.conversations, { listed: listed_others.map(other_text).join(", "), more }));
  }
  return { ...screened, value: lines.join("\n") };
}

// The instructions with the sources whose items they hold, so a run knows whether it starts having read outside content.
// Global's notes come first in every other context, as the user's standing guidance; null or none open means Global.
// With specialists, what is said of CODEX's own calls is left to theirs.
export function screened_instructions(database: SqlDatabase, given_context: string | null, conversation_id: string | null, today: string, screen: Screen, with_specialists = false): Screened<string> {
  if (conversation_id !== null) conversation_row(database, conversation_id);
  const context_id = context_or_global(given_context);
  const context = context_part(database, context_id, conversation_id, screen);
  const guidance = context_id === global_context_id ? "" : global_guidance(database);
  return { ...context, value: [identity_of(with_specialists), fill(prompts.conversation.today, { today }), guidance, context.value].filter(Boolean).join("\n\n") };
}

export function build_instructions(database: SqlDatabase, context_id: string | null, today: string, screen: Screen = local_screen(), conversation_id: string | null = null, with_specialists = false): string {
  return screened_instructions(database, context_id, conversation_id, today, screen, with_specialists).value;
}
