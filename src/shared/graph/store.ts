// The knowledge graph: entities found in the items, and typed links between contexts, items and entities, each with
// who made it, its evidence, when it was true and whether the user accepted it. What the user at the page makes is
// accepted at once, and so is what a rule makes on an exact key; what an engine, similarity or a program through a
// token or MCP makes is proposed, and only the user at the page accepts or rejects it. A rejected proposal is
// remembered and never made again.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { current_caller } from "../caller.ts";
import { assistant_host } from "../conversations/host.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { capped, listing_caps, shortened } from "../conversations/instructions.ts";
import type { ToolCallRecord } from "../conversations/model.ts";
import { start_run } from "../conversations/run.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { may_send, merge_withheld, open_screen, screen_sourced, withheld_line, type Screen, type Screened } from "../privacy/screen.ts";
import { add_proposal, list_proposals_of } from "../policy/proposals.ts";
import { parse_sources } from "../privacy/sources.ts";
import type { Proposal } from "../policy/model.ts";
import { migrations } from "./migrations/index.ts";
import { entity_kinds, graph_statuses, link_types, node_key, parse_node_key, type DecisionCount, type GraphLink, type GraphNode, type DecisionReport, type EntityKind, type EvidenceInput, type LinkChanges, type LinkType, type MadeBy } from "./model.ts";
import { default_graph_limit, get_graph, get_node_links, list_graph_proposals, list_link_counts, most_graph_nodes } from "./reading.ts";
import { canonical, entity_row, from_key, is_open, link_row, links_touching, name_key, now, parse_names, read_joins, read_nodes, resolve_node, to_key, type EntityRow, type LinkRow } from "./records.ts";
import { graph_decisions, graph_entities, graph_links, graph_tables } from "./schema.ts";
import { checked_moment, checked_type, clip_excerpt, insert_link, record_decision, remove_dangling_links, resolve_evidence, same_links, set_entity_status, set_link_status } from "./writing.ts";

// ── Checks ───────────────────────────────────────────────────────────────────

function checked_kind(kind: unknown): EntityKind {
  if (!(entity_kinds as readonly unknown[]).includes(kind)) throw new Error(`An entity is one of ${entity_kinds.join(", ")}.`);
  return kind as EntityKind;
}

function checked_name(name: unknown): string {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) throw new Error("Give the entity a name.");
  return trimmed;
}

function checked_names(names: unknown, name: string): string[] {
  const list = Array.isArray(names) ? names : [];
  const kept = new Map<string, string>();
  for (const each of list) {
    const trimmed = String(each ?? "").replace(/\s+/g, " ").trim();
    if (trimmed && name_key(trimmed) !== name_key(name)) kept.set(name_key(trimmed), trimmed);
  }
  return [...kept.values()];
}

// The two ends of a new link, which must both exist and differ, and for same_as both be entities.
function checked_ends(database: SqlDatabase, from: string, to: string, type: LinkType): { from: string; to: string } {
  const [first, second] = [resolve_node(database, from), resolve_node(database, to)];
  const joins = read_joins(database);
  if (canonical(joins, first) === canonical(joins, second)) throw new Error("A link joins two different nodes.");
  if (type === "same_as" && (!first.startsWith("entity:") || !second.startsWith("entity:"))) throw new Error("same_as joins two entities found to be one.");
  return { from: first, to: second };
}

// Entities at the ends of what the user accepts or links are the user's too.
function accept_end_entities(database: SqlDatabase, keys: string[]): void {
  for (const key of keys) {
    const parsed = parse_node_key(key);
    if (parsed?.kind !== "entity") continue;
    const row = entity_row(database, parsed.id);
    if (row.status === "proposed") {
      set_entity_status(database, row.id, "accepted");
      record_decision(database, "entity", row, "accepted");
    }
  }
}

// ── Links ────────────────────────────────────────────────────────────────────

