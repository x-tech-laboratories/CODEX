// The local search index: a SQLite file of its own beside the store's database, never synced and never backed up,
// rebuilt from the store and the sources whenever it is lost. It holds each document's text in an FTS5 table, the text
// cut into overlapping pieces, and a vector for each piece from the embedder in use, tagged with that embedder and
// model. Only what changed is indexed again, by a hash of its text; embedding runs in batches in the background, waits
// while a reply is written, and makes no call when nothing is new.
//
// The index is a derived cache rather than a store feature, so it is reached with SQL of its own, which FTS5 and
// vector blobs need, rather than through Drizzle.

// ── Imports ──────────────────────────────────────────────────────────────────

import { migrate, type MigrationStep, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { open_plugin_host } from "../collectors/host.ts";
import { is_replying } from "../conversations/activity.ts";
import { embedder_setting, type Embedder } from "../embedders/embedder.ts";
import { is_hosted } from "../engines/engine.ts";
import { may_send, open_screen } from "../privacy/screen.ts";
import { settings_feature } from "../settings.ts";
import { read_documents, type SourceDocument } from "./documents.ts";
import type { IndexedEmbedder, IndexState } from "./model.ts";
import { chunk_text, text_hash, to_blob, unit } from "./text.ts";

// ── Schema ───────────────────────────────────────────────────────────────────

const schema: MigrationStep[] = [
  [
    `CREATE TABLE docs (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      collector TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      context_ids TEXT NOT NULL DEFAULT '[]',
      source_hash TEXT NOT NULL DEFAULT '',
      text_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    )`,
    `CREATE VIRTUAL TABLE docs_text USING fts5(key UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')`,
    `CREATE TABLE chunks (key TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (key, seq))`,
    `CREATE TABLE vectors (key TEXT NOT NULL, seq INTEGER NOT NULL, embedder TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (key, seq))`,
    `CREATE TABLE meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
  // The sources whose content each document carries, as a JSON list of collector ids.
  [`ALTER TABLE docs ADD COLUMN sources TEXT NOT NULL DEFAULT '["*"]'`, `UPDATE docs SET sources = json_array(collector) WHERE collector != ''`, `UPDATE docs SET sources = '[]' WHERE kind = 'context'`],
];

// Brings an index file up to date; run once each time it opens.
export function open_index(index: SqlDatabase): void {
  migrate(index, schema, { owner: "index" });
}

// ── Host ─────────────────────────────────────────────────────────────────────

export interface IndexHost {
  // The store's database, and the index's own.
  database: () => SqlDatabase;
  index: () => SqlDatabase;
}

let current: IndexHost | null = null;
let stopping = new AbortController();

// Set once where the store runs, the server or the desktop daemon; null stops using it.
export function use_search_index(host: IndexHost | null): void {
  current = host;
  if (host && stopping.signal.aborted) stopping = new AbortController();
}

export function index_host(): IndexHost {
  if (!current) throw new Error("The search index runs only where the store runs: on the server or in the desktop app's daemon.");
  return current;
}

// ── Meta ─────────────────────────────────────────────────────────────────────

function meta_of(index: SqlDatabase, name: string): string {
  return (index.prepare("SELECT value FROM meta WHERE name = ?").get(name) as { value: string } | undefined)?.value ?? "";
}

function set_meta(index: SqlDatabase, name: string, value: string): void {
  index.prepare("INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
}

// ── Indexing ─────────────────────────────────────────────────────────────────

interface IndexedRow {
  key: string;
  content: string;
  context_ids: string;
  sources: string;
  source_hash: string;
  text_hash: string;
}

// The text a document is searched and embedded by: its title, what the store says of it, and its app's text.
function full_text(document: SourceDocument, content: string): string {
  return [document.title, document.body, content].filter((part) => part.trim()).join("\n");
}

function remove_document(index: SqlDatabase, key: string): void {
  index.prepare("DELETE FROM docs WHERE key = ?").run(key);
  index.prepare("DELETE FROM docs_text WHERE key = ?").run(key);
  index.prepare("DELETE FROM chunks WHERE key = ?").run(key);
  index.prepare("DELETE FROM vectors WHERE key = ?").run(key);
}

function write_document(index: SqlDatabase, document: SourceDocument, content: string, hash: string): void {
  remove_document(index, document.key);
  index
    .prepare("INSERT INTO docs (key, kind, ref_id, collector, title, body, content, context_ids, sources, source_hash, text_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(document.key, document.kind, document.ref_id, document.collector, document.title, document.body, content, JSON.stringify(document.context_ids), JSON.stringify(document.sources), document.source_hash, hash, new Date().toISOString());
  index.prepare("INSERT INTO docs_text (key, title, body) VALUES (?, ?, ?)").run(document.key, document.title, [document.body, content].filter((part) => part.trim()).join("\n"));
  const insert = index.prepare("INSERT INTO chunks (key, seq, text) VALUES (?, ?, ?)");
  chunk_text(full_text(document, content)).forEach((text, seq) => insert.run(document.key, seq, text));
}

// Each item's text from its app, by item key, for the items whose app said something new of them; a collector that
// cannot give text, or fails, leaves its items' text as it was.
async function read_contents(database: SqlDatabase, wanted: SourceDocument[], problems: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (wanted.length === 0) return found;
  const collectors = (await open_plugin_host(database)).providers("collector");
  for (const { id, value } of collectors) {
    const own = wanted.filter((document) => document.collector === id);
    if (!value.content || own.length === 0) continue;
    try {
      const texts = await value.content(own.map((document) => document.source_id));
      for (const document of own) found.set(document.key, texts[document.source_id] ?? "");
    } catch (error) {
      problems.push(`${value.label}: ${(error as Error).message}`);
    }
  }
  return found;
}

// Brings the index in step with the store: new and changed documents written, gone ones removed, unchanged ones left
// alone. Gives back how many were written and removed.
export async function sync_documents(database: SqlDatabase, index: SqlDatabase, problems: string[] = []): Promise<{ written: number; removed: number }> {
  const documents = read_documents(database);
  const indexed = new Map((index.prepare("SELECT key, content, context_ids, sources, source_hash, text_hash FROM docs").all() as unknown as IndexedRow[]).map((row) => [row.key, row]));
  const needs_text = documents.filter((document) => document.kind === "item" && indexed.get(document.key)?.source_hash !== document.source_hash);
  const contents = await read_contents(database, needs_text, problems);
  let written = 0;
  index.exec("BEGIN");
  try {
    for (const document of documents) {
      const was = indexed.get(document.key);
      const content = contents.get(document.key) ?? was?.content ?? "";
      const hash = text_hash(full_text(document, content));
      const places = JSON.stringify(document.context_ids);
      if (was?.text_hash === hash) {
        if (was.context_ids !== places) index.prepare("UPDATE docs SET context_ids = ? WHERE key = ?").run(places, document.key);
        if (was.sources !== JSON.stringify(document.sources)) index.prepare("UPDATE docs SET sources = ? WHERE key = ?").run(JSON.stringify(document.sources), document.key);
        if (was.source_hash !== document.source_hash) index.prepare("UPDATE docs SET source_hash = ? WHERE key = ?").run(document.source_hash, document.key);
        continue;
      }
      write_document(index, document, content, hash);
      written += 1;
    }
    const present = new Set(documents.map((document) => document.key));
    const gone = [...indexed.keys()].filter((key) => !present.has(key));
    for (const key of gone) remove_document(index, key);
    index.exec("COMMIT");
    return { written, removed: gone.length };
  } catch (error) {
    index.exec("ROLLBACK");
    throw error;
  }
}

// ── Embedding ────────────────────────────────────────────────────────────────

export const embed_batch_size = 16;

export interface FoundEmbedder {
  id: string;
  embedder: Embedder;
}

// The embedder the settings name, or why there is none; null with no problem when none is chosen.
export async function find_embedder(database: SqlDatabase): Promise<{ found: FoundEmbedder | null; problem: string }> {
  const chosen = String(settings_feature.methods.get_settings(database)[embedder_setting] ?? "");
  if (!chosen) return { found: null, problem: "" };
  const provided = (await open_plugin_host(database)).providers("embedder").find((each) => each.id === chosen);
  return provided ? { found: { id: provided.id, embedder: provided.value }, problem: "" } : { found: null, problem: `The ${chosen} embedder is not running; turn its plugin on under Settings → Index.` };
}

export function describe_embedder({ id, embedder }: FoundEmbedder): IndexedEmbedder {
  return { id, label: embedder.label, model: embedder.model(), dimensions: embedder.dimensions(), is_local: !is_hosted(embedder) };
}

// The sources whose content a hosted embedder may not be sent, items' and answers' alike; none for a local one.
async function withheld_collectors(database: SqlDatabase, index: SqlDatabase, embedder: Embedder): Promise<string[]> {
  if (!is_hosted(embedder)) return [];
  const screen = await open_screen(database, true);
  const sources = (index.prepare("SELECT DISTINCT s.value AS source FROM docs d, json_each(d.sources) s").all() as { source: string }[]).map((row) => row.source);
  return sources.filter((source) => !may_send(screen, source));
}

// A condition on a document that holds none of the sources given.
function holds_none(values: string[]): string {
  return values.length === 0 ? "1" : `NOT EXISTS (SELECT 1 FROM json_each(d.sources) s WHERE s.value IN (${values.map(() => "?").join(", ")}))`;
}

// Pieces still without a vector from this embedder and model, but those it may not be sent.
function pending_query(index: SqlDatabase, withheld: string[], limit: number): { key: string; seq: number; text: string }[] {
  return index
    .prepare(
      `SELECT c.key, c.seq, c.text FROM chunks c JOIN docs d ON d.key = c.key
       LEFT JOIN vectors v ON v.key = c.key AND v.seq = c.seq
       WHERE v.key IS NULL AND ${holds_none(withheld)} ORDER BY c.key, c.seq LIMIT ?`,
    )
    .all(...withheld, limit) as { key: string; seq: number; text: string }[];
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits while a reply is being written, so the model answering is not kept waiting by the embedder.
async function yield_to_replies(signal: AbortSignal, wait_ms: number): Promise<void> {
  while (is_replying() && !signal.aborted) await pause(wait_ms);
}

// Embeds every piece that has no vector from the embedder in use, in batches; vectors from any other embedder or
// model are let go first, so changing either embeds everything again. Gives back how many pieces were embedded.
export async function embed_pending(database: SqlDatabase, index: SqlDatabase, signal: AbortSignal, wait_ms = 250): Promise<number> {
  const { found } = await find_embedder(database);
  if (!found) return 0;
  const { id, embedder } = found;
  const model = embedder.model();
  index.prepare("DELETE FROM vectors WHERE embedder != ? OR model != ?").run(id, model);
  const withheld = await withheld_collectors(database, index, embedder);
  let embedded = 0;
  while (!signal.aborted) {
    const batch = pending_query(index, withheld, embed_batch_size);
    if (batch.length === 0) break;
    await yield_to_replies(signal, wait_ms);
    if (signal.aborted) break;
    const vectors = await embedder.embed(
      batch.map((piece) => piece.text),
      signal,
    );
    const insert = index.prepare("INSERT OR REPLACE INTO vectors (key, seq, embedder, model, vector) VALUES (?, ?, ?, ?, ?)");
    batch.forEach((piece, at) => insert.run(piece.key, piece.seq, id, model, to_blob(unit(vectors[at]!))));
    embedded += batch.length;
  }
  return embedded;
}

// ── State ────────────────────────────────────────────────────────────────────

let working = false;

export async function index_state(database: SqlDatabase, index: SqlDatabase): Promise<IndexState> {
  const count = (sql: string, ...args: string[]) => (index.prepare(sql).get(...args) as { total: number }).total;
  const { found, problem } = await find_embedder(database);
  const withheld = found ? await withheld_collectors(database, index, found.embedder) : [];
  const chunks = count("SELECT COUNT(*) AS total FROM chunks");
  const withheld_chunks = withheld.length === 0 ? 0 : count(`SELECT COUNT(*) AS total FROM chunks c JOIN docs d ON d.key = c.key WHERE NOT ${holds_none(withheld)}`, ...withheld);
  const embedded = found ? count("SELECT COUNT(*) AS total FROM vectors WHERE embedder = ? AND model = ?", found.id, found.embedder.model()) : 0;
  return {
    items: count("SELECT COUNT(*) AS total FROM docs WHERE kind = 'item'"),
    contexts: count("SELECT COUNT(*) AS total FROM docs WHERE kind = 'context'"),
    messages: count("SELECT COUNT(*) AS total FROM docs WHERE kind = 'message'"),
    chunks,
    embedded,
    pending: found ? Math.max(0, chunks - withheld_chunks - embedded) : 0,
    withheld: withheld_chunks,
    embedder: found ? describe_embedder(found) : null,
    embedder_problem: problem,
    embedders: (await open_plugin_host(database)).providers("embedder").map(({ id, value }) => ({ id, label: value.label })),
    is_working: working,
    last_indexed_at: meta_of(index, "last_indexed_at"),
    last_error: meta_of(index, "last_error"),
  };
}

// ── Running ──────────────────────────────────────────────────────────────────

let again = false;
let running: Promise<void> = Promise.resolve();

// Indexes what changed and embeds what waits, once; a call while one runs makes it go round once more.
export function index_now(): Promise<void> {
  if (working) {
    again = true;
    return running;
  }
  const host = index_host();
  working = true;
  running = (async () => {
    try {
      do {
        again = false;
        const problems: string[] = [];
        try {
          await sync_documents(host.database(), host.index(), problems);
          await embed_pending(host.database(), host.index(), stopping.signal);
        } catch (error) {
          problems.push((error as Error).message);
        }
        set_meta(host.index(), "last_indexed_at", new Date().toISOString());
        set_meta(host.index(), "last_error", problems.join(" "));
      } while (again && !stopping.signal.aborted);
    } finally {
      working = false;
    }
  })();
  return running;
}

// Throws away everything indexed and starts again from the store and the sources, in the background.
export function clear_and_reindex(): void {
  const { index } = index_host();
  for (const table of ["docs", "docs_text", "chunks", "vectors"]) index().exec(`DELETE FROM ${table}`);
  set_meta(index(), "last_error", "");
  void index_now();
}

let poke_timer: ReturnType<typeof setTimeout> | undefined;

// Asks for an index pass soon, after a write; several close together make one.
export function poke_index(delay_ms = 1500): void {
  if (!current) return;
  clearTimeout(poke_timer);
  poke_timer = setTimeout(() => void index_now().catch((error: unknown) => console.warn("index:", error)), delay_ms);
}

// Indexes at start and every so often, catching changes that came by sync; stop() ends the work in hand.
export function keep_indexing(host: IndexHost, interval_ms = 60_000): { stop: () => Promise<void> } {
  use_search_index(host);
  void index_now().catch((error: unknown) => console.warn("index:", error));
  const timer = setInterval(() => void index_now().catch((error: unknown) => console.warn("index:", error)), interval_ms);
  return {
    stop: async () => {
      clearInterval(timer);
      clearTimeout(poke_timer);
      stopping.abort();
      await running;
      use_search_index(null);
    },
  };
}

// For tests: waits for the pass in hand and any asked for since.
export async function settle_index(): Promise<void> {
  clearTimeout(poke_timer);
  while (working) await running;
}
