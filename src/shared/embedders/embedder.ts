// What an embedder is: a plugin that turns text into vectors for the local search index. The index keeps each vector
// with the embedder and model that made it, so changing either embeds everything again.

// ── Embedder ─────────────────────────────────────────────────────────────────

export interface Embedder {
  label: string;
  // The model it embeds with now, from its plugin's settings, such as "nomic-embed-text".
  model(): string;
  // How many numbers each vector holds, which every vector it gives back must have.
  dimensions(): number;
  // True when its model runs on this machine or the user's own network; left out, it is hosted, and is never given
  // text from a source not marked for hosted engines.
  is_local?(): boolean;
  // One vector per text, in the same order.
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  // The vector of a search, for a model that wants an instruction before a query and none before what it searches;
  // left out, a search is embedded like any text.
  embed_query?(query: string, signal?: AbortSignal): Promise<number[]>;
}

// The setting naming the embedder the index uses, by the id its plugin provides it under; empty for none.
export const embedder_setting = "embedder";
