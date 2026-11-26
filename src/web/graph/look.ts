// How the graph's nodes and links are named and drawn: each kind's shape and colour role, each link type in words,
// and who made a link or entity in plain words.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { GraphKind, GraphLinkData, GraphNodeData, GraphTone } from "@x-tech-laboratories/x-libs/web/react/graph";

import { symmetric_link_types, type GraphLink, type GraphNode, type GraphView, type LinkType, type MadeBy } from "../../shared/graph/model.ts";
import { look_of } from "../contexts/kinds.tsx";

// ── Kinds ────────────────────────────────────────────────────────────────────

// Contexts take the accent; items and entities the chart series and statuses, entities drawn as hexagons besides.
const tones: Record<string, GraphTone> = {
  task: "series-5",
  note: "series-2",
  file: "series-3",
  folder: "series-3",
  email: "series-4",
  link: "series-6",
  conversation: "neutral",
  person: "success",
  organisation: "series-2",
  topic: "series-4",
  place: "series-5",
  other: "neutral",
};

const entity_names: Record<string, string> = { person: "Person", organisation: "Organisation", topic: "Topic", place: "Place", other: "Other entity" };

// What a node's kind is called, such as "Task", "Context" or "Person".
export function type_name(node: Pick<GraphNode, "kind" | "type">): string {
  if (node.kind === "context") return "Context";
  if (node.kind === "entity") return entity_names[node.type] ?? "Entity";
  return look_of(node.type).singular;
}

// The legend's kinds, one for each kind of node drawn: contexts, then items, then entities.
export function kinds_of(nodes: GraphNode[]): GraphKind[] {
  const seen = new Map<string, GraphKind>();
  for (const node of nodes) {
    const id = kind_id(node);
    if (seen.has(id)) continue;
    const shape = node.kind === "context" ? "square" : node.kind === "entity" ? "hexagon" : "circle";
    seen.set(id, { id, label: type_name(node), tone: node.kind === "context" ? "accent" : (tones[node.type] ?? "neutral"), shape });
  }
  const rank = (id: string) => (id === "context" ? 0 : id.startsWith("entity:") ? 2 : 1);
  return [...seen.values()].sort((first, second) => rank(first.id) - rank(second.id) || first.label.localeCompare(second.label));
}

function kind_id(node: GraphNode): string {
  return node.kind === "context" ? "context" : `${node.kind}:${node.type}`;
}

// ── Links ────────────────────────────────────────────────────────────────────

const type_words: Record<LinkType, string> = { mentions: "mentions", about: "about", related_to: "related to", part_of: "part of", depends_on: "depends on", same_as: "same as" };

export function type_text(type: LinkType): string {
  return type_words[type] ?? type;
}

const rule_words: Record<string, string> = { links_to: "a rule: its text holds the address", app_link: "a rule: its text holds a link to it", parent: "a rule: its app names its parent" };

// Who made a link or entity, in plain words.
export function maker_text(row: { made_by: MadeBy; rule: string; engine: string; model: string }): string {
  if (row.made_by === "user") return "you";
  if (row.made_by === "rule") return rule_words[row.rule] ?? `a rule (${row.rule})`;
  if (row.made_by === "similarity") return `similarity of meaning${row.model ? ` (${row.model})` : ""}`;
  if (row.made_by === "program") return "a program, through a token or MCP";
  return `${row.engine || "a program"}${row.model ? ` (${row.model})` : ""}`;
}

// A structure line's id, kept apart from any link's.
export function structure_id(from: string, to: string): string {
  return `structure:${from}>${to}`;
}

// The graph as the widget draws it: each node by its key, each link in the accent, dashed while proposed, and where
// contexts and items sit as grey lines.
export function drawn(view: GraphView): { nodes: GraphNodeData[]; links: GraphLinkData[]; kinds: GraphKind[] } {
  const nodes = view.nodes.map((node): GraphNodeData => ({ id: node.key, label: node.label, kind: kind_id(node), faded: node.status === "proposed", detail: [node.state, ...node.alt_names].filter(Boolean).join(", ") || undefined }));
  const links = [
    ...view.links.map((link: GraphLink): GraphLinkData => ({
      id: link.id,
      from: link.from,
      to: link.to,
      label: link.label || type_text(link.type),
      style: link.status === "accepted" ? "solid" : "dashed",
      tone: link.status === "rejected" ? "danger" : link.status === "proposed" ? "warning" : "accent",
      directed: !symmetric_link_types.has(link.type),
    })),
    ...view.structure.map((edge): GraphLinkData => ({ id: structure_id(edge.from, edge.to), from: edge.from, to: edge.to, label: "holds", tone: "neutral", directed: true })),
  ];
  return { nodes, links, kinds: kinds_of(view.nodes) };
}
