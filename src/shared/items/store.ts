// The four calls every X-app answers about its items for other apps, through X-Libs `items`: CODEX's own contexts,
// conversations and entities, never the items it merely points to in other apps, which those apps answer for. A
// conversation is told by its title, the contexts holding it and when it was used, never by its messages.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray, like, or, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { item_calls, history_item_changes, type DeletedItem, type ItemFields, type ItemMethods } from "@x-tech-laboratories/x-libs/items";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_items, contexts, items } from "../contexts/schema.ts";
import { conversation_collector, conversation_item_id, conversation_kind } from "../conversations/model.ts";
import { summaries_of } from "../conversations/records.ts";
import { conversations } from "../conversations/schema.ts";
import { define_feature, drizzle_of } from "../feature.ts";
import { parse_names } from "../graph/records.ts";
import { graph_entities } from "../graph/schema.ts";
import { history_of, type Snapshot } from "../history/store.ts";
import { link_scheme } from "../links.ts";
import { migrations } from "./migrations/index.ts";
import { item_marks } from "./schema.ts";

// ── Kinds ────────────────────────────────────────────────────────────────────

export const item_kinds = [
  { kind: "context", label: "Context" },
  { kind: conversation_kind, label: "Conversation" },
  { kind: "entity", label: "Entity" },
] as const;

type OwnKind = (typeof item_kinds)[number]["kind"];

// Ids are unique across CODEX only with the kind in front, since a conversation kept from before conversations were
// items has its context's id.
export function own_item_id(kind: OwnKind, id: string): string {
  return `${kind}:${id}`;
}

function parse_own_id(item_id: string): { kind: OwnKind; id: string } | null {
  const at = item_id.indexOf(":");
  const kind = item_id.slice(0, at) as OwnKind;
  return at > 0 && item_kinds.some((each) => each.kind === kind) && at < item_id.length - 1 ? { kind, id: item_id.slice(at + 1) } : null;
}

const link_of = (kind: OwnKind, id: string) => `${link_scheme}://${kind}/${encodeURIComponent(id)}`;

// ── Contexts ─────────────────────────────────────────────────────────────────

type ContextRow = typeof contexts.$inferSelect;

function context_fields(row: Record<string, unknown>, item_count: number): Omit<ItemFields, "id" | "kind" | "changed_at"> {
  const id = String(row.id);
  return {
    title: String(row.name ?? ""),
    snippet: String(row.notes ?? ""),
    link: link_of("context", id),
    status: Number(row.is_archived) === 1 ? "archived" : "",
    detail: { ...(row.parent_id ? { parent: own_item_id("context", String(row.parent_id)) } : {}), items: String(item_count) },
  };
}

// When a version of it was last kept, or when it was made.
function latest_version_at(database: SqlDatabase, kind: string, id: string, fallback: string): string {
  return history_of(kind).read_versions(database, id)[0]?.changed_at ?? fallback;
}

function contexts_as_items(database: SqlDatabase, rows: ContextRow[]): ItemFields[] {
  const ids = rows.map((row) => row.id);
  const counts = new Map(
    ids.length === 0
      ? []
      : drizzle_of(database)
          .select({ id: context_items.context_id, total: sql<number>`count(*)` })
          .from(context_items)
          .where(inArray(context_items.context_id, ids))
          .groupBy(context_items.context_id)
          .all()
          .map((row) => [row.id, row.total]),
  );
  return rows.map((row) => ({
    id: own_item_id("context", row.id),
    kind: "context",
    changed_at: latest_version_at(database, "context", row.id, row.created_at),
    ...context_fields(row, counts.get(row.id) ?? 0),
  }));
}

// ── Entities ─────────────────────────────────────────────────────────────────

type EntityRow = typeof graph_entities.$inferSelect;