// The user's own link, accepted at once; one waiting or once rejected between the same nodes is accepted instead. From a
// program it is only proposed, made by a program, and one already waiting or once rejected is left as it is.
function add_graph_link(database: SqlDatabase, from: string, to: string, type: LinkType, label = "", valid_from = ""): string {
  const checked = checked_type(type);
  const ends = checked_ends(database, from, to, checked);
  const at = now();
  const existing = same_links(database, ends.from, ends.to, checked).filter((row) => is_open(row, at));
  if (existing.some((row) => row.status === "accepted")) throw new Error("Those two are already linked that way.");
  if (current_caller() === "program") {
    const kept = existing.find((row) => row.status === "proposed") ?? existing.find((row) => row.status === "rejected");
    if (kept?.status === "rejected") throw new Error("The user rejected this link before, so it is not proposed again.");
    return kept?.id ?? insert_link(database, { ...ends, type: checked, label, status: "proposed", made_by: "program", valid_from: checked_moment(valid_from, "When it became true") });
  }
  const earlier = existing.find((row) => row.status === "proposed") ?? existing.find((row) => row.status === "rejected");
  accept_end_entities(database, [ends.from, ends.to]);
  if (earlier) {
    set_link_status(database, earlier.id, "accepted");
    record_decision(database, "link", earlier, "accepted");
    if (label.trim()) drizzle_of(database).update(graph_links).set({ label: label.trim() }).where(eq(graph_links.id, earlier.id)).run();
    return earlier.id;
  }
  return insert_link(database, { ...ends, type: checked, label, status: "accepted", made_by: "user", valid_from: checked_moment(valid_from, "When it became true") });
}

function change_graph_link(database: SqlDatabase, id: string, changes: LinkChanges): void {
  const row = link_row(database, id);
  const set: Partial<typeof graph_links.$inferInsert> = {};
  if (changes.type !== undefined) {
    set.type = checked_type(changes.type);
    if (set.type === "same_as" && (row.from_kind !== "entity" || row.to_kind !== "entity")) throw new Error("same_as joins two entities found to be one.");
  }
  if (changes.label !== undefined) set.label = String(changes.label).trim();
  if (changes.valid_from !== undefined) set.valid_from = checked_moment(changes.valid_from, "When it became true");
  if (changes.valid_until !== undefined) set.valid_until = checked_moment(changes.valid_until, "When it stopped being true");
  const from = set.valid_from ?? row.valid_from;
  const until = set.valid_until ?? row.valid_until;
  if (from && until && until < from) throw new Error("A link cannot stop being true before it became true.");
  if (Object.keys(set).length === 0) return;
  drizzle_of(database).update(graph_links).set(set).where(eq(graph_links.id, id)).run();
}

// A link that stopped being true is closed, so what was once true stays known.
function close_graph_link(database: SqlDatabase, id: string, until = ""): void {
  const row = link_row(database, id);
  if (!is_open(row)) throw new Error("That link is already closed.");
  const when = checked_moment(until, "When it stopped being true") || now();
  if (row.valid_from && when < row.valid_from) throw new Error("A link cannot stop being true before it became true.");
  drizzle_of(database).update(graph_links).set({ valid_until: when }).where(eq(graph_links.id, id)).run();
}

// The user's own link goes; one a rule, similarity or an engine made is kept as rejected, so it is never made again.
function remove_graph_link(database: SqlDatabase, id: string): void {
  const row = link_row(database, id);
  if (row.made_by === "user") {
    drizzle_of(database).delete(graph_links).where(eq(graph_links.id, id)).run();
    return;
  }
  if (row.status !== "rejected") {
    set_link_status(database, id, "rejected");
    record_decision(database, "link", row, "rejected");
  }
}

// ── Entities ─────────────────────────────────────────────────────────────────

// Entities of this kind with this name among their names, but those rejected.
function entities_named(database: SqlDatabase, kind: EntityKind, names: string[]): EntityRow[] {
  const keys = new Set(names.map(name_key));
  return drizzle_of(database)
    .select()
    .from(graph_entities)
    .where(eq(graph_entities.kind, kind))
    .all()
    .filter((row) => [row.name, ...parse_names(row.alt_names)].some((name) => keys.has(name_key(name))));
}

// The user's own entity, accepted at once; from a program it is only proposed, made by a program, and one of that name
// already waiting or once rejected is left as it is.
function add_entity(database: SqlDatabase, kind: EntityKind, name: string, alt_names: string[] = []): string {
  const checked = checked_kind(kind);
  const trimmed = checked_name(name);
  const known = entities_named(database, checked, [trimmed]);
  if (known.some((row) => row.status === "accepted")) throw new Error(`There is already a ${checked} named ${trimmed}; rename it, or join the two.`);
  const by_program = current_caller() === "program";
  if (by_program) {
    const kept = known.find((row) => row.status === "proposed") ?? known.find((row) => row.status === "rejected");
    if (kept?.status === "rejected") throw new Error(`The user rejected the ${checked} ${kept.name} before, so it is not proposed again.`);
    if (kept) return kept.id;
  }
  const id = new_id();
  drizzle_of(database)
    .insert(graph_entities)
    .values({ id, kind: checked, name: trimmed, alt_names: JSON.stringify(checked_names(alt_names, trimmed)), status: by_program ? "proposed" : "accepted", made_by: by_program ? "program" : "user", created_at: now() })
    .run();
  return id;
}

