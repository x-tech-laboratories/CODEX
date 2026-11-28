// Contexts and the items they hold: the tree of contexts, items added from collectors or pushed in by another app,
// and a refresh that asks each collector what became of its items. Items are only ever pointers to another app's data.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { define_feature, drizzle_of } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import { global_context_id, type CardPlace, type ContextView } from "./model.ts";
import { context_seeds, context_tables, contexts } from "./schema.ts";
import { add_context, add_item, add_item_to_contexts, add_manual_item, checked_places, context_row, ensure_global, get_context, get_item, global_fixed, list_contexts, move_context, move_item, remove_context, remove_item, save_view, search_kept_items, set_item_note } from "./records.ts";
import { add_contexts_from_feed_group, add_contexts_from_feeds, follow_feed, get_source_content, get_source_item, list_collector_feeds, list_collectors, list_feed_group_news, refresh_items, search_collector, unfollow_feed } from "./feeds.ts";
import { export_contexts, import_contexts } from "./transfer.ts";

// ── Feature ──────────────────────────────────────────────────────────────────

const found_item_schema = {
  type: "object",
  required: ["source_id", "kind", "title"],
  properties: {
    source_id: text("The item's id in its own app, such as a task id, a file's path or an email's Message-ID."),
    kind: text("What it is, such as task, note, file, email or link."),
    title: text("Its title."),
    snippet: text("A line or two of what it says."),
    uri: text("Where it opens, such as x-tasks://task/<id>, mid:<message-id> or a web address."),
    status: text('A short state, such as "done".'),
    detail: { type: "object", additionalProperties: { type: "string" }, description: "Other facts as text, such as from and date for an email." },
  },
  description: "The item as its collector describes it.",
} as const;

const context_ids_schema = { type: "array", items: { type: "string" }, minItems: 1, description: "The ids of the contexts to add it to, from list_contexts." } as const;
const collector_schema = text("The collector's id, from list_collectors, such as x-tasks, trilium, files, links or email.");
const nullable_context = { type: ["string", "null"], description: "A context's id, from list_contexts; null for Global, the root every other context sits under." } as const;