function entity_fields(row: Record<string, unknown>): Omit<ItemFields, "id" | "kind" | "changed_at"> {
  const id = String(row.id);
  const other_names = parse_names(String(row.alt_names ?? "[]"));
  const kind = String(row.kind ?? "other");
  return {
    title: String(row.name ?? ""),
    snippet: other_names.length ? `A ${kind}, also known as ${other_names.join(", ")}.` : `A ${kind}.`,
    link: link_of("entity", id),
    status: String(row.status ?? ""),
    detail: { type: kind, ...(other_names.length ? { other_names: other_names.join(", ") } : {}) },
  };
}

function entities_as_items(database: SqlDatabase, rows: EntityRow[]): ItemFields[] {
  return rows.map((row) => ({
    id: own_item_id("entity", row.id),
    kind: "entity",
    changed_at: latest_version_at(database, "entity", row.id, row.decided_at || row.created_at),
    ...entity_fields(row),
  }));
}

// ── Conversations ────────────────────────────────────────────────────────────

// What other apps are told of each conversation: its title, the contexts holding it and when it was used.
function conversation_items(database: SqlDatabase, ids: string[]): Map<string, Omit<ItemFields, "changed_at"> & { natural_at: string }> {
  return new Map(
    summaries_of(database, ids).map((summary) => {
      const names = summary.contexts.map((each) => each.name);
      return [
        summary.id,
        {
          id: own_item_id(conversation_kind, summary.id),
          kind: conversation_kind,
          title: summary.title,
          snippet: names.length ? `A conversation in ${names.join(", ")}.` : "A conversation in no context.",
          link: link_of(conversation_kind, summary.id),
          status: "",
          detail: { last_used_at: summary.last_used_at, messages: String(summary.message_count), ...(names.length ? { contexts: names.join(", ") } : {}) },
          natural_at: summary.last_used_at > summary.created_at ? summary.last_used_at : summary.created_at,
        },
      ];
    }),
  );
}

const fingerprint_of = (item: Omit<ItemFields, "changed_at">) => JSON.stringify([item.title, item.snippet, item.detail]);
const deleted_fingerprint = "deleted";

// Brings each conversation's mark up to date: a new one is dated by its own record, a changed or deleted one by when
// the change was first noticed, always after any time already given, so a caller's moment misses nothing.
export function refresh_conversation_marks(database: SqlDatabase): void {
  const db = drizzle_of(database);
  const live = conversation_items(database, db.select({ id: conversations.id }).from(conversations).all().map((row) => row.id));
  const gone = db
    .select({ id: items.source_id, seen_at: items.seen_at, created_at: items.created_at })
    .from(items)
    .where(eq(items.collector, conversation_collector))
    .all()
    .filter((row) => !live.has(row.id));
  const marks = new Map(db.select().from(item_marks).where(eq(item_marks.kind, conversation_kind)).all().map((row) => [row.id, row]));
  const latest = marks.size ? [...marks.values()].reduce((last, row) => (row.changed_at > last ? row.changed_at : last), "") : "";
  let now = new Date().toISOString();
  if (now <= latest) now = new Date(Date.parse(latest) + 1).toISOString();
  const wanted = [
    ...[...live].map(([id, item]) => ({ id, fingerprint: fingerprint_of(item), first_at: item.natural_at })),
    ...gone.map((row) => ({ id: row.id, fingerprint: deleted_fingerprint, first_at: row.seen_at || row.created_at })),
  ];
  in_transaction(database, () => {
    for (const { id, fingerprint, first_at } of wanted) {
      const mark = marks.get(id);
      if (mark?.fingerprint === fingerprint) continue;
      const changed_at = mark ? now : first_at;
      db.insert(item_marks)
        .values({ kind: conversation_kind, id, fingerprint, changed_at })
        .onConflictDoUpdate({ target: [item_marks.kind, item_marks.id], set: { fingerprint, changed_at } })
        .run();
    }
  });
}

