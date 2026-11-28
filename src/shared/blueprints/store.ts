// Blueprints: workflows the user taught, each with when it applies and its rules and ordered steps, kept as items of
// kind "blueprint" in the contexts they apply in, Global when they apply everywhere. What the user writes is
// active at once; what an engine or a program writes is only proposed, and only the user at CODEX's page makes it
// active, after reading it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { current_caller } from "../caller.ts";
import { when_items_left } from "../contexts/records.ts";
import { assistant_host } from "../conversations/host.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import { prompts } from "../prompts/prompts.ts";
import { migrations } from "./migrations/index.ts";
import { blueprint_of_item, blueprint_statuses, type Blueprint, type BlueprintDecisions, type BlueprintOutcome, type BlueprintProposal, type BlueprintStatus, type BlueprintSummary, type BlueprintText } from "./model.ts";
import {
  as_change,
  blueprint_ids_applying,
  blueprint_ids_in,
  blueprint_of,
  blueprint_row,
  checked_text,
  delete_blueprint_records,
  has_blueprint,
  insert_blueprint,
  now,
  place_blueprint_record,
  rows_of,
  summaries_of,
  update_blueprint,
} from "./records.ts";
import { blueprint_changes, blueprint_tables, blueprints } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

// Every blueprint when no context is given; for null those that apply everywhere; for a context those that apply there.
function list_blueprints(database: SqlDatabase, context_id?: string | null, status?: BlueprintStatus): BlueprintSummary[] {
  if (status !== undefined && !blueprint_statuses.includes(status)) throw new Error(`A blueprint's status is one of ${blueprint_statuses.join(", ")}.`);
  const ids = context_id === undefined ? null : context_id === null || context_id === "" ? blueprint_ids_in(database, null) : blueprint_ids_applying(database, context_id);
  return summaries_of(database, rows_of(database, ids, status));
}

function get_blueprint(database: SqlDatabase, id: string): Blueprint {
  return blueprint_of(database, id);
}

// What waits for the user: proposed blueprints and proposed changes, newest first, in one conversation or everywhere.
function list_blueprint_proposals(database: SqlDatabase, conversation_id: string | null = null): BlueprintProposal[] {
  const db = drizzle_of(database);
  const fresh = rows_of(database, null, "proposed")
    .filter((row) => !conversation_id || row.conversation_id === conversation_id)
    .map((row): BlueprintProposal => ({ id: row.id, kind: "new", blueprint_id: row.id, title: row.title, applies_when: row.applies_when, body: row.body, before: null, reason: "", made_by: row.made_by as BlueprintProposal["made_by"], engine: row.engine, model: row.model, sources: parse_sources(row.sources), conversation_id: row.conversation_id, created_at: row.created_at }));
  const waiting = db.select().from(blueprint_changes).where(and(eq(blueprint_changes.status, "waiting"), conversation_id ? eq(blueprint_changes.conversation_id, conversation_id) : undefined)).all().map(as_change);
  const befores = new Map(rows_of(database, [...new Set(waiting.map((change) => change.blueprint_id))]).map((row) => [row.id, row]));
  const changes = waiting.flatMap((change): BlueprintProposal[] => {
    const before = befores.get(change.blueprint_id);
    if (!before) return [];
    return [{ id: change.id, kind: "change", blueprint_id: change.blueprint_id, title: change.title, applies_when: change.applies_when, body: change.body, before: { title: before.title, applies_when: before.applies_when, body: before.body }, reason: change.reason, made_by: change.made_by, engine: change.engine, model: change.model, sources: change.sources, conversation_id: change.conversation_id, created_at: change.created_at }];
  });
  return [...fresh, ...changes].sort((first, second) => second.created_at.localeCompare(first.created_at) || first.id.localeCompare(second.id));
}

// ── The user's own ───────────────────────────────────────────────────────────

function context_checked(database: SqlDatabase, context_id: string | null): string | null {
  if (!context_id) return null;
  blueprint_ids_applying(database, context_id);
  return context_id;
}

// The user's blueprint is active at once; one from a program is only proposed, made by a program.
function add_blueprint(database: SqlDatabase, title: string, applies_when: string, body: string, context_id: string | null = null): string {
  const by_program = current_caller() === "program";
  const values = checked_text({ title, applies_when, body });
  return insert_blueprint(database, { ...values, status: by_program ? "proposed" : "active", made_by: by_program ? "program" : "user" }, context_checked(database, context_id));
}