function rename_entity(database: SqlDatabase, id: string, name: string, alt_names: string[] | null = null, kind: EntityKind | null = null): void {
  const row = entity_row(database, id);
  const trimmed = checked_name(name);
  const names = alt_names === null ? parse_names(row.alt_names) : alt_names;
  drizzle_of(database)
    .update(graph_entities)
    .set({ name: trimmed, alt_names: JSON.stringify(checked_names(names, trimmed)), ...(kind === null ? {} : { kind: checked_kind(kind) }) })
    .where(eq(graph_entities.id, id))
    .run();
}

// Removes the entity and every link it has; the entities joined to it stay, each on its own.
function remove_entity(database: SqlDatabase, id: string): void {
  entity_row(database, id);
  const db = drizzle_of(database);
  for (const row of links_touching(database, [node_key("entity", id)])) db.delete(graph_links).where(eq(graph_links.id, row.id)).run();
  db.delete(graph_entities).where(eq(graph_entities.id, id)).run();
}

// Two entities found to be one, joined by a same_as link that remove_graph_link undoes; nothing is merged.
function join_entities(database: SqlDatabase, first: string, second: string): string {
  return add_graph_link(database, node_key("entity", entity_row(database, first).id), node_key("entity", entity_row(database, second).id), "same_as");
}

// ── Decisions ────────────────────────────────────────────────────────────────

function decide(database: SqlDatabase, ids: string[], decision: "accepted" | "rejected"): DecisionReport {
  const report: DecisionReport = { accepted: 0, rejected: 0, skipped: [] };
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (list.length === 0) throw new Error("Pick at least one proposal.");
  for (const id of list) {
    const link = drizzle_of(database).select().from(graph_links).where(eq(graph_links.id, id)).get();
    const entity = link ? undefined : drizzle_of(database).select().from(graph_entities).where(eq(graph_entities.id, id)).get();
    if (link?.status === "proposed") {
      set_link_status(database, id, decision);
      record_decision(database, "link", link, decision);
      if (decision === "accepted") accept_end_entities(database, [from_key(link), to_key(link)]);
    } else if (entity?.status === "proposed") {
      set_entity_status(database, id, decision);
      record_decision(database, "entity", entity, decision);
      // A rejected entity takes the links proposed to it along.
      if (decision === "rejected") {
        for (const row of links_touching(database, [node_key("entity", id)]).filter((each) => each.status === "proposed")) {
          set_link_status(database, row.id, "rejected");
          record_decision(database, "link", row, "rejected");
          report.rejected += 1;
        }
      }
    } else {
      report.skipped.push(id);
      continue;
    }
    report[decision] += 1;
  }
  return report;
}

function list_graph_decision_counts(database: SqlDatabase): DecisionCount[] {
  const counts = new Map<string, DecisionCount>();
  for (const row of drizzle_of(database).select().from(graph_decisions).all()) {
    const key = JSON.stringify([row.made_by, row.rule, row.engine, row.model]);
    const count = counts.get(key) ?? { made_by: row.made_by as MadeBy, rule: row.rule, engine: row.engine, model: row.model, accepted: 0, rejected: 0 };
    if (row.decision === "accepted") count.accepted += 1;
    else if (row.decision === "rejected") count.rejected += 1;
    counts.set(key, count);
  }
  return [...counts.values()].sort((first, second) => first.made_by.localeCompare(second.made_by) || first.engine.localeCompare(second.engine) || first.model.localeCompare(second.model) || first.rule.localeCompare(second.rule));
}

// ── Proposals by an engine ───────────────────────────────────────────────────

// Who proposes: the engine and model answering, and the sources its run had read, which the proposal carries.
export interface ProposalMaker {
  engine: string;
  model: string;
  sources: string[];
}

export interface ProposalOutcome {
  // "proposed", "exists" for one already there, or "refused" for one the user rejected before.
  outcome: "proposed" | "exists" | "refused";
  id: string;
  message: string;
}