function conversation_marks(database: SqlDatabase, ids?: string[]): Map<string, { fingerprint: string; changed_at: string }> {
  const db = drizzle_of(database);
  const rows = db
    .select()
    .from(item_marks)
    .where(ids ? and(eq(item_marks.kind, conversation_kind), inArray(item_marks.id, ids)) : eq(item_marks.kind, conversation_kind))
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

function conversations_as_items(database: SqlDatabase, ids: string[]): ItemFields[] {
  if (ids.length === 0) return [];
  refresh_conversation_marks(database);
  const marks = conversation_marks(database, ids);
  const found = conversation_items(database, ids);
  return ids.flatMap((id) => {
    const item = found.get(id);
    if (!item) return [];
    const { natural_at, ...fields } = item;
    return [{ ...fields, changed_at: marks.get(id)?.changed_at ?? natural_at }];
  });
}

// ── Searching ────────────────────────────────────────────────────────────────

function words_of(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const contains_all = (words: string[], text: string) => words.every((word) => text.toLowerCase().includes(word));

// How well an item's title answers: the whole query in it, every word in it, or only in its notes.
function score_of(query: string, title: string): number {
  const lower = title.toLowerCase();
  if (lower.includes(query.toLowerCase())) return 2;
  return contains_all(words_of(query), lower) ? 1 : 0;
}

function search(database: SqlDatabase, query: string, limit: number): ItemFields[] {
  const words = words_of(query);
  const db = drizzle_of(database);
  const text_holds = (columns: Parameters<typeof like>[0][]) => and(...words.map((word) => or(...columns.map((column) => like(column, `%${word}%`)))));
  const found_contexts = db.select().from(contexts).where(text_holds([contexts.name, contexts.notes])).all();
  const found_entities = db.select().from(graph_entities).where(text_holds([graph_entities.name, graph_entities.alt_names])).all();
  // A conversation's title may come from its first message, so titles are matched as they read, with the notes on it.
  const conversation_ids = db.select({ id: conversations.id }).from(conversations).all().map((row) => row.id);
  const notes = new Map<string, string>();
  for (const row of db.select({ item_id: context_items.item_id, note: context_items.note }).from(context_items).where(sql`${context_items.item_id} LIKE ${`${conversation_collector}:%`}`).all()) {
    notes.set(row.item_id, `${notes.get(row.item_id) ?? ""} ${row.note}`);
  }
  const matching_conversations = summaries_of(database, conversation_ids)
    .filter((summary) => contains_all(words, `${summary.title} ${notes.get(conversation_item_id(summary.id)) ?? ""}`))
    .map((summary) => summary.id);
  const found = [...contexts_as_items(database, found_contexts), ...conversations_as_items(database, matching_conversations), ...entities_as_items(database, found_entities)];
  return found
    .map((item, order) => ({ item, order, score: score_of(query, item.title) }))
    .sort((first, second) => second.score - first.score || first.order - second.order)
    .slice(0, limit)
    .map(({ item }) => item);
}

// ── Getting ──────────────────────────────────────────────────────────────────

function get(database: SqlDatabase, item_ids: string[]): ItemFields[] {
  const wanted: Record<OwnKind, string[]> = { context: [], conversation: [], entity: [] };
  for (const item_id of item_ids) {
    const parsed = parse_own_id(item_id);
    if (parsed) wanted[parsed.kind].push(parsed.id);
  }
  const db = drizzle_of(database);
  const found = [
    ...contexts_as_items(database, wanted.context.length ? db.select().from(contexts).where(inArray(contexts.id, wanted.context)).all() : []),
    ...conversations_as_items(database, wanted.conversation),
    ...entities_as_items(database, wanted.entity.length ? db.select().from(graph_entities).where(inArray(graph_entities.id, wanted.entity)).all() : []),
  ];
  const by_id = new Map(found.map((item) => [item.id, item]));
  return item_ids.flatMap((id) => (by_id.has(id) ? [by_id.get(id)!] : []));
}

// ── Changes ──────────────────────────────────────────────────────────────────

// Contexts and entities from their versions in History; a context's version counts its memberships.
const history_changes = (database: SqlDatabase) =>
  history_item_changes<Snapshot>(
    [
      {
        kind: "context",
        history: history_of("context"),
        id: (id) => own_item_id("context", id),
        item: (snapshot) => context_fields(snapshot.contexts?.[0] ?? {}, snapshot.context_items?.length ?? 0),
      },
      {
        kind: "entity",
        history: history_of("entity"),
        id: (id) => own_item_id("entity", id),
        item: (snapshot) => entity_fields(snapshot.graph_entities?.[0] ?? {}),
      },
    ],
    () => database,
  );

// Conversations from their marks, deleted ones as gone.
function conversation_changes(database: SqlDatabase, since: string | null, limit: number): (ItemFields | DeletedItem)[] {
  refresh_conversation_marks(database);
  const marks = [...conversation_marks(database)]
    .filter(([, mark]) => since === null || mark.changed_at > since)
    .sort(([, first], [, second]) => first.changed_at.localeCompare(second.changed_at));
  // Every mark at the same moment as the last one kept goes too, as the caller's next moment would skip them.
  let end = Math.min(limit, marks.length);
  while (end < marks.length && marks[end]![1].changed_at === marks[end - 1]![1].changed_at) end++;
  const kept = marks.slice(0, end);
  const live = conversation_items(database, kept.filter(([, mark]) => mark.fingerprint !== deleted_fingerprint).map(([id]) => id));
  return kept.map(([id, mark]): ItemFields | DeletedItem => {
    const item = live.get(id);
    if (!item) return { id: own_item_id(conversation_kind, id), kind: conversation_kind, is_deleted: true, changed_at: mark.changed_at };
    const { natural_at: _natural_at, ...fields } = item;
    return { ...fields, changed_at: mark.changed_at };
  });
}

// ── Calls ────────────────────────────────────────────────────────────────────

function calls_on(database: SqlDatabase) {
  return item_calls(
    {
      kinds: item_kinds,
      search: (query, limit) => search(database, query, limit),
      get: (ids) => get(database, ids),
      changes: async (since, limit) => [...(await history_changes(database)(since, limit)), ...conversation_changes(database, since, limit)],
    },
    { scheme: link_scheme },
  );
}

const spec = calls_on(null as unknown as SqlDatabase).api;

export const items_feature = define_feature({
  id: "items",
  migrations: migrations.map((migration) => migration.statements),
  // The marks are this device's own reading of its conversations, so nothing here syncs.
  tables: [],
  methods: {
    list_item_kinds: (database: SqlDatabase): ReturnType<ItemMethods["list_item_kinds"]> => calls_on(database).methods.list_item_kinds(),
    search_items: (database: SqlDatabase, query: string, limit?: number): ReturnType<ItemMethods["search_items"]> => calls_on(database).methods.search_items(query, limit),
    get_items: (database: SqlDatabase, ids: string[]): ReturnType<ItemMethods["get_items"]> => calls_on(database).methods.get_items(ids),
    list_item_changes: (database: SqlDatabase, since?: string | null, limit?: number): ReturnType<ItemMethods["list_item_changes"]> =>
      calls_on(database).methods.list_item_changes(since, limit),
  },
  api: {
    list_item_kinds: { ...spec.list_item_kinds, description: `${spec.list_item_kinds.description} CODEX's own are contexts, conversations and entities; the items it points to in other apps are answered for by those apps.` },
    search_items: { ...spec.search_items, description: `${spec.search_items.description} Contexts are found by name and notes, conversations by title and the notes on them, entities by name.` },
    get_items: { ...spec.get_items, description: `${spec.get_items.description} Ids are the kind and CODEX's own id, such as context:<id>.` },
    list_item_changes: spec.list_item_changes,
  },
});
