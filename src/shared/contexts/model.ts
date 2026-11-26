// The shapes the contexts store hands the page and other programs. The page imports only these types.

// ── Contexts ─────────────────────────────────────────────────────────────────

export interface ContextSummary {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  is_archived: boolean;
  item_count: number;
}

export interface ContextDetail extends ContextSummary {
  notes: string;
  created_at: string;
  items: ContextItem[];
  feeds: FollowedFeed[];
  view: ContextView;
  card_places: CardPlace[];
  // The group in another app its children were made from, such as an X-Tasks filter group; null for none.
  seeded_from: SeededFrom | null;
}

export interface SeededFrom {
  collector: string;
  group_id: string;
  label: string;
}

// A list grouped by kind, a card per item, a card per kind holding its items, or the graph of the context.
export type ContextView = "list" | "cards" | "grouped" | "graph";

// Where an item's card sits in the context's grid, in cells: column, row, width and height.
export interface CardPlace {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// A feed a context follows.
export interface FollowedFeed {
  collector: string;
  feed_id: string;
  label: string;
  added_at: string;
}

// ── Items ────────────────────────────────────────────────────────────────────

export interface Item {
  id: string;
  collector: string;
  source_id: string;
  kind: string;
  title: string;
  snippet: string;
  uri: string;
  status: string;
  detail: Record<string, string>;
  seen_at: string;
  created_at: string;
}

// An item as one context holds it, with the note on why it is there.
export interface ContextItem extends Item {
  note: string;
  added_at: string;
  // The other contexts that hold it too, by id and name.
  also_in: { id: string; name: string }[];
  // The feed that brought it here, by its label; empty for one added by hand.
  via_label: string;
}

// An item found anywhere in the app, with every context that holds it.
export interface KeptItem extends Item {
  contexts: { id: string; name: string }[];
}

// What a refresh did.
export interface RefreshReport {
  checked: number;
  updated: number;
  missing: number;
  // Items followed feeds brought in and took out.
  joined: number;
  left: number;
  // One line per collector that could not answer, such as "Trilium: Set the Trilium server's address".
  problems: string[];
}
