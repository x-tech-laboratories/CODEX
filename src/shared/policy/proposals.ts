// Reading and writing the changes that wait for the user, for the conversations' runs and the policy's own calls.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, desc, eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of, new_id } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import { no_evidence, type Proposal, type ProposalEvidence, type ProposalRead, type ProposalReason, type ProposalStatus } from "./model.ts";
import { proposals } from "./schema.ts";

// ── Proposals ────────────────────────────────────────────────────────────────

function parsed_object(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parsed_evidence(text: string): ProposalEvidence {
  const value = parsed_object(text);
  const reads = Array.isArray(value.reads) ? (value.reads as ProposalRead[]) : [];
  return { asked_by: String(value.asked_by ?? ""), run_id: String(value.run_id ?? ""), reads };
}

function as_proposal(row: typeof proposals.$inferSelect): Proposal {
  return { ...row, arguments: parsed_object(row.arguments), reason: row.reason as ProposalReason, status: row.status as ProposalStatus, sources: parse_sources(row.sources), evidence: parsed_evidence(row.evidence) };
}

export function add_proposal(
  database: SqlDatabase,
  values: { conversation_id: string; method: string; arguments: Record<string, unknown>; summary: string; reason: ProposalReason; sources: string[]; evidence?: ProposalEvidence },
): Proposal {
  // After every proposal before it, even one made in the same millisecond, so they list in the order they were made.
  const last = drizzle_of(database).select({ created_at: proposals.created_at }).from(proposals).orderBy(desc(proposals.created_at)).limit(1).get();
  let created_at = new Date().toISOString();
  if (last && created_at <= last.created_at) created_at = new Date(Date.parse(last.created_at) + 1).toISOString();
  const row = { id: new_id(), ...values, arguments: JSON.stringify(values.arguments), sources: JSON.stringify(values.sources), evidence: JSON.stringify(values.evidence ?? no_evidence), status: "waiting", result: "", created_at, resolved_at: "" };
  drizzle_of(database).insert(proposals).values(row).run();
  return as_proposal(row);
}

export function proposal_of(database: SqlDatabase, id: string): Proposal {
  const row = drizzle_of(database).select().from(proposals).where(eq(proposals.id, id)).get();
  if (!row) throw new Error(`There is no proposal ${id}.`);
  return as_proposal(row);
}

// A conversation's proposals, or every conversation's for null; only those in the status given, when one is.
export function list_proposals_of(database: SqlDatabase, conversation_id: string | null, status?: ProposalStatus): Proposal[] {
  const where = and(conversation_id === null ? undefined : eq(proposals.conversation_id, conversation_id), status ? eq(proposals.status, status) : undefined);
  return drizzle_of(database).select().from(proposals).where(where).orderBy(asc(proposals.created_at), asc(proposals.id)).all().map(as_proposal);
}

export function settle_proposal(database: SqlDatabase, id: string, status: ProposalStatus, result: string): void {
  drizzle_of(database).update(proposals).set({ status, result, resolved_at: new Date().toISOString() }).where(eq(proposals.id, id)).run();
}

export function remove_proposals(database: SqlDatabase, conversation_id: string): void {
  drizzle_of(database).delete(proposals).where(eq(proposals.conversation_id, conversation_id)).run();
}
