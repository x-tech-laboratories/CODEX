// The shapes the blueprints store hands the page and other programs. The page imports only these types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { item_link } from "@x-tech-laboratories/x-libs/items";

// ── Blueprints ───────────────────────────────────────────────────────────────

// Proposed waits for the user; active is recalled; retired is kept but never recalled.
export type BlueprintStatus = "proposed" | "active" | "retired";

export const blueprint_statuses: BlueprintStatus[] = ["proposed", "active", "retired"];

// Who wrote it: the user at CODEX's page, an engine in a conversation, or a program through a token or MCP.
export type BlueprintMaker = "user" | "engine" | "program";

export interface BlueprintSummary {
  id: string;
  title: string;
  // When it applies: a short description its recall matches the user's message against.
  applies_when: string;
  status: BlueprintStatus;
  made_by: BlueprintMaker;
  engine: string;
  model: string;
  // The contexts it applies in (and in those inside them), by id and name; none for one that applies everywhere.
  contexts: { id: string; name: string }[];
  // The sources whose content the run that wrote it had read, by collector id; none once the user made it theirs.
  sources: string[];
  // The conversation it was proposed in; empty for one the user wrote.
  conversation_id: string;
  use_count: number;
  last_used_at: string;
  // Proposed changes waiting for the user.
  waiting_changes: number;
  created_at: string;
  updated_at: string;
  // Where it opens, such as codex://blueprint/<id>.
  link: string;
}

export interface Blueprint extends BlueprintSummary {
  // The rules and the ordered steps, in Markdown.
  body: string;
  changes: BlueprintChange[];
}

export type ChangeStatus = "waiting" | "accepted" | "rejected";

// A new version of a blueprint an engine or a program proposed, with why.
export interface BlueprintChange {
  id: string;
  blueprint_id: string;
  title: string;
  applies_when: string;
  body: string;
  reason: string;
  status: ChangeStatus;
  made_by: BlueprintMaker;
  engine: string;
  model: string;
  sources: string[];
  conversation_id: string;
  created_at: string;
  decided_at: string;
}

// The new text of a blueprint; a field left out stays as it is.
export interface BlueprintText {
  title?: string;
  applies_when?: string;
  body?: string;
}

// What a proposal waiting for the user is, for a list of them: a new blueprint or a change to one, with its text.
export interface BlueprintProposal {
  // The proposed blueprint's id, or the change's.
  id: string;
  kind: "new" | "change";
  blueprint_id: string;
  title: string;
  applies_when: string;
  body: string;
  // For a change: the blueprint as it is now, and why it would change.
  before: { title: string; applies_when: string; body: string } | null;
  reason: string;
  made_by: BlueprintMaker;
  engine: string;
  model: string;
  sources: string[];
  conversation_id: string;
  created_at: string;
}

// What deciding several proposals did: those decided, and those not with why.
export interface BlueprintDecisions {
  decided: string[];
  skipped: { id: string; reason: string }[];
}

// What a proposing call answers the engine or program.
export interface BlueprintOutcome {
  outcome: "proposed" | "refused";
  id: string;
  message: string;
}

// ── Items ────────────────────────────────────────────────────────────────────

// The collector, and the kind, a blueprint is kept under as an item; CODEX's own, so never an outside source.
export const blueprint_collector = "blueprint";
export const blueprint_kind = "blueprint";

export function blueprint_item_id(blueprint_id: string): string {
  return `${blueprint_collector}:${blueprint_id}`;
}

// The blueprint an item id names, or null for any other item.
export function blueprint_of_item(item_id: string): string | null {
  return item_id.startsWith(`${blueprint_collector}:`) ? item_id.slice(blueprint_collector.length + 1) : null;
}

export function blueprint_link(blueprint_id: string): string {
  return item_link("codex", blueprint_kind, blueprint_id);
}

// The page's route that opens a blueprint in the workspace.
export function blueprint_route(blueprint_id: string): string {
  return `#/blueprint/${encodeURIComponent(blueprint_id)}`;
}
