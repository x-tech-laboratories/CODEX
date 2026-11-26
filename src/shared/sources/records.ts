// The apps read through the item calls as the synced setting keeps them, with their tokens hidden from everything that
// reads settings and kept when a hidden one comes back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { hidden_secret } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { settings_feature } from "../settings.ts";
import { item_sources_setting, type ItemSourceRecord, type SourceKind } from "./model.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

const text_of = (value: unknown) => (typeof value === "string" ? value : "");

function kinds_of(value: unknown): SourceKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter((each) => typeof each?.kind === "string").map((each) => ({ kind: String(each.kind), label: text_of(each.label) || String(each.kind) }));
}

// The list as stored, anything malformed left out.
export function source_records(value: unknown): ItemSourceRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((each) => each && typeof each === "object" && typeof each.id === "string" && each.id !== "")
    .map((each) => ({ id: each.id, name: text_of(each.name) || each.id, address: text_of(each.address), token: text_of(each.token), kinds: kinds_of(each.kinds) }));
}

export function read_sources(database: SqlDatabase): ItemSourceRecord[] {
  return source_records(settings_feature.methods.get_settings(database)[item_sources_setting]);
}

export function write_sources(database: SqlDatabase, sources: ItemSourceRecord[]): void {
  settings_feature.methods.set_setting(database, item_sources_setting, sources);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

// The list with every token that is set replaced by the hidden mark, for the page and other programs to read.
export function hide_tokens(value: unknown): unknown {
  return Array.isArray(value) ? value.map((each) => (each && typeof each === "object" && typeof each.token === "string" && each.token !== "" ? { ...each, token: hidden_secret } : each)) : value;
}

// A list sent back with hidden tokens keeps the tokens stored for the same apps.
export function keep_tokens(stored: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const tokens = new Map(source_records(stored).map((source) => [source.id, source.token]));
  return incoming.map((each) => (each && typeof each === "object" && each.token === hidden_secret ? { ...each, token: tokens.get(each.id) ?? "" } : each));
}
