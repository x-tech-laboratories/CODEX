// The action policy: the level of each call an engine could change something with, kept in the synced settings, the
// changes waiting for the user, which approving runs and rejecting sets aside, either way recorded in the conversation
// they were proposed in, and undoing a change that was applied, which only the user at the page can do.

// ── Imports ──────────────────────────────────────────────────────────────────

import { synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import { settings_of } from "@x-tech-laboratories/x-libs/settings";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { contexts_feature } from "../contexts/store.ts";
import { assistant_host } from "../conversations/host.ts";
import { add_message, call_at, list_messages, message_of, update_tool_call, type NewMessage } from "../conversations/messages.ts";
import { has_conversation } from "../conversations/records.ts";
import { define_feature } from "../feature.ts";
import { record_tool_send } from "../privacy/store.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { is_plugin_tool_name, tool_source_of } from "../tools/model.ts";
import { find_plugin_tool, run_tool } from "../tools/offered.ts";
import { write_setting } from "../settings.ts";
import { migrations } from "./migrations/index.ts";
import { default_level, is_policy_level, policy_levels, type PolicyEntry, type PolicyLevel, type Proposal, type ProposalStatus } from "./model.ts";
import { leveled_calls, level_of, maintenance_api, policy_setting, proposable_spec, stored_levels } from "./policy.ts";
import { list_proposals_of, proposal_of, settle_proposal } from "./proposals.ts";
import { mark_before_change, undo_of_change, undo_state, undo_states, undo_steps, type ChangeUndoState } from "./undo.ts";
import { policy_tables } from "./schema.ts";

// ── Levels ───────────────────────────────────────────────────────────────────

// A change only background maintenance makes is said as such.
function get_action_policy(database: SqlDatabase): PolicyEntry[] {
  return leveled_calls().map((method) => {
    const spec = proposable_spec(method)!;
    const description = method in maintenance_api ? `Background maintenance: ${spec.description} It ends a link the user, a program or the assistant made once the item at its end is gone from its app.` : spec.description;
    return { method, description, level: level_of(database, method), destructive: spec.destructive === true };
  });
}

function set_action_level(database: SqlDatabase, method: string, level: PolicyLevel): void {
  if (!leveled_calls().includes(method)) throw new Error(`${method} is not a change an engine is offered; get_action_policy lists those.`);
  if (!is_policy_level(level)) throw new Error(`A level is one of ${policy_levels.join(", ")}.`);
  write_setting(database, policy_setting, { ...stored_levels(database), [method]: level });
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

function own_spec(method: string) {
  const spec = proposable_spec(method);
  if (!spec) throw new Error(`${method} is no longer offered.`);
  return spec;
}

// A plugin tool the user approved runs with the arguments they saw, logged when it sends them outside; what it answers
// is fenced, as the engine reads it in the event.
async function approved_plugin_tool(database: SqlDatabase, proposal: Proposal): Promise<{ result: string; source: string }> {
  const tool = await find_plugin_tool(database, proposal.method);
  if (!tool) throw new Error(`${proposal.method} is no longer offered; its plugin or the tool is turned off.`);
  if (tool.tool.sends_outside) {
    record_tool_send(database, { run_id: proposal.evidence.run_id, conversation_id: proposal.conversation_id, engine: "Approved by you", model: "", tool: `${tool.label}: ${tool.tool.name}`, args: proposal.arguments });
  }
  return { result: untrusted_block(as_text(await run_tool(tool, proposal.arguments, new AbortController().signal))), source: tool_source_of(tool.key) };
}

// Approving runs the call as the user's own and records its result; rejecting records that it was not made.
async function resolve_proposal(database: SqlDatabase, id: string, decision: "approve" | "reject"): Promise<Proposal> {
  const proposal = proposal_of(database, id);
  if (proposal.status !== "waiting") throw new Error(`That proposal was already ${proposal.status}.`);
  if (decision !== "approve" && decision !== "reject") throw new Error('Decide with "approve" or "reject".');
  const call_record = { id: proposal.id, name: proposal.method, arguments: proposal.arguments, proposal_id: proposal.id };
  if (decision === "reject") {
    settle_proposal(database, id, "rejected", "");
    add_event(database, { conversation_id: proposal.conversation_id, role: "event", text: `Rejected: ${proposal.summary}`, tool_calls: [{ ...call_record, result: "", is_error: false, outcome: "rejected" }], sources: proposal.sources });
    return proposal_of(database, id);
  }
  const host = assistant_host();
  // Marked first, so a second approval while this one runs is refused.
  settle_proposal(database, id, "approved", "");
  try {
    // Noted as it is made, so the user can undo it from the conversation.
    const mark = mark_before_change(host.database());
    const plugin = is_plugin_tool_name(proposal.method) ? await approved_plugin_tool(host.database(), proposal) : null;
    const result = plugin ? plugin.result : as_text(await host.call(proposal.method, positional_args(own_spec(proposal.method), proposal.arguments)));
    const undo = undo_of_change(host.database(), mark, proposal.summary);
    settle_proposal(host.database(), id, "approved", result);
    add_event(host.database(), {
      conversation_id: proposal.conversation_id,
      role: "event",
      text: `Approved and done: ${proposal.summary}`,
      tool_calls: [{ ...call_record, result, is_error: false, outcome: "ran", applied_by: "user_approval", undo }],
      // A plugin tool's answer counts as its plugin's content, so a later run replayed this event reads it again.
      sources: plugin ? [...new Set([...proposal.sources, plugin.source])].sort() : proposal.sources,
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

// ── Undo ─────────────────────────────────────────────────────────────────────

// Each change applied in a conversation, by approval or at the auto level, with whether it can still be undone.
function list_change_undos(database: SqlDatabase, conversation_id: string): ChangeUndoState[] {
  return undo_states(database, list_messages(database, conversation_id));
}

// Undoes one applied change through History, records the undo in its conversation and marks the change undone.
function undo_change(database: SqlDatabase, message_id: string, call_id: string): ChangeUndoState {
  const message = message_of(database, message_id);
  const found = message ? call_at(message.tool_calls, call_id) : undefined;
  const call = found?.applied_by && found.outcome === "ran" ? found : undefined;
  if (!message || !call) throw new Error("There is no applied change by that message and call.");
  const { state, reason } = undo_state(database, call);
  if (state === "undone") throw new Error("That change was already undone.");
  if (state === "impossible") throw new Error(reason);
  undo_steps(database, call.undo!, (id) => contexts_feature.methods.remove_context(database, id));
  if (has_conversation(database, message.conversation_id)) {
    update_tool_call(database, message_id, call_id, (each) => ({ ...each, undo: { ...each.undo!, undone_at: new Date().toISOString() } }));
    add_message(database, { conversation_id: message.conversation_id, role: "event", text: `Undone by you: ${call.undo!.summary}`, sources: [] });
  }
  return { message_id, call_id, state: "undone", reason: "" };
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
  methods: { get_action_policy, set_action_level, list_proposals, resolve_proposal, list_change_undos, undo_change },
  api: {
    get_action_policy: {
      description: `Lists every call the assistant could change something with, each with its level; a call never given one is at ${default_level}.`,
      params: [],
    },
    set_action_level: {
      page_only: true,
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
    list_change_undos: {
      description:
        "Lists each change the assistant applied in one conversation, by approval or on its own, by the message and tool call that record it, with whether it can still be undone and, when not, why in plain words.",
      params: [{ name: "conversation_id", schema: id_of("conversation") }],
    },
    undo_change: {
      page_only: true,
      description:
        "Undoes one change the assistant applied, through History: the contexts it touched go back to how they were before it, and the undo is recorded in the conversation. Refused once those contexts have changed since. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "message_id", schema: id_of("message") },
        { name: "call_id", schema: text("The tool call's id on that message, or for a specialist's call its ask's id and its own joined by /, from list_change_undos.") },
      ],
    },
    resolve_proposal: {
      page_only: true,
      description:
        "Approves a proposed change, which makes it now, or rejects it; either way it is recorded in the conversation it was proposed in. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("proposal") },
        { name: "decision", schema: { type: "string", enum: ["approve", "reject"], description: "approve or reject." } },
      ],
    },
  },
  settings: settings_of({ [policy_setting]: {} }, { user_only: true }),
});
