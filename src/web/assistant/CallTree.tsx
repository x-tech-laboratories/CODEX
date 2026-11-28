// The calls a reply made, as a tree: the assistant's own calls at the top, each ask_ call holding the calls of the
// specialist it asked; a row picked shows what it was given, what came back and, for an ask, what its specialist
// thought and wrote, in a panel under the tree.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { duration } from "@x-tech-laboratories/x-libs/web/format";
import { Icon, UndoIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { ProgressBar } from "@x-tech-laboratories/x-libs/web/react/progress";
import { use_now } from "@x-tech-laboratories/x-libs/web/react/time";
import { Tree, type TreeItem } from "@x-tech-laboratories/x-libs/web/react/tree";

import { call_path_mark, reply_parts, type ReplyPart, type ThinkingPiece, type ToolCallRecord } from "../../shared/conversations/model.ts";
import type { Proposal } from "../../shared/policy/model.ts";
import type { ChangeUndoState } from "../../shared/policy/undo.ts";
import { calls, succeeds } from "../api.ts";
import { Thinking } from "./Thinking.tsx";
import type { LiveSpecialist } from "./use_conversation.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const outcome_words: Record<ToolCallRecord["outcome"], string> = {
  pending: "running",
  ran: "done",
  proposed: "waits for you",
  refused: "not permitted",
  rejected: "rejected by you",
  failed: "failed",
};

const outcome_tones: Record<ToolCallRecord["outcome"], string> = { pending: "none", ran: "good", proposed: "warn", refused: "bad", rejected: "none", failed: "bad" };

// How a proposed call's row reads once the user decided it.
const decided_words: Partial<Record<Proposal["status"], [words: string, tone: string]>> = { approved: ["approved by you", "good"], rejected: ["rejected by you", "none"], failed: ["failed", "bad"] };

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// The specialist's label as the ask's name says it, for a page that opened after the ask began.
const label_of_ask = (name: string) => name.replace(/^ask_/, "").replace(/_/g, " ");

// ── Nodes ────────────────────────────────────────────────────────────────────

// One call as a row of the tree, named by its id path: an ask's call id, then its specialist's call id under it.
export interface CallNode extends TreeItem {
  call: ToolCallRecord;
}

// Every call and the calls under it, in the order they were made.
export function call_nodes(calls: ToolCallRecord[], parent_id: string | null = null): CallNode[] {
  return calls.flatMap((call, position) => {
    const id = parent_id === null ? call.id : `${parent_id}${call_path_mark}${call.id}`;
    return [{ id, parent_id, position, call }, ...call_nodes(call.calls ?? [], id)];
  });
}

// A specialist's calls and thinking in order, with its text so far after the thinking before each call.
export function nested_parts(calls: ToolCallRecord[], thinking: ThinkingPiece[] = [], writing: ThinkingPiece[] = []): ReplyPart[] {
  const written = writing.filter((piece) => piece.text.trim());
  const text_at = (calls_before: number) => written.filter((piece) => piece.calls_before === calls_before).map((piece) => ({ text: piece.text }));
  const parts: ReplyPart[] = [];
  let calls_seen = 0;
  for (const part of reply_parts("", calls, thinking)) {
    if ("call" in part) parts.push(...text_at(calls_seen++));
    parts.push(part);
  }
  parts.push(...written.filter((piece) => piece.calls_before >= calls_seen).map((piece) => ({ text: piece.text })));
  return parts;
}

// A reply's parts with each run of calls made one after another gathered into one tree's worth.
export function grouped_parts(parts: ReplyPart[]): ({ calls: ToolCallRecord[] } | Exclude<ReplyPart, { call: ToolCallRecord }>)[] {
  const grouped: ({ calls: ToolCallRecord[] } | Exclude<ReplyPart, { call: ToolCallRecord }>)[] = [];
  for (const part of parts) {
    const last = grouped.at(-1);
    if (!("call" in part)) grouped.push(part);
    else if (last && "calls" in last) last.calls.push(part.call);
    else grouped.push({ calls: [part.call] });
  }
  return grouped;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

// Beside an applied change: Undo while it can still be undone, why not when it cannot, or that it was.
function UndoLine({ undo }: { undo: ChangeUndoState }) {
  const [busy, set_busy] = useState(false);
  if (undo.state === "undone") return <span className="muted small tool-call-undo">Undone by you.</span>;
  if (undo.state === "impossible") return <span className="muted small tool-call-undo">{undo.reason}</span>;
  const run = async () => {
    set_busy(true);
    await succeeds(() => calls().undo_change(undo.message_id, undo.call_id), "Undone.");
    set_busy(false);
  };
  return (
    <span className="tool-call-undo">
      <button
        type="button"
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          void run();
        }}
      >
        <Icon icon={UndoIcon} /> Undo
      </button>
    </span>
  );
}

// The specialist being asked and for how long, ticking each second.
function SpecialistBusy({ label, since }: { label: string; since: number }) {
  const now = use_now(1000).getTime();
  return (
    <span className="muted small">
      Asking the {label} specialist… {duration(Math.max(0, (now - since) / 1000))}
    </span>
  );
}

// ── Tree ─────────────────────────────────────────────────────────────────────

