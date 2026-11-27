// The Inbox: everything across CODEX that waits on the user, newest first: the changes conversations and jobs proposed,
// with their evidence, and those background maintenance proposed; the graph's proposed links and entities; proposed
// blueprints and changes to them; the interests the assistant proposed; the background runs that ended in an error or
// at a limit; and the daily digest of background work. It only reads; deciding stays with each feature's page-only calls.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, desc, eq, inArray, ne } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { blueprint_route } from "../blueprints/model.ts";
import { blueprints_feature } from "../blueprints/store.ts";
import { conversation_route } from "../conversations/model.ts";
import { summaries_of } from "../conversations/records.ts";
import { define_feature, drizzle_of } from "../feature.ts";
import { list_graph_proposals } from "../graph/reading.ts";
import { list_interest_rows } from "../interests/records.ts";
import { as_run } from "../jobs/records.ts";
import { maintenance_conversation_id, maintenance_prefix } from "../jobs/model.ts";
import { job_runs, jobs } from "../jobs/schema.ts";
import { list_proposals_of } from "../policy/proposals.ts";
import type { InboxEntry } from "./model.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

function maker(row: { made_by: string; engine: string; model: string; rule?: string }): string {
  if (row.made_by === "engine") return ["the assistant", [row.engine, row.model].filter(Boolean).join(" · ")].filter(Boolean).join(", ");
  if (row.made_by === "program") return "a program";
  if (row.made_by === "similarity") return "similarity of meaning";
  if (row.made_by === "rule") return `the rule ${row.rule ?? ""}`.trim();
  return "you";
}