// The evidence's reference and sources, with its excerpt only when every source it carries may reach a hosted engine,
// the mark under which the user lets that source's words leave this computer.
async function weighed_evidence(database: SqlDatabase, evidence: EvidenceInput | null | undefined): Promise<{ ref: string; excerpt: string; sources: string[] }> {
  const { ref, sources } = resolve_evidence(database, evidence);
  const excerpt = clip_excerpt(evidence?.excerpt);
  if (!ref || !excerpt) return { ref, excerpt: ref ? excerpt : "", sources };
  const screen = await open_screen(database, true);
  return { ref, excerpt: sources.every((source) => may_send(screen, source)) ? excerpt : "", sources };
}

function maker_of(maker: ProposalMaker | undefined): ProposalMaker {
  return { engine: String(maker?.engine ?? ""), model: String(maker?.model ?? ""), sources: Array.isArray(maker?.sources) ? maker.sources.map(String) : [] };
}

// An engine proposes with a maker; a program through a token or MCP proposes as a program.
function made_by_of(maker: ProposalMaker | undefined): MadeBy {
  return maker === undefined && current_caller() === "program" ? "program" : "engine";
}

async function propose_entity(database: SqlDatabase, kind: EntityKind, name: string, alt_names: string[] = [], evidence: EvidenceInput | null = null, maker?: ProposalMaker): Promise<ProposalOutcome> {
  // Read before the first wait, while the call's caller is still known.
  const made_by = made_by_of(maker);
  const checked = checked_kind(kind);
  const trimmed = checked_name(name);
  const names = checked_names(alt_names, trimmed);
  const known = entities_named(database, checked, [trimmed, ...names]);
  const kept = known.find((row) => row.status === "accepted") ?? known.find((row) => row.status === "proposed");
  if (kept) return { outcome: "exists", id: kept.id, message: `The ${checked} ${kept.name} is already known (${kept.status}); use its id ${kept.id}.` };
  const rejected = known.find((row) => row.status === "rejected");
  if (rejected) return { outcome: "refused", id: rejected.id, message: `The user rejected the ${checked} ${rejected.name} before, so it is not proposed again.` };
  const weighed = await weighed_evidence(database, evidence);
  const by = maker_of(maker);
  const id = new_id();
  drizzle_of(database)
    .insert(graph_entities)
    .values({
      id,
      kind: checked,
      name: trimmed,
      alt_names: JSON.stringify(names),
      status: "proposed",
      made_by,
      engine: by.engine,
      model: by.model,
      evidence_ref: weighed.ref,
      evidence_excerpt: weighed.excerpt,
      sources: JSON.stringify([...new Set([...by.sources, ...weighed.sources])].sort()),
      created_at: now(),
    })
    .run();
  return { outcome: "proposed", id, message: `Proposed the ${checked} ${trimmed} as entity ${id}; it waits for the user.` };
}

async function propose_link(database: SqlDatabase, from: string, to: string, type: LinkType, label = "", evidence: EvidenceInput | null = null, maker?: ProposalMaker): Promise<ProposalOutcome> {
  const made_by = made_by_of(maker);
  const checked = checked_type(type);
  const ends = checked_ends(database, from, to, checked);
  for (const key of [ends.from, ends.to]) {
    const parsed = parse_node_key(key)!;
    if (parsed.kind === "entity" && entity_row(database, parsed.id).status === "rejected") return { outcome: "refused", id: "", message: "The user rejected that entity, so nothing is linked to it." };
  }
  const earlier = same_links(database, ends.from, ends.to, checked);
  const rejected = earlier.find((row) => row.status === "rejected");
  if (rejected) return { outcome: "refused", id: rejected.id, message: "The user rejected this link before, so it is not proposed again." };
  const open = earlier.find((row) => is_open(row));
  if (open) return { outcome: "exists", id: open.id, message: `That link is already there (${open.status}).` };
  const weighed = await weighed_evidence(database, evidence);
  const by = maker_of(maker);
  const id = insert_link(database, {
    ...ends,
    type: checked,
    label,
    status: "proposed",
    made_by,
    engine: by.engine,
    model: by.model,
    evidence_ref: weighed.ref,
    evidence_excerpt: weighed.excerpt,
    sources: [...by.sources, ...weighed.sources],
  });
  return { outcome: "proposed", id, message: `Proposed the link as ${id}; it waits for the user.` };
}

// Who proposes a drop: an engine's maker, with the conversation the proposal is kept in and the run it came from.
export interface DropMaker extends ProposalMaker {
  conversation_id: string;
  run_id?: string;
}