interface CallTreeProps {
  calls: ToolCallRecord[];
  // How the user decided each proposal, by its id.
  decisions?: Map<string, Proposal["status"]> | undefined;
  // An applied change's undo state, by the call's id path.
  undo_of?: ((path: string) => ChangeUndoState | undefined) | undefined;
  // The specialists at work, by their ask's call id, while the reply streams.
  specialists?: Record<string, LiveSpecialist> | undefined;
}

// Calls made one after another as one tree: who made each is where it sits, CODEX's at the top and a specialist's under
// the ask that asked it. A row says its call, whom an ask asked and how it ended, a proposal as the user decided it and
// an applied change with its undo; while a specialist works its ask shows it picked, its thinking and text streaming
// in the panel, and says for how long.
export function CallTree({ calls: made, decisions, undo_of, specialists = {} }: CallTreeProps) {
  const nodes = call_nodes(made);
  const [collapsed, set_collapsed] = useState<Set<string>>(() => new Set());
  // Undefined until the reader picks a row or closes the panel, so a specialist at work shows on its own.
  const [picked, set_picked] = useState<string | null | undefined>(undefined);
  const [since] = useState(() => Date.now());
  const asking = (node: CallNode) => node.call.outcome === "pending" && (specialists[node.id] !== undefined || node.call.calls !== undefined);
  const shown_id = picked === undefined ? (nodes.find(asking)?.id ?? null) : picked;
  const shown = nodes.find((node) => node.id === shown_id) ?? null;
  const is_ask = (node: CallNode) => node.call.calls !== undefined || specialists[node.id] !== undefined;
  const label_of = (node: CallNode) => specialists[node.id]?.label || label_of_ask(node.call.name);
  const words_of = (call: ToolCallRecord): [string, string] => (call.outcome === "proposed" && call.proposal_id && decided_words[decisions?.get(call.proposal_id) ?? "pending"]) || [outcome_words[call.outcome], outcome_tones[call.outcome]];

  return (
    <div className="call-tree">
      <Tree
        items={nodes}
        label="CODEX's calls"
        collapsed={collapsed}
        on_collapsed_change={set_collapsed}
        selected_id={shown_id}
        on_select={(node) => set_picked(node.id === shown_id ? null : node.id)}
        name_of={(node) => node.call.name}
        render_item={(node) => {
          const [words, tone] = words_of(node.call);
          const made_by = node.call.applied_by === "user_approval" ? "approved by you" : node.call.applied_by === "engine_auto" ? "made by the assistant" : "";
          return (
            <span className="tool-call-summary">
              <code>{node.call.name}</code>
              {is_ask(node) && <span className="muted small">→ {label_of(node)} specialist</span>}
              <span className={`badge tone-${tone}`}>{words}</span>
              {made_by && <span className="muted small">{made_by}</span>}
              {asking(node) && <SpecialistBusy label={label_of(node)} since={specialists[node.id]?.started_at ?? since} />}
            </span>
          );
        }}
        render_extra={(node) => {
          const undo = undo_of?.(node.id);
          return undo ? <UndoLine undo={undo} /> : null;
        }}
      />
      {shown && <CallDetail node={shown} nodes={nodes} asking={asking(shown)} label={label_of(shown)} specialist={specialists[shown.id]} />}
    </div>
  );
}

// The picked call: who made it, what it was given, what its specialist thought and wrote among its calls, and what
// came back.
function CallDetail({ node, nodes, asking, label, specialist }: { node: CallNode; nodes: CallNode[]; asking: boolean; label: string; specialist: LiveSpecialist | undefined }) {
  const { call } = node;
  const parent = nodes.find((each) => each.id === node.parent_id);
  const by = parent ? `the ${specialist_label(parent)} specialist, asked by CODEX` : "CODEX";
  const parts = nested_parts(call.calls ?? [], call.thinking, specialist?.text);
  return (
    <div className="tool-call-detail card" aria-label={`${call.name} in detail`}>
      <p className="small">
        <code>{call.name}</code> <span className="muted">made by {by}</span>
      </p>
      {asking && <ProgressBar value={null} label={`Asking the ${label} specialist`} />}
      <p className="muted small">Arguments</p>
      <pre className="output">{JSON.stringify(call.arguments, null, 2)}</pre>
      {parts.some((part) => !("call" in part)) && (
        <>
          <p className="muted small">What the specialist thought and wrote</p>
          <div className="tool-call-nested">
            {parts.map((part, at) =>
              "call" in part ? (
                <p key={part.call.id} className="muted small">
                  Called <code>{part.call.name}</code>
                </p>
              ) : "thinking" in part ? (
                <Thinking key={`thinking-${at}`} text={part.thinking} active={call.outcome === "pending"} />
              ) : (
                <Markdown key={`text-${at}`} class_name="tool-call-writing" text={part.text} />
              ),
            )}
          </div>
        </>
      )}
      {call.outcome !== "pending" && (
        <>
          <p className="muted small">Result</p>
          <pre className="output">{pretty(call.result) || "Nothing."}</pre>
        </>
      )}
    </div>
  );
}

const specialist_label = (node: CallNode) => label_of_ask(node.call.name);