function proposed_change(database: SqlDatabase, id: string, values: { title: string; applies_when: string; body: string }, made: { made_by: "engine" | "program"; engine?: string; model?: string; sources?: string[]; conversation_id?: string; reason: string }): string {
  const change_id = new_id();
  drizzle_of(database)
    .insert(blueprint_changes)
    .values({ id: change_id, blueprint_id: id, ...values, reason: made.reason, status: "waiting", made_by: made.made_by, engine: made.engine ?? "", model: made.model ?? "", sources: JSON.stringify([...new Set(made.sources ?? [])].sort()), conversation_id: made.conversation_id ?? "", created_at: now() })
    .run();
  // The blueprint's item counts what waits.
  update_blueprint(database, id, {});
  return change_id;
}

// The user's edit holds at once and makes the blueprint theirs, so a proposed one becomes active; a program's edit is
// only proposed as a change. Gives back the change's id for a program, or the blueprint's.
function change_blueprint(database: SqlDatabase, id: string, text_given: BlueprintText): string {
  const by_program = current_caller() === "program";
  const row = blueprint_row(database, id);
  const values = checked_text({ title: text_given.title ?? row.title, applies_when: text_given.applies_when ?? row.applies_when, body: text_given.body ?? row.body });
  if (by_program) return proposed_change(database, id, values, { made_by: "program", reason: "" });
  update_blueprint(database, id, { ...values, status: row.status === "proposed" ? "active" : row.status, sources: "[]" });
  return id;
}

function retire_blueprint(database: SqlDatabase, id: string): void {
  const row = blueprint_row(database, id);
  if (row.status === "proposed") throw new Error("That blueprint is only proposed; reject it instead.");
  update_blueprint(database, id, { status: "retired" });
}

function restore_blueprint(database: SqlDatabase, id: string): void {
  const row = blueprint_row(database, id);
  if (row.status !== "retired") throw new Error("Only a retired blueprint is brought back.");
  update_blueprint(database, id, { status: "active" });
}

function place_blueprint(database: SqlDatabase, id: string, context_id: string | null): void {
  place_blueprint_record(database, id, context_checked(database, context_id));
}

function remove_blueprint(database: SqlDatabase, id: string): void {
  blueprint_row(database, id);
  delete_blueprint_records(database, id);
}

// ── Deciding ─────────────────────────────────────────────────────────────────

// Accepting makes a proposed blueprint active, or puts a change's text in place; either way it becomes the user's own,
// carrying no source. Rejecting deletes a proposed blueprint, which History keeps, or sets a change aside.
function decide(database: SqlDatabase, ids: string[], decision: "accept" | "reject"): BlueprintDecisions {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Give the ids of proposed blueprints or changes, from list_blueprint_proposals.");
  const report: BlueprintDecisions = { decided: [], skipped: [] };
  const db = drizzle_of(database);
  for (const id of new Set(ids.map(String))) {
    const change = db.select().from(blueprint_changes).where(eq(blueprint_changes.id, id)).get();
    if (change) {
      if (change.status !== "waiting") {
        report.skipped.push({ id, reason: `That change was already ${change.status}.` });
        continue;
      }
      if (!has_blueprint(database, change.blueprint_id)) {
        report.skipped.push({ id, reason: "Its blueprint was deleted." });
        continue;
      }
      if (decision === "accept") update_blueprint(database, change.blueprint_id, { title: change.title, applies_when: change.applies_when, body: change.body, sources: "[]" });
      db.update(blueprint_changes).set({ status: decision === "accept" ? "accepted" : "rejected", decided_at: now() }).where(eq(blueprint_changes.id, id)).run();
      update_blueprint(database, change.blueprint_id, {});
      report.decided.push(id);
      continue;
    }
    const row = db.select().from(blueprints).where(eq(blueprints.id, id)).get();
    if (!row || row.status !== "proposed") {
      report.skipped.push({ id, reason: row ? "That blueprint is not waiting for you." : `There is no proposed blueprint or change ${id}.` });
      continue;
    }
    if (decision === "accept") update_blueprint(database, id, { status: "active", sources: "[]" });
    else delete_blueprint_records(database, id);
    report.decided.push(id);
  }
  return report;
}

// ── Proposing ────────────────────────────────────────────────────────────────

