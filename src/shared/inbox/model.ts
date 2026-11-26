// The shapes the Inbox hands the page and other programs. The page imports only these types.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { BlueprintProposal } from "../blueprints/model.ts";
import type { GraphEntity, ProposedLink } from "../graph/model.ts";
import type { JobRun } from "../jobs/model.ts";
import type { Proposal } from "../policy/model.ts";

// ── Entries ──────────────────────────────────────────────────────────────────

// A proposed change, a proposed graph link or entity, a proposed blueprint or change to one, or a job's run that ended badly.
export type InboxKind = "change" | "link" | "entity" | "blueprint" | "blueprint_change" | "job_run";

export interface InboxEntry {
  // The kind and the id, unique across the Inbox.
  key: string;
  kind: InboxKind;
  // The proposal's, link's, entity's, blueprint's, change's or run's id.
  id: string;
  // What it is, in plain words.
  title: string;
  // A line more: its evidence, why it waits, or how a run ended.
  detail: string;
  made_by: string;
  created_at: string;
  // The conversation it came from, if any, by id and title, and the job whose conversation that is.
  conversation_id: string;
  conversation_title: string;
  job_title: string;
  // The page's route that opens it.
  route: string;
  proposal?: Proposal;
  link?: ProposedLink;
  entity?: GraphEntity;
  blueprint?: BlueprintProposal;
  run?: JobRun;
}
