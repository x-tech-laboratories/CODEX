// Reading and writing the changes that wait for the user, for the conversations' runs and the policy's own calls.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, eq, ne } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of, new_id } from "../feature.ts";
import type { Proposal, ProposalReason, ProposalStatus } from "./model.ts";
import { proposals } from "./schema.ts";

// ── Proposals ────────────────────────────────────────────────────────────────

function as_proposal(row: typeof proposals.$inferSelect): Proposal {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.arguments) as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { ...row, arguments: args, reason: row.reason as ProposalReason, status: row.status as ProposalStatus };
}

export function add_proposal(database: SqlDatabase, values: { conversation_id: string; method: string; arguments: Record<string, unknown>; summary: string; reason: ProposalReason }): Proposal {
  const row = { id: new_id(), ...values, arguments: JSON.stringify(values.arguments), status: "waiting", result: "", created_at: new Date().toISOString(), resolved_at: "" };
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

// Every conversation that has proposals, but the general one.
export function proposal_conversations(database: SqlDatabase): string[] {
  const rows = drizzle_of(database).selectDistinct({ id: proposals.conversation_id }).from(proposals).where(ne(proposals.conversation_id, "general")).all();
  return rows.map((row) => row.id);
}

export function remove_proposals(database: SqlDatabase, conversation_id: string): void {
  drizzle_of(database).delete(proposals).where(eq(proposals.conversation_id, conversation_id)).run();
}
