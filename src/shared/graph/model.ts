// The shapes the knowledge graph hands the page and other programs. The page imports only these types and constants.

// ── Kinds ────────────────────────────────────────────────────────────────────

export const entity_kinds = ["person", "organisation", "topic", "place", "other"] as const;
export type EntityKind = (typeof entity_kinds)[number];

export const link_types = ["mentions", "about", "related_to", "part_of", "depends_on", "same_as"] as const;
export type LinkType = (typeof link_types)[number];

// Links that read the same either way round.
export const symmetric_link_types: ReadonlySet<LinkType> = new Set(["related_to", "same_as"]);

export const graph_statuses = ["proposed", "accepted", "rejected"] as const;
export type GraphStatus = (typeof graph_statuses)[number];

// Who made a link or entity: the user, a rule on an exact key, the nearness of two items' meaning, or an engine.
export type MadeBy = "user" | "rule" | "similarity" | "engine";

export type NodeKind = "context" | "item" | "entity";

// A node named by its kind and id, such as "context:<id>", "item:x-tasks:t1" or "entity:<id>".
export function node_key(kind: NodeKind, id: string): string {
  return `${kind}:${id}`;
}

// The kind and id a node key names, or null for text that is not one.
export function parse_node_key(key: string): { kind: NodeKind; id: string } | null {
  const match = /^(context|item|entity):(.+)$/.exec(key);
  return match ? { kind: match[1] as NodeKind, id: match[2]! } : null;
}

// ── Nodes ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  key: string;
  kind: NodeKind;
  id: string;
  // What it is within its kind: an item's kind such as "task" or "conversation", an entity's kind such as "person",
  // or "context".
  type: string;
  label: string;
  // An entity's other names, those of the entities joined to it included.
  alt_names: string[];
  // An entity's status; a context or item is always accepted.
  status: GraphStatus;
  // Where an item opens; empty for anything else.
  uri: string;
  // An item's state from its app, such as "done" or "missing".
  state: string;
  // The sources whose content it carries: an item's collector, an entity's sources; none for a context.
  sources: string[];
  // The entities joined to this one by an accepted same_as link, each with the link that joins it, so it can be undone.
  joined: { id: string; name: string; link_id: string }[];
  // How many links it has that are shown, of any status asked for.
  link_count: number;
}

// ── Links ────────────────────────────────────────────────────────────────────

export interface GraphEvidence {
  // The item or message it came from, as "item:<id>" or "message:<id>"; empty for none.
  ref: string;
  // A short excerpt, kept only when the source's marks allow it.
  excerpt: string;
  // What the reference is called, such as the item's title; empty when it no longer exists.
  label: string;
}

export interface GraphLink {
  id: string;
  // The node keys of its two ends, joined entities read as the one they are joined to.
  from: string;
  to: string;
  type: LinkType;
  label: string;
  status: GraphStatus;
  made_by: MadeBy;
  rule: string;
  engine: string;
  model: string;
  evidence: GraphEvidence;
  valid_from: string;
  valid_until: string;
  recorded_at: string;
  decided_at: string;
  sources: string[];
}

// What a graph read shows: its nodes and the links among them, with how many more there are than were shown.
export interface GraphView {
  nodes: GraphNode[];
  links: GraphLink[];
  // Where contexts and items sit: each context to the contexts inside it and the items it holds, by node key; not links.
  structure: { from: string; to: string }[];
  hidden_nodes: number;
  hidden_links: number;
}

export interface GraphFilter {
  // Only nodes whose kind ("context", "item", "entity") or type ("task", "person") is one of these; all when empty.
  node_types?: string[];
  // Only links of these types; all when empty.
  link_types?: LinkType[];
  // Only links of these statuses; accepted and proposed unless given.
  statuses?: GraphStatus[];
  // Links that stopped being true too.
  include_closed?: boolean;
  // The most nodes shown; 300 unless given, at most 5000.
  limit?: number;
}

// One link as seen from a node: the other end and which way it points.
export interface NodeLink extends GraphLink {
  direction: "out" | "in" | "both";
  other: GraphNode;
}

export interface NodeLinks {
  node: GraphNode;
  links: NodeLink[];
}

// What change_graph_link changes: only what is given.
export interface LinkChanges {
  type?: LinkType;
  label?: string;
  valid_from?: string;
  valid_until?: string;
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface GraphEntity {
  id: string;
  kind: EntityKind;
  name: string;
  alt_names: string[];
  status: GraphStatus;
  made_by: MadeBy;
  rule: string;
  engine: string;
  model: string;
  evidence: GraphEvidence;
  sources: string[];
  created_at: string;
  decided_at: string;
}

export interface ProposedLink extends GraphLink {
  from_node: GraphNode;
  to_node: GraphNode;
}

export interface GraphProposals {
  links: ProposedLink[];
  entities: GraphEntity[];
}

// How the user decided the proposals of one maker, the signal later work learns from.
export interface DecisionCount {
  made_by: MadeBy;
  rule: string;
  engine: string;
  model: string;
  accepted: number;
  rejected: number;
}

// What deciding several proposals did.
export interface DecisionReport {
  accepted: number;
  rejected: number;
  // Ids that were not waiting, or not found.
  skipped: string[];
}

// ── Evidence given ───────────────────────────────────────────────────────────

// Where a proposal came from, as an engine or a program gives it.
export interface EvidenceInput {
  item_id?: string;
  message_id?: string;
  excerpt?: string;
}
