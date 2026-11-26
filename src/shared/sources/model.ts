// The shapes of the apps read through the standard item calls, as the store keeps them and the page sees them. The
// page imports only these types and names.

// ── Sources ──────────────────────────────────────────────────────────────────

// The setting holding every app read through the item calls, as a list, synced like the plugins' settings.
export const item_sources_setting = "item_sources";

// The bundled plugin whose collectors read them, one collector per app.
export const item_sources_plugin_id = "codex.items";

export interface SourceKind {
  kind: string;
  label: string;
}

// One app as it is kept: its token is never shown to the page, the API or MCP.
export interface ItemSourceRecord {
  // Made once from its first name, such as "x-tasks"; it never changes, since kept items carry it.
  id: string;
  name: string;
  address: string;
  token: string;
  // What list_item_kinds answered when it was last saved.
  kinds: SourceKind[];
}

// One app as the page sees it.
export interface ItemSourceSummary {
  id: string;
  name: string;
  address: string;
  has_token: boolean;
  kinds: SourceKind[];
  // The collector reading it, such as "app.x-tasks", whose items' ids start with it.
  collector: string;
  // Where its marks are kept in the source_marks setting.
  mark_key: string;
}

// Whether the app answers now, in plain words.
export interface ItemSourceStatus {
  ok: boolean;
  message: string;
  kinds: SourceKind[];
}

// The collector that reads one app.
export function collector_of_source(source_id: string): string {
  return `app.${source_id}`;
}
