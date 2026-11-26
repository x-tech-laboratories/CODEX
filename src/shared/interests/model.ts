// The shapes the interests feature hands the page and other programs: the topics the assistant may research on the web
// for its own knowledge, each proposed, accepted, paused or dropped, and the findings its research saved, kept as items
// of CODEX's own in a context of the assistant's. The page imports only these.

// ── Interests ────────────────────────────────────────────────────────────────

// Proposed waits for the user; only an accepted one is researched; paused keeps it for later; dropped ends it.
export type InterestState = "proposed" | "accepted" | "paused" | "dropped";

export const interest_states: InterestState[] = ["proposed", "accepted", "paused", "dropped"];

// Who made it: the user at the page, an engine in a conversation or a research run, or a program through a token or MCP.
export type InterestMaker = "user" | "engine" | "program";

export interface Interest {
  id: string;
  // The exact text sent to a search engine once accepted.
  topic: string;
  reason: string;
  state: InterestState;
  made_by: InterestMaker;
  engine: string;
  model: string;
  // The sources the run that proposed it had read, by collector id; none for one the user added.
  sources: string[];
  // The conversation it came from, by id and title; empty for one the user added.
  conversation_id: string;
  conversation_title: string;
  // The context its findings are kept in, empty until the first.
  context_id: string;
  findings: number;
  researched_at: string;
  created_at: string;
  updated_at: string;
}

export const longest_topic = 120;
export const longest_reason = 300;

// ── Settings ─────────────────────────────────────────────────────────────────

// The most interests accepted at once, set by the user alone, and the context of the assistant's own that holds the
// findings, which only CODEX's code sets.
export const interest_settings = {
  max_accepted: "interests.max_accepted",
  context: "interests.context",
} as const;

export const interest_defaults = {
  [interest_settings.max_accepted]: 5,
  [interest_settings.context]: "",
};

export const max_accepted_bounds: [number, number] = [1, 20];

export const interests_context_name = "The assistant's interests";

// ── Findings ─────────────────────────────────────────────────────────────────

// The internal collector answering for findings: items CODEX owns, each holding what a research run saved.
export const finding_collector = "codex.findings";
export const finding_kind = "finding";

export function finding_item_id(id: string): string {
  return `${finding_collector}:${id}`;
}

// The most findings one research run may save, and the longest a finding's parts may be.
export const findings_per_run = 3;
export const longest_finding_title = 120;
export const longest_finding_text = 2000;
export const most_addresses = 8;