// The waiting proposal to drop this link, or one the user rejected, whoever asked: closing it or rejecting it.
function drop_asked(database: SqlDatabase, id: string): Proposal | undefined {
  const of_link = list_proposals_of(database, null).filter(
    (proposal) => (proposal.method === "close_graph_link" && proposal.arguments.id === id) || (proposal.method === "reject_graph_proposals" && Array.isArray(proposal.arguments.ids) && proposal.arguments.ids.length === 1 && proposal.arguments.ids[0] === id),
  );
  return of_link.find((proposal) => proposal.status === "waiting") ?? of_link.find((proposal) => proposal.status === "rejected");
}

function link_words_of(database: SqlDatabase, row: LinkRow): { words: string; sources: string[] } {
  const ends = read_nodes(database, [from_key(row), to_key(row)]);
  const [from, to] = [ends.get(from_key(row)), ends.get(to_key(row))];
  const words = `${from?.label ?? from_key(row)} ${row.type.replace("_", " ")}${row.label ? ` (${row.label})` : ""} ${to?.label ?? to_key(row)}`;
  return { words, sources: [...(from?.sources ?? []), ...(to?.sources ?? [])] };
}

// An engine asks for a link to go, with why: an accepted link is proposed to be closed, kept as what was once so; one
// still proposed is proposed to be rejected, so it is never proposed again. Either waits for the user, whatever the
// level, in the run's conversation.
async function propose_link_drop(database: SqlDatabase, id: string, reason: string, evidence: EvidenceInput | null = null, maker?: DropMaker): Promise<ProposalOutcome> {
  const conversation_id = String(maker?.conversation_id ?? "");
  if (!conversation_id) throw new Error("A drop is proposed from a conversation with the assistant; a program closes or removes the link itself with close_graph_link or remove_graph_link.");
  const why = clip_excerpt(reason);
  if (!why) throw new Error("Say why the link should go.");
  const row = link_row(database, String(id ?? ""));
  if (row.status === "rejected") throw new Error("That link was already rejected, so there is nothing to drop.");
  if (!is_open(row)) throw new Error("That link is already closed.");
  const asked = drop_asked(database, row.id);
  if (asked?.status === "waiting") return { outcome: "exists", id: asked.id, message: `A proposal to drop that link already waits for the user: ${asked.id}.` };
  if (asked) return { outcome: "refused", id: asked.id, message: "The user said no to dropping that link before, so it is not proposed again." };
  const weighed = await weighed_evidence(database, evidence);
  const by = maker_of(maker);
  const { words, sources } = link_words_of(database, row);
  const quoted = weighed.excerpt ? ` From: “${weighed.excerpt}”` : "";
  const accepted = row.status === "accepted";
  const summary = accepted ? `Close the link “${words}”, keeping it as what was once so: ${why}${quoted}` : `Reject the proposed link “${words}”, so it is never proposed again: ${why}${quoted}`;
  const proposal = add_proposal(database, {
    conversation_id,
    method: accepted ? "close_graph_link" : "reject_graph_proposals",
    arguments: accepted ? { id: row.id } : { ids: [row.id] },
    summary,
    reason: "drop",
    sources: [...new Set([...by.sources, ...weighed.sources, ...sources, ...parse_sources(row.sources)])].sort(),
    evidence: { asked_by: "", run_id: String(maker?.run_id ?? ""), reads: [], seen: [...new Set(by.sources)].sort(), proposed_by: { engine: by.engine, model: by.model } },
  });
  return { outcome: "proposed", id: proposal.id, message: `Proposed dropping the link as proposal ${proposal.id}; it waits for the user.` };
}

// ── Suggesting ───────────────────────────────────────────────────────────────

export const suggest_links_message = [
  "Suggest links for this context.",
  "Its items, and the entities and links it already has, are listed in your instructions: propose from those.",
  "Use propose_entity for the people, organisations, topics and places the items mention, and propose_link to join items, contexts and entities (mentions, about, related_to, part_of, depends_on, or same_as for two entities that are one), each with the item it came from as evidence and a short excerpt.",
  "Read an item with get_item only when its title and snippet are not enough, and at most three items in all. Do not propose what is already listed as linked.",
  "If a link listed is wrong or no longer true, you may propose dropping it with propose_link_drop, giving its id and why; list_graph_proposals shows what already waits.",
  "Everything you propose waits for me to accept or reject it; tell me briefly what you proposed.",
].join(" ");

// The only tools a Suggest links run is offered: the three proposals, two reads for detail and what already waits.
export const suggest_tools = ["propose_entity", "propose_link", "propose_link_drop", "get_item", "search_index", "list_graph_proposals"] as const;

// Fewer rounds than a conversation, so a small model proposes rather than reads; the last has no tools.
export const suggest_rounds = 6;

