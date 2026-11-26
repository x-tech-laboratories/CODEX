// The search index's calls: search everything kept by words and meaning, say how far indexing has come, and rebuild it
// from nothing. It keeps no table in the store's database; after every write it is asked to catch up.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "../api_schemas.ts";
import { embedder_setting } from "../embedders/embedder.ts";
import { define_feature } from "../feature.ts";
import { clear_and_reindex, index_host, index_state, poke_index } from "./indexer.ts";
import type { IndexState, SearchHit } from "./model.ts";
import { default_hits, most_hits, search } from "./search.ts";

// ── Calls ────────────────────────────────────────────────────────────────────

function search_index(database: SqlDatabase, query: string, context_id: string | null = null, limit: number = default_hits): Promise<SearchHit[]> {
  return search(database, index_host().index(), query, context_id || null, limit);
}

function get_index_state(database: SqlDatabase): Promise<IndexState> {
  return index_state(database, index_host().index());
}

// Answers at once with the state as rebuilding starts; the rest runs in the background.
function rebuild_index(database: SqlDatabase): Promise<IndexState> {
  clear_and_reindex();
  return index_state(database, index_host().index());
}

// ── Feature ──────────────────────────────────────────────────────────────────

export const search_feature = define_feature({
  id: "search",
  migrations: [],
  tables: [],
  methods: { search_index, get_index_state, rebuild_index },
  api: {
    search_index: {
      description:
        "Searches everything CODEX keeps, by its words and, once an embedder is set up, by its meaning: items with their text from their apps, contexts with their notes, and the conversations' messages. Gives back the best first, each with its kind, a short excerpt around the match and where it is: the contexts holding an item, the context a context sits in, or the context whose conversation holds a message.",
      params: [
        { name: "query", schema: text("What to look for, in plain words.") },
        { name: "context_id", schema: { type: ["string", "null"], description: "Search only this context and every context inside it; null or left out for everything." }, optional: true },
        { name: "limit", schema: { type: "integer", minimum: 1, maximum: most_hits, description: `How many to give back; ${default_hits} unless given.` }, optional: true },
      ],
    },
    get_index_state: {
      description:
        "Says how far the local search index has come: how many items, contexts and messages it holds, how many pieces of text have a vector from the embedder in use and how many wait, the embedder in use, and the last error.",
      params: [],
    },
    rebuild_index: {
      description: "Throws the local search index away and builds it again from what CODEX keeps and from the apps' text, in the background; nothing CODEX keeps is changed.",
      params: [],
      destructive: true,
    },
  },
  setting_defaults: { [embedder_setting]: "" },
  // Every write may have changed what is indexed.
  after_write: () => poke_index(),
});