export const contexts_feature = define_feature({
  id: "contexts",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(context_tables),
  on_open: ensure_global,
  after_write: ensure_global,
  methods: {
    list_contexts,
    get_context,
    search_kept_items,
    get_item,
    list_collectors,
    search_collector,
    get_source_item,
    get_source_content,
    list_collector_feeds,
    list_feed_group_news,
    export_contexts,
    add_context,
    rename_context: (database: SqlDatabase, id: string, name: string): void => {
      if (!name.trim()) throw new Error("Give the context a name.");
      context_row(database, id);
      drizzle_of(database).update(contexts).set({ name: name.trim() }).where(eq(contexts.id, id)).run();
    },
    set_context_notes: (database: SqlDatabase, id: string, notes: string): void => {
      context_row(database, id);
      drizzle_of(database).update(contexts).set({ notes }).where(eq(contexts.id, id)).run();
    },
    set_context_archived: (database: SqlDatabase, id: string, is_archived: boolean): void => {
      context_row(database, id);
      if (id === global_context_id) throw new Error(global_fixed);
      drizzle_of(database).update(contexts).set({ is_archived: is_archived ? 1 : 0 }).where(eq(contexts.id, id)).run();
    },
    move_context,
    remove_context,
    add_item,
    add_manual_item,
    set_item_note,
    remove_item,
    add_item_to_contexts,
    move_item,
    refresh_items,
    set_context_view: (database: SqlDatabase, id: string, view: ContextView): void => {
      if (view !== "list" && view !== "cards" && view !== "grouped" && view !== "graph") throw new Error('A context shows its items as "list", "cards", "grouped" or "graph".');
      save_view(database, id, { view });
    },
    set_card_places: (database: SqlDatabase, id: string, places: CardPlace[]): void => save_view(database, id, { card_places: JSON.stringify(checked_places(places)) }),
    follow_feed,
    unfollow_feed,
    add_contexts_from_feeds,
    add_contexts_from_feed_group,
    stop_feed_group_news: (database: SqlDatabase, id: string): void => {
      context_row(database, id);
      drizzle_of(database).delete(context_seeds).where(eq(context_seeds.context_id, id)).run();
    },
    import_contexts,
  },
  api: {
    list_contexts: {
      description: "Lists the contexts, each a project or area of life, as a tree by parent_id, with how many items each holds. Global, id \"global\", is the root: every other context sits under it, its notes apply to every conversation, and it can hold items of its own.",
      params: [{ name: "include_archived", schema: { type: "boolean", description: "Whether archived contexts are listed too; they are not unless true." }, optional: true }],
    },
    get_context: {
      description: "Gets one context with its notes and every item it holds: tasks, notes, files, emails and links from other apps, newest first, each with where it opens and the other contexts holding it.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    search_kept_items: {
      description: "Finds items already in any context whose title, snippet or address holds the text, with the contexts holding each.",
      params: [{ name: "query", schema: text("The text to look for.") }],
    },
    get_item: { description: "Gets one item with every context that holds it.", params: [{ name: "id", schema: id_of("item") }] },
    list_collectors: {
      description: "Lists the running collectors, the plugins that bring items from other apps: which can search, which take items typed in by hand and which are sent items from elsewhere.",
      params: [],
    },
    search_collector: {
      description: "Searches one collector's app, such as X-Tasks or Trilium, for items to add, each with the contexts already holding it.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "query", schema: text("The text to search for.") },
      ],
    },
    get_source_item: {
      description: "Reads one item as its app has it now, such as a Trilium note or an X-Tasks task, by its id in that app, with the contexts already holding it; the item need not be in any context.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "source_id", schema: text("The item's id in its own app, such as a Trilium note id; from a link, the id it ends with.") },
      ],
    },
    get_source_content: {
      description:
        "Reads one item's whole current content from its app, live, such as a Trilium note's text with its labels and relations, or an X-Tasks task's full notes with its tags, due date and parent, by its id in that app, with the contexts already holding it. Nothing read is kept.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "source_id", schema: text("The item's id in its own app, such as a Trilium note id; from a link, the id it ends with.") },
      ],
    },
    set_context_view: {
      description:
        "Shows a context's items as a list grouped by kind, as a card per item, grouped: a card per kind, such as one holding every task, each listing its items, or as the graph of the context, its items, their entities and links. Cards sit in a grid and can be moved and resized.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "view", schema: { type: "string", enum: ["list", "cards", "grouped", "graph"], description: "list, cards, grouped or graph." } },
      ],
    },
    set_card_places: {
      description: "Sets where each item's card sits in a context's card grid, in cells of a 12-column grid; items left out are placed below the rest.",
      params: [
        { name: "id", schema: id_of("context") },
        {
          name: "places",
          schema: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "x", "y", "w", "h"],
              properties: {
                id: text("The item's id."),
                x: { type: "integer", minimum: 0, description: "Its column, from 0 at the left." },
                y: { type: "integer", minimum: 0, description: "Its row, from 0 at the top." },
                w: { type: "integer", minimum: 1, description: "Its width in columns." },
                h: { type: "integer", minimum: 1, description: "Its height in rows." },
              },
            },
            description: "Every card's place.",
          },
        },
      ],
    },
    list_collector_feeds: {
      description: "Lists what a context can follow in one collector's app, such as X-Tasks tags and tasks with subtasks, each with an id to pass to follow_feed and, for a tag, the filter group it is in.",
      params: [{ name: "collector", schema: collector_schema }],
    },
    follow_feed: {
      description:
        "Makes a context follow a feed: its items join now and on every refresh, and leave when they leave the feed, unless they were added by hand or given a note. Gives back what joined.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "collector", schema: collector_schema },
        { name: "feed_id", schema: text("The feed's id from list_collector_feeds.") },
        { name: "label", schema: text("The feed's name, as list_collector_feeds gives it.") },
      ],
    },
    unfollow_feed: {
      description: "Stops a context following a feed; the items it brought leave, but for those added by hand or given a note.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "collector", schema: collector_schema },
        { name: "feed_id", schema: text("The feed's id.") },
      ],
    },
    add_contexts_from_feeds: {
      description: "Makes a context for each feed given, named for it and following it, such as one per X-Tasks tag; gives back their ids.",
      params: [
        { name: "collector", schema: collector_schema },
        {
          name: "feeds",
          schema: {
            type: "array",
            minItems: 1,
            items: { type: "object", required: ["id", "label"], properties: { id: text("The feed's id."), label: text("The feed's name, which the context takes.") } },
            description: "The feeds from list_collector_feeds.",
          },
        },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    add_contexts_from_feed_group: {
      description:
        "Makes a context named for a group in a collector's app, such as an X-Tasks filter group, with a context inside it for each of the group's feeds, such as one per tag, each following it; gives back the new context's id. Feeds added to the group later are offered by list_feed_group_news.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "group_id", schema: text("The group's id, from the group of a feed in list_collector_feeds.") },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    list_feed_group_news: {
      description: "Lists the feeds of the group a context was made from that no context inside it follows yet, such as a tag added to an X-Tasks filter group since; empty for a context not made from a group.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    stop_feed_group_news: {
      description: "Stops offering a context the feeds added to the group it was made from; the contexts inside it stay.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    export_contexts: { description: "Exports every context, item and membership as one JSON object.", params: [] },
    add_context: {
      description: "Adds a context under another, or directly under Global, and gives back its id.",
      params: [
        { name: "name", schema: text("Its name, such as a project's.") },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    rename_context: {
      description: "Renames a context, Global included.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "name", schema: text("The new name.") },
      ],
    },
    set_context_notes: {
      description: "Sets what a context is about, in Markdown.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "notes", schema: text("The notes in Markdown.") },
      ],
    },
    set_context_archived: {
      description: "Archives a context, hiding it from the list, or brings it back. Global cannot be archived.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "is_archived", schema: { type: "boolean", description: "True to archive, false to bring back." } },
      ],
    },
    move_context: {
      description: "Moves a context under another, or directly under Global for null. Global itself cannot be moved.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "parent_id", schema: nullable_context },
        { name: "position", schema: { type: ["number", "null"], description: "Its place among its new siblings; null puts it last." }, optional: true },
      ],
    },
    remove_context: {
      description: "Deletes a context and every context inside it; the items stay in their own apps. Global cannot be deleted.",
      params: [{ name: "id", schema: id_of("context") }],
      destructive: true,
    },
    add_item: {
      description: "Adds an item from another app to contexts, such as an email sent from Thunderbird or a result of search_collector, and gives back the item's id.",
      params: [
        { name: "context_ids", schema: context_ids_schema },
        { name: "collector", schema: collector_schema },
        { name: "item", schema: found_item_schema },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    add_manual_item: {
      description: "Adds an item typed in by hand, such as a web link, to contexts, with the fields list_collectors names for that collector.",
      params: [
        { name: "context_ids", schema: context_ids_schema },
        { name: "collector", schema: collector_schema },
        { name: "values", schema: { type: "object", additionalProperties: { type: "string" }, description: "The fields by key, such as url and title." } },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    set_item_note: {
      description: "Sets the note on why an item is in a context.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "item_id", schema: id_of("item") },
        { name: "note", schema: text("The note.") },
      ],
    },
    remove_item: {
      description: "Takes an item out of a context; it stays in its own app. A conversation cannot be taken out of the last context holding it; delete_conversation deletes it.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "item_id", schema: id_of("item") },
      ],
    },
    add_item_to_contexts: {
      description: "Puts an item CODEX already keeps, such as one in another context, in more contexts, with a note on why.",
      params: [
        { name: "item_id", schema: id_of("item") },
        { name: "context_ids", schema: context_ids_schema },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    move_item: {
      description: "Moves an item, such as a conversation, from one context to another, with its note; it stays in any other context holding it.",
      params: [
        { name: "context_id", schema: { ...id_of("context"), description: "The context it is in now." } },
        { name: "item_id", schema: id_of("item") },
        { name: "to_context_id", schema: { ...id_of("context"), description: "The context it moves to." } },
      ],
    },
    refresh_items: {
      description: "Asks each collector what became of its items, in one context or, for Global or null, everywhere, keeping new titles and states and marking missing the ones gone.",
      params: [{ name: "context_id", schema: nullable_context, optional: true }],
    },
    import_contexts: {
      description: "Imports an export_contexts file; rows with the same id are replaced by the file's.",
      params: [{ name: "json", schema: text("The whole file's text.") }],
    },
  },
});
