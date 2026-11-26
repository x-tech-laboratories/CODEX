// The shapes the action policy hands the page and other programs. The page imports only these types.

// ── Levels ───────────────────────────────────────────────────────────────────

// From least to most permissive: never; only once the user approves; while the user is in the conversation; and also
// for background jobs with nobody present.
export type PolicyLevel = "restricted" | "proposal" | "auto" | "background";

export const policy_levels: PolicyLevel[] = ["restricted", "proposal", "auto", "background"];

// What every call an engine could change something with starts at, and any call the policy does not know.
export const default_level: PolicyLevel = "proposal";

export function is_policy_level(value: unknown): value is PolicyLevel {
  return typeof value === "string" && (policy_levels as string[]).includes(value);
}

// One changing call as Settings lists it.
export interface PolicyEntry {
  method: string;
  description: string;
  level: PolicyLevel;
  // It deletes something.
  destructive: boolean;
}

// ── Proposals ────────────────────────────────────────────────────────────────

export type ProposalStatus = "waiting" | "approved" | "rejected" | "failed";

// Why a change waits: its level, or a run that had read other apps' text.
export type ProposalReason = "level" | "outside content";

export interface Proposal {
  id: string;
  conversation_id: string;
  method: string;
  arguments: Record<string, unknown>;
  summary: string;
  reason: ProposalReason;
  status: ProposalStatus;
  result: string;
  created_at: string;
  resolved_at: string;
}