// The context's entities and links as the engine may be sent them, capped like the instructions' other listings.
export function graph_part(database: SqlDatabase, context_id: string, screen: Screen): Screened<string> {
  const view = get_graph(database, context_id);
  const by_key = new Map(view.nodes.map((node) => [node.key, node]));
  const entities = view.nodes.filter((node) => node.kind === "entity");
  const entity_text = (node: GraphNode) => `- "${shortened(node.label)}" (${node.type}, id ${node.key}, ${node.status})`;
  // Every link drawn has both its ends among the nodes drawn.
  const link_text = (link: GraphLink) => `- "${shortened(by_key.get(link.from)!.label)}" (${link.from}) ${link.type} "${shortened(by_key.get(link.to)!.label)}" (${link.to}), ${link.status}`;
  const link_sources = (link: GraphLink) => [...new Set([...link.sources, ...by_key.get(link.from)!.sources, ...by_key.get(link.to)!.sources])];
  const shown_entities = screen_sourced(screen, entities, (node) => node.sources, (node) => node.key, () => "entity");
  const shown_links = screen_sourced(screen, view.links, link_sources, (link) => link.id, () => "link");
  const listed_entities = capped(shown_entities.value, entity_text, listing_caps.entities);
  const listed_links = capped(shown_links.value, link_text, listing_caps.links);
  const listing = (heading: string, none: string, lines: string[], total: number) => {
    if (total === 0) return none;
    const more = total - lines.length;
    return `${heading}\n${untrusted_block(lines.join("\n"))}${more > 0 ? `\n${more} more are not listed here.` : ""}`;
  };
  const merged = merge_withheld([shown_entities, shown_links]);
  const withheld = withheld_line(screen, merged.withheld, merged.withheld_kinds);
  const lines = [
    "For Suggest links, the context's graph so far:",
    listing("Entities it already has:", "It has no entities yet.", listed_entities.map(entity_text), shown_entities.value.length),
    listing("Links it already has (do not propose these again):", "It has no links yet.", listed_links.map(link_text), shown_links.value.length),
    withheld,
  ].filter(Boolean);
  return { value: lines.join("\n"), sources: new Set([...shown_entities.sources, ...shown_links.sources]), withheld: merged.withheld, withheld_kinds: merged.withheld_kinds };
}

// A plain note of how many entities and links a run proposed.
export function proposals_note(calls: ToolCallRecord[]): string {
  const made = (name: string) =>
    calls.filter((call) => {
      if (call.name !== name || call.is_error) return false;
      try {
        return (JSON.parse(call.result) as { outcome?: unknown }).outcome === "proposed";
      } catch {
        return false;
      }
    }).length;
  const entities = made("propose_entity");
  const links = made("propose_link");
  const drops = made("propose_link_drop");
  const count = (total: number, one: string, many: string) => `${total} ${total === 1 ? one : many}`;
  if (entities + links + drops === 0) return "Suggest links proposed nothing this time.";
  const dropped = drops > 0 ? ` It also asks to drop ${count(drops, "link", "links")}, in the conversation.` : "";
  return `Suggest links proposed ${count(entities, "entity", "entities")} and ${count(links, "link", "links")}; they wait for you under Proposed links.${dropped}`;
}

// Starts a conversation in the context, named Suggest links, with the context's items, entities and links in its
// instructions, only the tools the task needs, and fewer rounds than a conversation.
async function suggest_links(database: SqlDatabase, context_id: string): Promise<{ conversation_id: string; run_id: string }> {
  const host = assistant_host();
  const started = await start_run(database, context_id, suggest_links_message, null, {
    tools: suggest_tools,
    limits: { max_rounds: suggest_rounds },
    instructions: (screen) => graph_part(database, context_id, screen),
    closing_note: proposals_note,
  });
  await host.call("rename_conversation", [started.conversation_id, "Suggest links"]);
  return started;
}

// ── Feature ──────────────────────────────────────────────────────────────────