// Who proposes: an engine passes itself, with the sources its run read and its conversation; a program proposes bare.
export interface BlueprintMakerInput {
  engine?: string;
  model?: string;
  sources?: string[];
  conversation_id?: string;
}

function maker_of(maker: BlueprintMakerInput | undefined): { made_by: "engine" | "program"; engine: string; model: string; sources: string[]; conversation_id: string } {
  return {
    made_by: maker === undefined && current_caller() === "program" ? "program" : "engine",
    engine: String(maker?.engine ?? ""),
    model: String(maker?.model ?? ""),
    sources: Array.isArray(maker?.sources) ? maker.sources.map(String) : [],
    conversation_id: String(maker?.conversation_id ?? ""),
  };
}

function propose_blueprint(database: SqlDatabase, title: string, applies_when: string, body: string, context_id: string | null = null, maker?: BlueprintMakerInput): BlueprintOutcome {
  const by = maker_of(maker);
  const values = checked_text({ title, applies_when, body });
  const id = insert_blueprint(database, { ...values, status: "proposed", ...by }, context_checked(database, context_id));
  return { outcome: "proposed", id, message: `Proposed the blueprint “${values.title}” as ${id}; it waits for the user to read and accept it.` };
}

function propose_blueprint_change(database: SqlDatabase, id: string, body: string, reason: string, title?: string, applies_when?: string, maker?: BlueprintMakerInput): BlueprintOutcome {
  const by = maker_of(maker);
  const row = blueprint_row(database, id);
  if (row.status === "proposed") return { outcome: "refused", id, message: "That blueprint still waits for the user; it cannot be changed before they decide it." };
  const values = checked_text({ title: title || row.title, applies_when: applies_when || row.applies_when, body });
  if (values.title === row.title && values.applies_when === row.applies_when && values.body === row.body) return { outcome: "refused", id, message: "That is the blueprint as it already reads; nothing would change." };
  const change_id = proposed_change(database, id, values, { ...by, reason: String(reason ?? "").trim() });
  return { outcome: "proposed", id: change_id, message: `Proposed a change to the blueprint “${row.title}” as ${change_id}; it waits for the user to read and accept it.` };
}

// ── Saving from a conversation ───────────────────────────────────────────────

export const save_as_blueprint_message = prompts.blueprints.save_request.join(" ");

// Asks the engine, in the conversation given, to propose a blueprint from what was done there.
async function save_as_blueprint(_database: SqlDatabase, conversation_id: string): Promise<{ conversation_id: string; run_id: string }> {
  const host = assistant_host();
  const found = (await host.call("get_conversation", [conversation_id])) as { contexts: { id: string }[] };
  return (await host.call("send_message", [found.contexts[0]?.id ?? null, save_as_blueprint_message, conversation_id])) as { conversation_id: string; run_id: string };
}

// ── Contexts going ───────────────────────────────────────────────────────────

// Blueprints no other context holds go with a removed context rather than come to apply everywhere.
when_items_left((database, item_ids) => {
  for (const id of item_ids.map(blueprint_of_item).filter((each): each is string => each !== null)) if (has_blueprint(database, id)) delete_blueprint_records(database, id);
});

// ── Feature ──────────────────────────────────────────────────────────────────

const blueprint_param = { name: "id", schema: id_of("blueprint") };
const title_schema = text("A short title, such as “Sort the mail”.");
const applies_schema = text("When it applies: one sentence naming the task, which recall matches the user's message against.");
const body_schema = text("The rules and the steps in order, in Markdown, naming the tool a step uses where that helps.");
const where_schema = { type: ["string", "null"], description: "The context it applies in, and in those inside it, from list_contexts; null for Global, so it applies everywhere." };
const ids_schema = { type: "array", items: { type: "string" }, minItems: 1, description: "Ids of proposed blueprints or proposed changes, from list_blueprint_proposals." } as const;

