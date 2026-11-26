// The knowledge graph: entities found in the items, and typed links between contexts, items and entities, each with
// who made it, its evidence, when it was true and whether the user accepted it. What the user makes is accepted at
// once, and so is what a rule makes on an exact key; what an engine or similarity makes is proposed, and only the user
// at the page accepts or rejects it. A rejected proposal is remembered and never made again.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { assistant_host } from "../conversations/host.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { may_send, open_screen } from "../privacy/screen.ts";
import { when_indexed } from "../search/indexer.ts";
import { migrations } from "./migrations/index.ts";
import { entity_kinds, graph_statuses, link_types, node_key, parse_node_key, type DecisionCount, type DecisionReport, type EntityKind, type EvidenceInput, type LinkChanges, type LinkType, type MadeBy } from "./model.ts";
import { default_graph_limit, get_graph, get_node_links, list_graph_proposals, list_link_counts, most_graph_nodes } from "./reading.ts";
import { canonical, entity_row, from_key, is_open, link_row, links_touching, name_key, now, parse_names, read_joins, resolve_node, to_key, type EntityRow } from "./records.ts";
import { run_rules } from "./rules.ts";
import { graph_decisions, graph_entities, graph_links, graph_tables } from "./schema.ts";
import { propose_similar } from "./similarity.ts";
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

// The user's own link, accepted at once; one waiting or once rejected between the same nodes is accepted instead.
function add_graph_link(database: SqlDatabase, from: string, to: string, type: LinkType, label = "", valid_from = ""): string {
  const checked = checked_type(type);
  const ends = checked_ends(database, from, to, checked);
  const at = now();
  const existing = same_links(database, ends.from, ends.to, checked).filter((row) => is_open(row, at));
  if (existing.some((row) => row.status === "accepted")) throw new Error("Those two are already linked that way.");
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

function add_entity(database: SqlDatabase, kind: EntityKind, name: string, alt_names: string[] = []): string {
  const checked = checked_kind(kind);
  const trimmed = checked_name(name);
  if (entities_named(database, checked, [trimmed]).some((row) => row.status === "accepted")) throw new Error(`There is already a ${checked} named ${trimmed}; rename it, or join the two.`);
  const id = new_id();
  drizzle_of(database)
    .insert(graph_entities)
    .values({ id, kind: checked, name: trimmed, alt_names: JSON.stringify(checked_names(alt_names, trimmed)), status: "accepted", made_by: "user", created_at: now() })
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

async function propose_entity(database: SqlDatabase, kind: EntityKind, name: string, alt_names: string[] = [], evidence: EvidenceInput | null = null, maker?: ProposalMaker): Promise<ProposalOutcome> {
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
      made_by: "engine",
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
    made_by: "engine",
    engine: by.engine,
    model: by.model,
    evidence_ref: weighed.ref,
    evidence_excerpt: weighed.excerpt,
    sources: [...by.sources, ...weighed.sources],
  });
  return { outcome: "proposed", id, message: `Proposed the link as ${id}; it waits for the user.` };
}

// ── Suggesting ───────────────────────────────────────────────────────────────

export const suggest_links_message = [
  "Suggest links for this context.",
  "Read its items with get_context, get_item and search_index, and look at what each is already linked to with get_node_links.",
  "Then use propose_entity for the people, organisations, topics and places they mention, and propose_link to join items, contexts and entities (mentions, about, related_to, part_of, depends_on, or same_as for two entities that are one), each with the item it came from as evidence and a short excerpt.",
  "Everything you propose waits for me to accept or reject it; tell me briefly what you proposed.",
].join(" ");

// Starts an ordinary conversation in the context, named Suggest links, asking the engine to read its items and propose
// entities and links.
async function suggest_links(_database: SqlDatabase, context_id: string): Promise<{ conversation_id: string; run_id: string }> {
  const host = assistant_host();
  const started = (await host.call("send_message", [context_id, suggest_links_message, null])) as { conversation_id: string; run_id: string };
  await host.call("rename_conversation", [started.conversation_id, "Suggest links"]);
  return started;
}

// ── After indexing ───────────────────────────────────────────────────────────

// The rules and similarity run after each index pass, for what it changed.
when_indexed((database, index, pass) => {
  const by_rules = run_rules(database, index, pass);
  const by_similarity = propose_similar(database, index, pass);
  return by_rules || by_similarity;
});

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
    suggest_links,
  },
  api: {
    get_graph: {
      description:
        "Gets the knowledge graph for drawing: a context with every context inside it, the items they hold and the entities linked to them, or with no context the whole graph; each node with its kind, label and link count, the links among them, where contexts and items sit, and how many nodes and links were not shown.",
      params: [
        { name: "context_id", schema: { type: ["string", "null"], description: "A context's id; null or left out for the whole graph." }, optional: true },
        { name: "filter", schema: filter_schema, optional: true },
      ],
    },
    get_node_links: {
      description:
        "Gets what one node (a context, an item such as a conversation, or an entity) is linked to: every link of any status, open or closed, each with its type, label, who made it, its evidence, when it was true and the node at its other end. Entities joined as one read as one.",
      params: [{ name: "node", schema: node_schema }],
    },
    list_graph_proposals: {
      description: "Lists the links and entities proposed and waiting for the user, oldest first, each with who proposed it and its evidence, in one context and those inside it or everywhere.",
      params: [{ name: "context_id", schema: { type: ["string", "null"], description: "A context's id; null or left out for everywhere." }, optional: true }],
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
      description: "Links two nodes as the user, accepted at once; a link proposed or once rejected between them of that type is accepted instead. Gives back the link's id.",
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
      description: "Adds an entity as the user, accepted at once, and gives back its id.",
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
    suggest_links: {
      description: "Starts a conversation in a context asking the assistant to read its items and propose entities and links; answers at once with the conversation's id and the run's id.",
      params: [{ name: "context_id", schema: id_of("context") }],
    },
  },
  // A removed context, entity or conversation takes its links along.
  after_write: (database) => void remove_dangling_links(database),
});