const node_schema = text('A node: a context, item or entity, as a key such as "context:<id>", "item:<item id>" or "entity:<id>", or by its id alone.');
const type_schema = { type: "string", enum: [...link_types], description: "mentions, about, related_to, part_of, depends_on, or same_as for two entities found to be one." } as const;
const kind_schema = { type: "string", enum: [...entity_kinds], description: "person, organisation, topic, place or other." } as const;
const names_schema = { type: "array", items: { type: "string" }, description: "Other names it goes by." } as const;
const ids_schema = { type: "array", items: { type: "string" }, minItems: 1, description: "The ids of proposed links or entities, from list_graph_proposals." } as const;
const moment_schema = (what: string) => ({ type: "string", description: `${what}, as a date or ISO 8601 moment; empty for none.` });
const evidence_schema = {
  type: ["object", "null"],
  properties: {
    item_id: text("The item it came from, by its id."),
    message_id: text("Or the conversation message it came from, by its id."),
    excerpt: text("A short excerpt showing it, at most a few sentences; kept only when the source's marks allow."),
  },
  description: "Where it came from.",
} as const;
const filter_schema = {
  type: "object",
  properties: {
    node_types: { type: "array", items: { type: "string" }, description: 'Only nodes of these kinds ("context", "item", "entity") or types (such as "task" or "person").' },
    link_types: { type: "array", items: type_schema, description: "Only links of these types." },
    statuses: { type: "array", items: { type: "string", enum: [...graph_statuses] }, description: "Only links of these statuses; accepted and proposed unless given." },
    include_closed: { type: "boolean", description: "Links that stopped being true too." },
    limit: { type: "integer", minimum: 1, maximum: most_graph_nodes, description: `The most nodes given; ${default_graph_limit} unless given.` },
  },
  description: "What to show.",
} as const;

