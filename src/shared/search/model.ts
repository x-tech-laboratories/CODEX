// The shapes the search index hands the page and other programs. The page imports only these types.

// ── Search ───────────────────────────────────────────────────────────────────

export type HitKind = "item" | "context" | "message";

// A context something sits in, by id and name.
export interface HitPlace {
  id: string;
  name: string;
}

export interface SearchHit {
  kind: HitKind;
  // The item's, context's or message's id.
  id: string;
  // The item's title, the context's name, or who wrote the message.
  title: string;
  // A short piece of the text around what matched.
  excerpt: string;
  // For an item: its collector, its kind such as "task", and where it opens; for a message, where its conversation opens.
  collector: string;
  item_kind: string;
  uri: string;
  // Where it is: the contexts holding an item, the context a context sits in, or the contexts holding the conversation
  // a message is in (none for a top-level context or a conversation in no context).
  where: HitPlace[];
  // The conversation a message is in, by id and title, which its uri opens; null for anything else.
  conversation: { id: string; title: string } | null;
  // The sources whose content it carries, by collector id: an item's collector, or what an answer's run had read ("*"
  // when not recorded); none for what the user wrote.
  sources: string[];
  // How it was found: by its words, by its meaning, or both.
  matched_by: ("words" | "meaning")[];
  score: number;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface IndexedEmbedder {
  id: string;
  label: string;
  model: string;
  dimensions: number;
  is_local: boolean;
}

export interface IndexState {
  // What is indexed, by kind.
  items: number;
  contexts: number;
  messages: number;
  // Pieces of text cut for embedding, how many hold a vector from the embedder in use, how many wait for one, and how
  // many are never sent to it because it is hosted and their source is not marked for hosted engines.
  chunks: number;
  embedded: number;
  pending: number;
  withheld: number;
  // The embedder in use, or null when search is full text only.
  embedder: IndexedEmbedder | null;
  // The setting names an embedder that is not running.
  embedder_problem: string;
  // Every embedder running, to choose from.
  embedders: { id: string; label: string }[];
  // Whether it is indexing or embedding now.
  is_working: boolean;
  last_indexed_at: string;
  last_error: string;
}
