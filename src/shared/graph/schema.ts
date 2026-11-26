// The knowledge graph's tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A person, organisation, topic, place or other thing found in the items, which the graph links like any other node.
export const graph_entities = sqliteTable(
  "graph_entities",
  {
    id: text().primaryKey(),
    // "person", "organisation", "topic", "place" or "other".
    kind: text().notNull(),
    name: text().notNull(),
    // Other names it goes by, as a JSON list of text.
    alt_names: text().notNull().default("[]"),
    // "proposed", "accepted" or "rejected".
    status: text().notNull(),
    // Who made it: "user", "rule", "similarity" or "engine"; with the rule's name, or the engine and model.
    made_by: text().notNull(),
    rule: text().notNull().default(""),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    // The item or message it was found in, as a node key such as "item:<id>" or "message:<id>", and a short excerpt
    // kept only when that source's marks allow; both empty when none was given.
    evidence_ref: text().notNull().default(""),
    evidence_excerpt: text().notNull().default(""),
    // The sources whose content it carries, as a JSON list of collector ids, so hosted engines are screened from it.
    sources: text().notNull().default("[]"),
    created_at: text().notNull(),
    // When the user accepted or rejected it; empty for one made accepted or still waiting.
    decided_at: text().notNull().default(""),
  },
  (table) => [index("graph_entities_by_status").on(table.status)],
);

// A typed link between two nodes: contexts, items (conversations among them) and entities.
export const graph_links = sqliteTable(
  "graph_links",
  {
    id: text().primaryKey(),
    // Each end as its kind ("context", "item" or "entity") and its id there.
    from_kind: text().notNull(),
    from_id: text().notNull(),
    to_kind: text().notNull(),
    to_id: text().notNull(),
    // "mentions", "about", "related_to", "part_of", "depends_on" or "same_as", with an optional free label.
    type: text().notNull(),
    label: text().notNull().default(""),
    status: text().notNull(),
    made_by: text().notNull(),
    rule: text().notNull().default(""),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    evidence_ref: text().notNull().default(""),
    evidence_excerpt: text().notNull().default(""),
    // When it was true, as ISO timestamps; empty from for always, empty until for still true. A link that stops being
    // true is closed by setting until, never deleted.
    valid_from: text().notNull().default(""),
    valid_until: text().notNull().default(""),
    recorded_at: text().notNull(),
    decided_at: text().notNull().default(""),
    sources: text().notNull().default("[]"),
  },
  (table) => [index("graph_links_by_from").on(table.from_kind, table.from_id), index("graph_links_by_to").on(table.to_kind, table.to_id), index("graph_links_by_status").on(table.status)],
);

// Each accept or reject the user made of a proposal, by who made it, kept even when the link or entity goes: the
// learning signal for later work.
export const graph_decisions = sqliteTable("graph_decisions", {
  id: text().primaryKey(),
  // "link" or "entity", and its id.
  target: text().notNull(),
  target_id: text().notNull(),
  made_by: text().notNull(),
  rule: text().notNull().default(""),
  engine: text().notNull().default(""),
  model: text().notNull().default(""),
  // "accepted" or "rejected".
  decision: text().notNull(),
  decided_at: text().notNull(),
});

export const graph_tables = [graph_entities, graph_links, graph_decisions];