export const graph_feature = define_feature({
  id: "graph",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(graph_tables),
  methods: {
    get_graph,
    get_node_links,
    list_graph_proposals,
    list_link_counts,
    list_graph_decision_counts,
    add_graph_link,
    change_graph_link,
    close_graph_link,
    remove_graph_link,
    add_entity,
    rename_entity,
    remove_entity,
    join_entities,
    accept_graph_proposals: (database: SqlDatabase, ids: string[]): DecisionReport => decide(database, ids, "accepted"),
    reject_graph_proposals: (database: SqlDatabase, ids: string[]): DecisionReport => decide(database, ids, "rejected"),
    propose_entity,
    propose_link,
    propose_link_drop,
    suggest_links,
  },
  api: {
    get_graph: {
      description:
        "Gets the knowledge graph for drawing: a context with every context inside it, the items they hold and the entities linked to them, or for Global the whole graph; each node with its kind, label and link count, the links among them, where contexts and items sit, and how many nodes and links were not shown.",
      params: [
        { name: "context_id", schema: { type: ["string", "null"], description: "A context's id; Global, null or left out for the whole graph." }, optional: true },
        { name: "filter", schema: filter_schema, optional: true },
      ],
    },
    get_node_links: {
      description:
        "Gets what one node (a context, an item such as a conversation, or an entity) is linked to: every link of any status, open or closed, each with its type, label, who made it, its evidence, when it was true and the node at its other end. Entities joined as one read as one.",
      params: [{ name: "node", schema: node_schema }],
    },
    list_graph_proposals: {
      description:
        "Lists the links and entities proposed and waiting for the user, links then entities, each oldest first, with who proposed it and its evidence, in one context and those inside it or everywhere; a page at a time when limit or after is given, with how many are left after it.",
      params: [
        { name: "context_id", schema: { type: ["string", "null"], description: "A context's id; Global, null or left out for everywhere." }, optional: true },
        { name: "limit", schema: { type: ["integer", "null"], minimum: 1, description: "The most proposals given, links and entities together; every one when left out." }, optional: true },
        { name: "after", schema: { type: ["string", "null"], description: "The id of the last proposal already seen; the page starts after it. From the start when left out." }, optional: true },
      ],
    },
    list_link_counts: {
      description: "Lists how many open links, accepted or proposed, a context and each item it holds has, by node key.",
      params: [{ name: "context_id", schema: id_of("context") }],
    },
    list_graph_decision_counts: {
      description: "Lists how many proposals the user accepted and rejected, by who made them: the rule, or the engine and model.",
      params: [],
    },
    add_graph_link: {
      description:
        "Links two nodes, giving back the link's id. From CODEX's own page it is the user's, accepted at once, and a link proposed or once rejected between them of that type is accepted instead; from a token or an MCP client it is proposed, made by a program, for the user to accept or reject, and one the user rejected before is refused.",
      params: [
        { name: "from", schema: node_schema },
        { name: "to", schema: node_schema },
        { name: "type", schema: type_schema },
        { name: "label", schema: text("A free label, such as 'invoice for'; may be empty."), optional: true },
        { name: "valid_from", schema: moment_schema("When it became true"), optional: true },
      ],
    },
    change_graph_link: {
      description: "Changes a link's type, label, or when it was true.",
      params: [
        { name: "id", schema: id_of("link") },
        {
          name: "changes",
          schema: {
            type: "object",
            properties: { type: type_schema, label: text("The new label."), valid_from: moment_schema("When it became true"), valid_until: moment_schema("When it stopped being true") },
            description: "Only what changes.",
          },
        },
      ],
    },
    close_graph_link: {
      description: "Closes a link that stopped being true, keeping it as what was once so.",
      params: [
        { name: "id", schema: id_of("link") },
        { name: "until", schema: moment_schema("When it stopped being true; now unless given"), optional: true },
      ],
    },
    remove_graph_link: {
      description: "Removes a link. One the user made goes; one a rule, similarity or an engine made is kept as rejected, so it is never made or proposed again. Removing a same_as link undoes a join.",
      params: [{ name: "id", schema: id_of("link") }],
      destructive: true,
    },
    add_entity: {
      description:
        "Adds an entity and gives back its id. From CODEX's own page it is the user's, accepted at once; from a token or an MCP client it is proposed, made by a program, for the user to accept or reject, and one of that name the user rejected before is refused.",
      params: [
        { name: "kind", schema: kind_schema },
        { name: "name", schema: text("Its name.") },
        { name: "alt_names", schema: names_schema, optional: true },
      ],
    },
    rename_entity: {
      description: "Renames an entity, and sets its other names or its kind when given.",
      params: [
        { name: "id", schema: id_of("entity") },
        { name: "name", schema: text("The new name.") },
        { name: "alt_names", schema: { ...names_schema, type: ["array", "null"] }, optional: true },
        { name: "kind", schema: { ...kind_schema, type: ["string", "null"] }, optional: true },
      ],
    },
    remove_entity: {
      description: "Removes an entity and every link it has; entities joined to it stay, each on its own.",
      params: [{ name: "id", schema: id_of("entity") }],
      destructive: true,
    },
    join_entities: {
      description: "Joins two entities found to be one with a same_as link, so reads treat them as one; nothing is merged, and removing that link undoes it. Gives back the link's id.",
      params: [
        { name: "first", schema: id_of("entity") },
        { name: "second", schema: id_of("entity") },
      ],
    },
    accept_graph_proposals: {
      description: "Accepts proposed links and entities; a link's proposed entities are accepted with it. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "ids", schema: ids_schema }],
    },
    reject_graph_proposals: {
      description:
        "Rejects proposed links and entities, which are remembered so the same is never proposed again; a rejected entity takes the links proposed to it along. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "ids", schema: ids_schema }],
    },
    propose_entity: {
      description:
        "Proposes an entity found in the items: a person, organisation, topic, place or other, with its name and other names and where it was found. It waits for the user; one already known is given back instead, and one the user rejected is not proposed again.",
      params: [
        { name: "kind", schema: kind_schema },
        { name: "name", schema: text("Its name.") },
        { name: "alt_names", schema: names_schema, optional: true },
        { name: "evidence", schema: evidence_schema, optional: true },
      ],
    },
    propose_link: {
      description: "Proposes a typed link between two nodes, with where it was found. It waits for the user; a link already there is given back instead, and one the user rejected is not proposed again.",
      params: [
        { name: "from", schema: node_schema },
        { name: "to", schema: node_schema },
        { name: "type", schema: type_schema },
        { name: "label", schema: text("A free label; may be empty."), optional: true },
        { name: "evidence", schema: evidence_schema, optional: true },
      ],
    },
    propose_link_drop: {
      description:
        "Proposes that a link go, by its id with why: an accepted link would be closed, kept as what was once so; one still proposed would be rejected, so it is never proposed again. It waits for the user's approval in the conversation, whatever the action policy; one already waiting is given back instead. A closed, rejected or unknown link is refused.",
      params: [
        { name: "id", schema: id_of("link") },
        { name: "reason", schema: text("Why the link is wrong or no longer true, in a sentence or two.") },
        { name: "evidence", schema: evidence_schema, optional: true },
      ],
    },
    suggest_links: {
      description: "Starts a conversation in a context asking the assistant to propose entities and links from its items and the entities and links it already has, and to propose dropping wrong ones, offering it only the proposal tools and three reads for a few rounds; answers at once with the conversation's id and the run's id.",
      params: [{ name: "context_id", schema: id_of("context") }],
    },
  },
  // A removed context, entity or conversation takes its links along.
  after_write: (database) => void remove_dangling_links(database),
});

