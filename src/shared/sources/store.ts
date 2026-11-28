// The apps read through the standard item calls: added, changed and removed by the user at CODEX's own page, each
// checked as it is saved, and listed for anyone with its token hidden.

// ── Imports ──────────────────────────────────────────────────────────────────

import { checked_item_address } from "@x-tech-laboratories/x-libs/item_client";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { define_feature } from "../feature.ts";
import { marks_setting, stored_marks } from "../privacy/screen.ts";
import { write_setting } from "../settings.ts";
import { forget_source_reading, list_kinds } from "./collector.ts";
import { migrations } from "./migrations/index.ts";
import { collector_of_source, item_sources_plugin_id, item_sources_setting, type ItemSourceRecord, type ItemSourceStatus, type ItemSourceSummary } from "./model.ts";
import { hide_tokens, keep_tokens, read_sources, write_sources } from "./records.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

export function source_mark_key(source_id: string): string {
  return `${item_sources_plugin_id}/${collector_of_source(source_id)}`;
}

function summary_of(source: ItemSourceRecord): ItemSourceSummary {
  return { id: source.id, name: source.name, address: source.address, has_token: source.token !== "", kinds: source.kinds, collector: collector_of_source(source.id), mark_key: source_mark_key(source.id) };
}

function source_of(database: SqlDatabase, id: string): ItemSourceRecord {
  const found = read_sources(database).find((source) => source.id === id);
  if (!found) throw new Error(`There is no app ${id} under Settings → Plugins.`);
  return found;
}

function list_item_sources(database: SqlDatabase): ItemSourceSummary[] {
  return read_sources(database).map(summary_of);
}

// Asks the app for its kinds now, saying in plain words why it cannot answer.
async function get_item_source_status(database: SqlDatabase, id: string): Promise<ItemSourceStatus> {
  const source = source_of(database, id);
  try {
    const kinds = await list_kinds(source);
    return { ok: true, message: `Answers, with ${kinds.length ? kinds.map((each) => each.label).join(", ") : "no kinds of item"}.`, kinds };
  } catch (error) {
    return { ok: false, message: (error as Error).message, kinds: [] };
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

// An id from the name, such as "x-tasks", that no other app has.
function new_source_id(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
  let id = base;
  for (let number = 2; taken.has(id); number++) id = `${base}-${number}`;
  return id;
}

function checked_name(name: string): string {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Give the app a name, such as X-Tasks.");
  return trimmed;
}

// Checks the app answers the item calls with this address and token, and gives back its kinds.
async function checked(source: Omit<ItemSourceRecord, "kinds">): Promise<ItemSourceRecord> {
  return { ...source, kinds: await list_kinds(source) };
}

async function add_item_source(database: SqlDatabase, name: string, address: string, token: string): Promise<string> {
  const sources = read_sources(database);
  const id = new_source_id(checked_name(name), new Set(sources.map((source) => source.id)));
  const source = await checked({ id, name: checked_name(name), address: checked_item_address(address), token: String(token ?? "").trim() });
  write_sources(database, [...read_sources(database), source]);
  return id;
}

// A null token keeps the one stored.
async function change_item_source(database: SqlDatabase, id: string, name: string, address: string, token: string | null): Promise<void> {
  const stored = source_of(database, id);
  const source = await checked({ id, name: checked_name(name), address: checked_item_address(address), token: token === null ? stored.token : String(token).trim() });
  write_sources(database, read_sources(database).map((each) => (each.id === id ? source : each)));
}

// Takes the app away with its marks, cursor and stamps; the items it brought stay in their contexts as last seen.
function remove_item_source(database: SqlDatabase, id: string): void {
  source_of(database, id);
  write_sources(database, read_sources(database).filter((source) => source.id !== id));
  const marks = stored_marks(database);
  const key = source_mark_key(id);
  if (key in marks) {
    delete marks[key];
    write_setting(database, marks_setting, marks);
  }
  forget_source_reading(database, id);
}

// ── Feature ──────────────────────────────────────────────────────────────────

const source_param = { name: "id", schema: id_of("app") };

export const sources_feature = define_feature({
  id: "sources",
  migrations: migrations.map((migration) => migration.statements),
  // The cursors are how far this device has read; the apps themselves are a synced setting.
  tables: [],
  methods: { list_item_sources, get_item_source_status, add_item_source, change_item_source, remove_item_source },
  api: {
    list_item_sources: {
      description:
        "Lists the apps CODEX reads through the standard item calls (list_item_kinds, search_items, get_items, list_item_changes, and get_item_texts for kinds with text), each with its name, address, whether a token is set (never the token), the kinds of item it answered with when saved and whether each has text, its collector's id and the key its marks are kept under.",
      params: [],
    },
    get_item_source_status: {
      description: "Asks one app for its kinds of item now, and says whether it answers or, in plain words, why not: unreachable, a refused token, or a missing item call.",
      params: [source_param],
    },
    add_item_source: {
      description:
        "Adds an app to read through the standard item calls, read-only, after checking it answers them with the token given, and gives back its id. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "name", schema: text("What to call the app, such as X-Tasks.") },
        { name: "address", schema: text("The app's server, such as https://tasks.example.org.") },
        { name: "token", schema: text("A read-only token made on the app's account page; empty for none.") },
      ],
    },
    change_item_source: {
      description: "Changes an app's name, address or token, after checking it answers. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        source_param,
        { name: "name", schema: text("What to call the app.") },
        { name: "address", schema: text("The app's server.") },
        { name: "token", schema: { type: ["string", "null"], description: "A new token, or null to keep the one set." } },
      ],
    },
    remove_item_source: {
      description: "Stops reading an app; the items it brought stay in their contexts as last seen. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [source_param],
      destructive: true,
    },
  },
  settings: { [item_sources_setting]: { default: [], user_only: true, hide: hide_tokens, keep: keep_tokens } },
});