export const blueprints_feature = define_feature({
  id: "blueprints",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(blueprint_tables),
  methods: {
    list_blueprints,
    get_blueprint,
    list_blueprint_proposals,
    add_blueprint,
    change_blueprint,
    retire_blueprint,
    restore_blueprint,
    place_blueprint,
    remove_blueprint,
    accept_blueprint_proposals: (database: SqlDatabase, ids: string[]): BlueprintDecisions => decide(database, ids, "accept"),
    reject_blueprint_proposals: (database: SqlDatabase, ids: string[]): BlueprintDecisions => decide(database, ids, "reject"),
    propose_blueprint,
    propose_blueprint_change,
    save_as_blueprint,
  },
  api: {
    list_blueprints: {
      description:
        "Lists blueprints, workflows the user taught (each with a title, when it applies, its status, where it applies, and how often it was used): every one when no context is given, those that apply everywhere for null, or those that apply in a context (its own, those of the contexts above it, and those that apply everywhere).",
      params: [
        { name: "context_id", schema: { type: ["string", "null"], description: "A context's id, from list_contexts; null or Global for those that apply everywhere; left out for all." }, optional: true },
        { name: "status", schema: { type: "string", enum: blueprint_statuses, description: "Only those proposed, active or retired." }, optional: true },
      ],
    },
    get_blueprint: {
      description: "Gets one blueprint whole: its title, when it applies, its rules and steps in Markdown, its status, who wrote it, where it applies, how often it was used, and the changes proposed to it.",
      params: [blueprint_param],
    },
    list_blueprint_proposals: {
      description: "Lists the blueprints and the changes to blueprints that wait for the user to accept or reject, newest first, each with its whole text and, for a change, the blueprint as it reads now.",
      params: [{ name: "conversation_id", schema: { type: ["string", "null"], description: "Only those proposed in this conversation; null or left out for all." }, optional: true }],
    },
    add_blueprint: {
      description: "Writes a new blueprint. The user's own is active at once; one added through a token or MCP is only proposed, for the user to accept.",
      params: [{ name: "title", schema: title_schema }, { name: "applies_when", schema: applies_schema }, { name: "body", schema: body_schema }, { name: "context_id", schema: where_schema, optional: true }],
    },
    change_blueprint: {
      description: "Changes a blueprint's title, when it applies or its body; a field left out stays. The user's change holds at once and makes a proposed blueprint active; one made through a token or MCP is only proposed as a change.",
      params: [
        blueprint_param,
        {
          name: "text",
          schema: { type: "object", properties: { title: title_schema, applies_when: applies_schema, body: body_schema }, description: "The fields to change." },
        },
      ],
    },
    retire_blueprint: {
      description: "Retires a blueprint: it is kept, but never recalled again until the user brings it back.",
      params: [blueprint_param],
    },
    restore_blueprint: {
      page_only: true,
      description: "Brings a retired blueprint back, so it is recalled again. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [blueprint_param],
    },
    place_blueprint: {
      page_only: true,
      description: "Sets where a blueprint applies: in one context and those inside it, or everywhere for null. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [blueprint_param, { name: "context_id", schema: where_schema }],
    },
    remove_blueprint: {
      description: "Deletes a blueprint with the changes proposed to it; History keeps its versions, so it can be brought back.",
      params: [blueprint_param],
      destructive: true,
    },
    accept_blueprint_proposals: {
      page_only: true,
      description: "Accepts proposed blueprints, which become active, and proposed changes, whose text replaces the blueprint's; either way the text becomes the user's own. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "ids", schema: ids_schema }],
    },
    reject_blueprint_proposals: {
      page_only: true,
      description: "Rejects proposed blueprints, which are deleted, and proposed changes, which are set aside. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "ids", schema: ids_schema }],
    },
    propose_blueprint: {
      description:
        "Proposes a blueprint: a workflow the user taught you, so the same task is done the same way next time. It waits for the user to read and accept it; nothing is followed until then.",
      params: [{ name: "title", schema: title_schema }, { name: "applies_when", schema: applies_schema }, { name: "body", schema: body_schema }, { name: "context_id", schema: where_schema, optional: true }],
    },
    propose_blueprint_change: {
      description: "Proposes a new version of a blueprint, with the whole new body and why; it waits for the user to read and accept it.",
      params: [
        blueprint_param,
        { name: "body", schema: body_schema },
        { name: "reason", schema: text("Why it should change, in a sentence.") },
        { name: "title", schema: { ...title_schema, description: "A new title; left out keeps it." }, optional: true },
        { name: "applies_when", schema: { ...applies_schema, description: "When it applies, newly said; left out keeps it." }, optional: true },
      ],
    },
    save_as_blueprint: {
      description: "Asks the assistant, in the conversation given, to write up what was done there as a proposed blueprint; answers at once with the conversation's id and the run's id.",
      params: [{ name: "conversation_id", schema: id_of("conversation") }],
    },
  },
});
