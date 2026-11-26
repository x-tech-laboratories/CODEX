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

// One read the run made before proposing, by its tool call, with a short excerpt of what came back only when every
// source it carried may leave this computer (marked for hosted engines), as graph evidence is kept.
export interface ProposalRead {
  // The tool call's id in the answer that holds it; empty when not known.
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  sources: string[];
  excerpt: string;
}

// What a proposal came from: the user's message that asked for it, the run, and what the run had read before it.
export interface ProposalEvidence {
  asked_by: string;
  run_id: string;
  reads: ProposalRead[];
  // The sources whose content the run had in front of it, in its instructions or through a read, by collector id;
  // left out for a proposal kept before it was recorded.
  seen?: string[];
}

export const no_evidence: ProposalEvidence = { asked_by: "", run_id: "", reads: [] };

export interface Proposal {
  id: string;
  conversation_id: string;
  method: string;
  arguments: Record<string, unknown>;
  summary: string;
  reason: ProposalReason;
  // The sources whose content the run had read or its summary names, by collector id; "*" when not recorded.
  sources: string[];
  status: ProposalStatus;
  result: string;
  created_at: string;
  resolved_at: string;
  // Empty for a proposal kept before evidence was recorded.
  evidence: ProposalEvidence;
}