// Every entry waiting on the user, newest first.
function list_inbox(database: SqlDatabase): InboxEntry[] {
  const db = drizzle_of(database);
  const job_conversations = new Map(db.select({ conversation_id: jobs.conversation_id, title: jobs.title }).from(jobs).where(ne(jobs.conversation_id, "")).all().map((row) => [row.conversation_id, row.title]));
  const entries: InboxEntry[] = [];
  const conversation_ids = new Set<string>();

  for (const proposal of list_proposals_of(database, null, "waiting")) {
    conversation_ids.add(proposal.conversation_id);
    // One in background maintenance's own conversation was proposed by it, about the graph.
    const by_maintenance = proposal.conversation_id === maintenance_conversation_id;
    entries.push({ key: `change:${proposal.id}`, kind: "change", id: proposal.id, title: proposal.summary, detail: proposal.reason === "outside content" ? "Proposed after reading text from other apps." : "Its level asks for your approval.", made_by: by_maintenance ? "background maintenance" : "the assistant", created_at: proposal.created_at, conversation_id: proposal.conversation_id, conversation_title: "", job_title: job_conversations.get(proposal.conversation_id) ?? "", route: conversation_route(proposal.conversation_id), proposal });
  }

  const graph = list_graph_proposals(database);
  for (const link of graph.links) {
    const words = `${link.from_node.label} ${link.type.replace("_", " ")}${link.label ? ` (${link.label})` : ""} ${link.to_node.label}`;
    entries.push({ key: `link:${link.id}`, kind: "link", id: link.id, title: `Link: ${words}`, detail: link.evidence.excerpt ? `“${link.evidence.excerpt}”` : "", made_by: maker(link), created_at: link.recorded_at, conversation_id: "", conversation_title: "", job_title: "", route: `#/graph/${encodeURIComponent(link.from)}`, link });
  }
  for (const entity of graph.entities) {
    entries.push({ key: `entity:${entity.id}`, kind: "entity", id: entity.id, title: `New ${entity.kind}: ${entity.name}`, detail: entity.evidence.excerpt ? `“${entity.evidence.excerpt}”` : "", made_by: maker(entity), created_at: entity.created_at, conversation_id: "", conversation_title: "", job_title: "", route: `#/graph/${encodeURIComponent(`entity:${entity.id}`)}`, entity });
  }

  for (const blueprint of blueprints_feature.methods.list_blueprint_proposals(database, null)) {
    if (blueprint.conversation_id) conversation_ids.add(blueprint.conversation_id);
    const kind = blueprint.kind === "new" ? "blueprint" : "blueprint_change";
    const title = blueprint.kind === "new" ? `Blueprint: ${blueprint.title}` : `Change to the blueprint “${blueprint.before?.title ?? blueprint.title}”`;
    entries.push({ key: `${kind}:${blueprint.id}`, kind, id: blueprint.id, title, detail: blueprint.kind === "new" ? blueprint.applies_when : blueprint.reason, made_by: maker(blueprint), created_at: blueprint.created_at, conversation_id: blueprint.conversation_id, conversation_title: "", job_title: job_conversations.get(blueprint.conversation_id) ?? "", route: blueprint_route(blueprint.blueprint_id), blueprint });
  }

  // A proposed interest waits for the user to read the exact topic; it is accepted only in its dialog, never here.
  for (const interest of list_interest_rows(database)) {
    if (interest.state !== "proposed") continue;
    if (interest.conversation_id) conversation_ids.add(interest.conversation_id);
    const by = interest.made_by === "engine" ? maker({ made_by: "engine", engine: interest.engine, model: interest.model }) : interest.made_by === "program" ? "a program" : "you";
    entries.push({ key: `interest:${interest.id}`, kind: "interest", id: interest.id, title: `Interest: ${interest.topic}`, detail: interest.reason, made_by: by, created_at: interest.created_at, conversation_id: interest.conversation_id, conversation_title: "", job_title: "", route: "#/settings", interest });
  }

  const failed = db.select().from(job_runs).where(and(inArray(job_runs.outcome, ["error", "limit"]), eq(job_runs.dismissed_at, ""))).orderBy(desc(job_runs.started_at)).all().map(as_run);
  for (const run of failed) {
    if (run.conversation_id) conversation_ids.add(run.conversation_id);
    const maintenance = run.job_id.startsWith(maintenance_prefix);
    const route = maintenance ? "#/settings" : `#/jobs/${encodeURIComponent(run.job_id)}`;
    entries.push({ key: `job_run:${run.id}`, kind: "job_run", id: run.id, title: `${run.outcome === "limit" ? "Stopped at a limit" : "Failed"}: ${run.title}`, detail: run.note, made_by: maintenance ? "background maintenance" : `the job ${run.title}`, created_at: run.ended_at || run.started_at, conversation_id: run.conversation_id, conversation_title: "", job_title: run.title, route, run });
  }

  const digests = db.select().from(job_runs).where(and(eq(job_runs.job_id, `${maintenance_prefix}digest`), eq(job_runs.outcome, "done"), eq(job_runs.dismissed_at, ""))).orderBy(desc(job_runs.started_at)).all().map(as_run);
  for (const run of digests) {
    if (run.applied.length === 0) continue;
    const day = (run.ended_at || run.started_at).slice(0, 10);
    entries.push({ key: `digest:${run.id}`, kind: "digest", id: run.id, title: `Background work, ${day}`, detail: run.applied.join(" "), made_by: "background maintenance", created_at: run.ended_at || run.started_at, conversation_id: "", conversation_title: "", job_title: "", route: "#/settings", run });
  }

  const titles = new Map(summaries_of(database, [...conversation_ids]).map((summary) => [summary.id, summary.title]));
  for (const entry of entries) entry.conversation_title = titles.get(entry.conversation_id) ?? "";
  return entries.sort((first, second) => second.created_at.localeCompare(first.created_at) || first.key.localeCompare(second.key));
}

function get_inbox_count(database: SqlDatabase): number {
  return list_inbox(database).length;
}

// ── Feature ──────────────────────────────────────────────────────────────────

export const inbox_feature = define_feature({
  id: "inbox",
  migrations: [],
  tables: [],
  methods: { list_inbox, get_inbox_count },
  api: {
    list_inbox: {
      description:
        "Lists everything that waits for the user, newest first: changes the assistant proposed in conversations and background jobs, with their evidence; proposed links and entities of the graph; proposed blueprints and changes to them; interests the assistant proposed to research, each accepted only after reading its exact topic; background runs that ended in an error or at a limit; and the daily digest of what background maintenance did. Each names what it is, who made it and where it opens.",
      params: [],
    },
    get_inbox_count: { description: "Counts what waits for the user in the Inbox.", params: [] },
  },
});
