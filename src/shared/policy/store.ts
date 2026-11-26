// The action policy: the level of each call an engine could change something with, kept in the synced settings, and
// the changes waiting for the user, which approving runs and rejecting sets aside, either way recorded in the
// conversation they were proposed in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of } from "../api_schemas.ts";
import { assistant_host } from "../conversations/host.ts";
import { add_message, type NewMessage } from "../conversations/messages.ts";
import { has_conversation } from "../conversations/records.ts";
import { define_feature } from "../feature.ts";
import { settings_feature } from "../settings.ts";
import { migrations } from "./migrations/index.ts";
import { default_level, is_policy_level, policy_levels, type PolicyEntry, type PolicyLevel, type Proposal, type ProposalStatus } from "./model.ts";
import { changing_calls, level_of, offered_api, policy_setting, stored_levels } from "./policy.ts";
import { list_proposals_of, proposal_of, settle_proposal } from "./proposals.ts";
import { policy_tables } from "./schema.ts";

// ── Levels ───────────────────────────────────────────────────────────────────

function get_action_policy(database: SqlDatabase): PolicyEntry[] {
  return changing_calls().map((method) => ({ method, description: offered_api[method]!.description, level: level_of(database, method), destructive: offered_api[method]!.destructive === true }));
}

function set_action_level(database: SqlDatabase, method: string, level: PolicyLevel): void {
  if (!changing_calls().includes(method)) throw new Error(`${method} is not a change an engine is offered; get_action_policy lists those.`);
  if (!is_policy_level(level)) throw new Error(`A level is one of ${policy_levels.join(", ")}.`);
  settings_feature.methods.set_setting(database, policy_setting, { ...stored_levels(database), [method]: level });
}

// ── Proposals ────────────────────────────────────────────────────────────────

function list_proposals(database: SqlDatabase, conversation_id: string | null = null, status?: ProposalStatus): Proposal[] {
  return list_proposals_of(database, conversation_id || null, status);
}

function as_text(value: unknown): string {
  return value === undefined ? "Done." : typeof value === "string" ? value : JSON.stringify(value);
}

// Records what became of a proposal in its conversation, unless the change took the conversation away with it, such as
// the removal of the last context holding it.
function add_event(database: SqlDatabase, event: NewMessage): void {
  if (has_conversation(database, event.conversation_id)) add_message(database, event);
}

// Approving runs the call as the user's own and records its result; rejecting records that it was not made.
async function resolve_proposal(database: SqlDatabase, id: string, decision: "approve" | "reject"): Promise<Proposal> {
  const proposal = proposal_of(database, id);
  if (proposal.status !== "waiting") throw new Error(`That proposal was already ${proposal.status}.`);
  if (decision !== "approve" && decision !== "reject") throw new Error('Decide with "approve" or "reject".');
  const call_record = { id: proposal.id, name: proposal.method, arguments: proposal.arguments, proposal_id: proposal.id };
  if (decision === "reject") {
    settle_proposal(database, id, "rejected", "");
    add_event(database, { conversation_id: proposal.conversation_id, role: "event", text: `Rejected: ${proposal.summary}`, tool_calls: [{ ...call_record, result: "", is_error: false, outcome: "refused" }], sources: proposal.sources });
    return proposal_of(database, id);
  }
  const host = assistant_host();
  // Marked first, so a second approval while this one runs is refused.
  settle_proposal(database, id, "approved", "");
  try {
    const spec = offered_api[proposal.method];
    if (!spec) throw new Error(`${proposal.method} is no longer offered.`);
    const result = as_text(await host.call(proposal.method, positional_args(spec, proposal.arguments)));
    settle_proposal(host.database(), id, "approved", result);
    add_event(host.database(), {
      conversation_id: proposal.conversation_id,
      role: "event",
      text: `Approved and done: ${proposal.summary}`,
      tool_calls: [{ ...call_record, result, is_error: false, outcome: "ran", applied_by: "user_approval" }],
      sources: proposal.sources,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settle_proposal(host.database(), id, "failed", message);
    add_event(host.database(), {
      conversation_id: proposal.conversation_id,
      role: "event",
      text: `Approved, but it failed: ${proposal.summary}`,
      tool_calls: [{ ...call_record, result: message, is_error: true, outcome: "failed", applied_by: "user_approval" }],
      error: message,
      sources: proposal.sources,
    });
  }
  // An approved removal of the last context holding the proposal's conversation takes the proposal with it.
  return list_proposals_of(host.database(), proposal.conversation_id).find((each) => each.id === id) ?? { ...proposal, status: "approved", resolved_at: new Date().toISOString() };
}

// ── Feature ──────────────────────────────────────────────────────────────────

const level_schema = {
  type: "string",
  enum: policy_levels,
  description: "restricted: never; proposal: only once the user approves it; auto: by the assistant while the user is in the conversation; background: also by background jobs with nobody present.",
};

export const policy_feature = define_feature({
  id: "policy",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(policy_tables),
  methods: { get_action_policy, set_action_level, list_proposals, resolve_proposal },
  api: {
    get_action_policy: {
      description: `Lists every call the assistant could change something with, each with its level; a call never given one is at ${default_level}.`,
      params: [],
    },
    set_action_level: {
      description: "Sets how freely the assistant may make one kind of change. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "method", schema: { type: "string", description: "The call, such as rename_context, from get_action_policy." } },
        { name: "level", schema: level_schema },
      ],
    },
    list_proposals: {
      description: "Lists the changes the assistant proposed, oldest first, in one conversation or all of them, with what each would do in plain words and whether it waits, was approved, rejected or failed.",
      params: [
        { name: "conversation_id", schema: { type: ["string", "null"], description: "A conversation's id, from list_conversations, or null for every conversation." }, optional: true },
        { name: "status", schema: { type: "string", enum: ["waiting", "approved", "rejected", "failed"], description: "Only those in this state." }, optional: true },
      ],
    },
    resolve_proposal: {
      description:
        "Approves a proposed change, which makes it now, or rejects it; either way it is recorded in the conversation it was proposed in. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("proposal") },
        { name: "decision", schema: { type: "string", enum: ["approve", "reject"], description: "approve or reject." } },
      ],
    },
  },
  setting_defaults: { [policy_setting]: {} },
});
