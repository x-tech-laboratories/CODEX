// The assistant's pane on the right: its face and the engine answering, a switcher between the open context's
// conversations (those in no context when none is open), the one shown with the reply streaming in, the changes
// waiting for the user, and the message box.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { MenuItem } from "@x-tech-laboratories/x-libs/web/menus";
import { age } from "@x-tech-laboratories/x-libs/web/format";
import { AddIcon, ChevronDownIcon, EditIcon, Icon, UndoIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { use_follow_tail } from "@x-tech-laboratories/x-libs/web/react/following";
import { FormGroup } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { MenuButton } from "@x-tech-laboratories/x-libs/web/react/menu_button";
import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { Empty, Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { use_watch } from "@x-tech-laboratories/x-libs/web/react/watch";
import { Send, Square } from "lucide-react";

import { conversation_item_id, reply_parts, type AssistantStatus, type ConversationMessage, type ConversationSummary, type ToolCallRecord } from "../../shared/conversations/model.ts";
import type { Proposal } from "../../shared/policy/model.ts";
import type { ChangeUndoState } from "../../shared/policy/undo.ts";
import { attempt, calls, page, succeeds, use_data } from "../api.ts";
import { BlueprintProposalCard } from "../blueprints/ProposalCard.tsx";
import { add_to_contexts, delete_conversation, move_to_context, rename_conversation } from "../contexts/item_actions.tsx";
import { open_conversation, take_wanted, wanted_watch } from "./selection.ts";
import { Mascot } from "./Mascot.tsx";
import { lasting_mood, moment_after, type MascotMood } from "./mascot.ts";
import { use_conversation, type LiveRun } from "./use_conversation.ts";

// ── Tool calls ───────────────────────────────────────────────────────────────

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

// Under an applied change: Undo while it can still be undone, why not when it cannot, or that it was.
function UndoLine({ undo }: { undo: ChangeUndoState }) {
  const [busy, set_busy] = useState(false);
  if (undo.state === "undone") return <p className="muted small tool-call-undo">Undone by you.</p>;
  if (undo.state === "impossible") return <p className="muted small tool-call-undo">{undo.reason}</p>;
  const run = async () => {
    set_busy(true);
    await succeeds(() => calls().undo_change(undo.message_id, undo.call_id), "Undone.");
    set_busy(false);
  };
  return (
    <p className="tool-call-undo">
      <button type="button" disabled={busy} onClick={() => void run()}>
        <Icon icon={UndoIcon} /> Undo
      </button>
    </p>
  );
}

// One call the engine made, folded to its name and outcome; open, its arguments and what came back. A proposed call
// reads as the user decided it, when they have; an applied change offers its undo underneath.
export function ToolCallRow({ call, decided, undo }: { call: ToolCallRecord; decided?: Proposal["status"] | undefined; undo?: ChangeUndoState | undefined }) {
  const made_by = call.applied_by === "user_approval" ? "approved by you" : call.applied_by === "engine_auto" ? "made by the assistant" : "";
  const [words, tone] = (call.outcome === "proposed" && decided && decided_words[decided]) || [outcome_words[call.outcome], outcome_tones[call.outcome]];
  const row = (
    <FormGroup
      class_name="tool-call"
      summary={
        <span className="tool-call-summary">
          <code>{call.name}</code>
          <span className={`badge tone-${tone}`}>{words}</span>
          {made_by && <span className="muted small">{made_by}</span>}
        </span>
      }
    >
      <p className="muted small">Arguments</p>
      <pre className="output">{JSON.stringify(call.arguments, null, 2)}</pre>
      {call.outcome !== "pending" && (
        <>
          <p className="muted small">Result</p>
          <pre className="output">{pretty(call.result) || "Nothing."}</pre>
        </>
      )}
    </FormGroup>
  );
  if (!undo) return row;
  return (
    <div className="tool-call-applied">
      {row}
      <UndoLine undo={undo} />
    </div>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────

// What the user should know about how a reply was written, such as their message shortened to fit the model.
function Notices({ notices }: { notices: string[] }) {
  return notices.map((notice) => (
    <p key={notice} className="banner tone-fill-warn" role="note">
      {notice}
    </p>
  ));
}

// Why a reply stopped short, in plain words, with the raw failure folded behind Details.
export function ReplyError({ error, detail }: { error: string; detail: string }) {
  return (
    <div className="reply-error">
      <p className={error === "Stopped." ? "muted small" : "tone-bad"}>{error}</p>
      {detail && (
        <FormGroup class_name="reply-error-detail" summary={<span className="muted small">Details</span>}>
          <pre className="output">{detail}</pre>
        </FormGroup>
      )}
    </div>
  );
}

// What a reasoning model is thinking, folded under a Thinking row that opens to about ten lines, following the newest
// text as it streams unless the reader has scrolled up.
export function Thinking({ text, active = true }: { text: string; active?: boolean }) {
  const tail = use_follow_tail<HTMLParagraphElement>(text, active);
  return (
    <FormGroup class_name="reply-thinking" summary={<span className="muted small">Thinking…</span>}>
      <p ref={tail.ref} className="muted small reply-thinking-text" onScroll={tail.on_scroll}>
        {text}
      </p>
    </FormGroup>
  );
}

// Each applied change's undo state, by "<message id>:<call id>".
type Undos = Map<string, ChangeUndoState>;

function Message({ message, decided, undos }: { message: ConversationMessage; decided: Map<string, Proposal["status"]>; undos: Undos }) {
  if (message.role === "user") {
    return (
      <div className="chat-message from-user card">
        <Markdown text={message.text} />
      </div>
    );
  }
  if (message.role === "event") {
    return (
      <div className="chat-message chat-event">
        <p className="muted small">{message.text}</p>
        {message.tool_calls.map((call) => (
          // A refusal in an event is the user rejecting the proposal, as events kept before "rejected" said.
          <ToolCallRow key={call.id} call={call.outcome === "refused" ? { ...call, outcome: "rejected" } : call} undo={undos.get(`${message.id}:${call.id}`)} />
        ))}
      </div>
    );
  }
  return (
    <div className="chat-message from-assistant">
      <Notices notices={message.notices} />
      {reply_parts(message.text, message.tool_calls).map((part, at) =>
        "call" in part ? (
          <ToolCallRow key={part.call.id} call={part.call} decided={part.call.proposal_id ? decided.get(part.call.proposal_id) : undefined} undo={undos.get(`${message.id}:${part.call.id}`)} />
        ) : (
          <Markdown key={`text-${at}`} text={part.text} />
        ),
      )}
      {message.error && <ReplyError error={message.error} detail={message.error_detail} />}
      {message.engine && <p className="muted small">{[message.engine, message.model].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

function Reply({ run }: { run: LiveRun }) {
  return (
    <div className="chat-message from-assistant" aria-live="polite" aria-busy={!run.finished}>
      <Notices notices={run.notices} />
      {reply_parts(run.text, run.tool_calls).map((part, at, parts) =>
        "call" in part ? <ToolCallRow key={part.call.id} call={part.call} /> : <Markdown key={`text-${at}`} text={part.text} follow={at === parts.length - 1} />,
      )}
      {run.reasoning ? <Thinking text={run.reasoning} active={!run.finished} /> : !run.text && <p className="muted small">Thinking…</p>}
    </div>
  );
}

// ── Proposals ────────────────────────────────────────────────────────────────

// One line of arguments, clipped, for a read named in a proposal's evidence.
function brief_arguments(args: Record<string, unknown>): string {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

// What a proposal came from: the message that asked for it, what the run read before proposing, and the sources whose
// content it had in front of it, in its instructions or through a read.
export function Evidence({ proposal, asked, label_of }: { proposal: Proposal; asked: string | null; label_of: (source: string) => string }) {
  const { evidence } = proposal;
  if (!evidence.asked_by && evidence.reads.length === 0) return <p className="muted small">No evidence was kept for this proposal.</p>;
  const sources = (evidence.seen ?? []).filter((source) => source !== "*");
  return (
    <div className="proposal-evidence">
      {asked !== null && (
        <p className="small">
          <span className="muted">Asked for in your message: </span>“{asked}”
        </p>
      )}
      {evidence.reads.length > 0 ? (
        <>
          <p className="muted small">What it read first, as the calls above show:</p>
          <ul className="proposal-reads">
            {evidence.reads.map((read, at) => (
              <li key={`${read.call_id}-${at}`} className="small">
                <code>{read.name}</code> {brief_arguments(read.arguments)}
                {read.excerpt ? <span className="muted"> · “{read.excerpt}”</span> : read.sources.length > 0 && <span className="muted"> · not quoted, as {read.sources.map(label_of).join(", ")} may not leave this computer</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">It read nothing before proposing.</p>
      )}
      {sources.length > 0 && <p className="muted small">From: {sources.map(label_of).join(", ")}</p>}
    </div>
  );
}

// A change waiting for the user, with what it would do in plain words and, folded, what it came from.
export function ProposalCard({ proposal, asked = null, label_of = (source) => source }: { proposal: Proposal; asked?: string | null; label_of?: (source: string) => string }) {
  const [busy, set_busy] = useState(false);
  const decide = async (decision: "approve" | "reject") => {
    set_busy(true);
    await succeeds(() => calls().resolve_proposal(proposal.id, decision), decision === "approve" ? "Done." : undefined);
    set_busy(false);
  };
  return (
    <article className="card tone-edge-warn proposal-card" aria-label="Proposed change">
      <p>{proposal.summary}</p>
      <p className="muted small">
        {proposal.reason === "outside content" ? "Proposed after reading text from other apps, so it waits for you whatever its level." : "Its level asks for your approval."}
      </p>
      <FormGroup class_name="proposal-why" summary={<span className="muted small">Why, and from what</span>}>
        <Evidence proposal={proposal} asked={asked} label_of={label_of} />
      </FormGroup>
      <div className="proposal-actions">
        <button type="button" className="accent solid" disabled={busy} onClick={() => void decide("approve")}>
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </button>
      </div>
    </article>
  );
}

// ── Message box ──────────────────────────────────────────────────────────────

// Sends to the conversation shown, or starts a new one in the open context when none is; gives the conversation's id.
function Composer({ context_id, conversation_id, is_running, on_sent }: { context_id: string | null; conversation_id: string | null; is_running: boolean; on_sent: (sent: { conversation_id: string; run_id: string }) => void }) {
  const [text, set_text] = useState("");
  const [sending, set_sending] = useState(false);

  const send = async () => {
    if (!text.trim() || is_running || sending) return;
    set_sending(true);
    const sent = await attempt(() => calls().send_message(context_id, text, conversation_id));
    set_sending(false);
    if (sent) {
      set_text("");
      on_sent(sent);
    }
  };
  const on_key_down = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea aria-label="Message" placeholder="Ask CODEX… (Enter sends, Shift+Enter starts a new line)" rows={3} value={text} onChange={(event) => set_text(event.target.value)} onKeyDown={on_key_down} />
      <div className="composer-actions">
        {is_running && conversation_id ? (
          <button type="button" onClick={() => void attempt(() => calls().stop_reply(conversation_id))}>
            <Square size={14} /> Stop
          </button>
        ) : (
          <button type="submit" className="accent solid" disabled={!text.trim() || sending}>
            <Send size={14} /> Send
          </button>
        )}
      </div>
    </form>
  );
}

// ── Switcher ─────────────────────────────────────────────────────────────────

function when_used(conversation: ConversationSummary): string {
  const used = age(Date.parse(conversation.last_used_at) / 1000);
  return conversation.is_running ? `writing… · ${used}` : used;
}

// The conversation shown, a menu of the others in this context (or in none) with when each was used and which are
// being written, and what can be done to the one shown.
function Switcher({ context_id, list, shown, on_pick }: { context_id: string | null; list: ConversationSummary[]; shown: ConversationSummary | null; on_pick: (id: string | null) => void }) {
  const running_elsewhere = list.filter((each) => each.is_running && each.id !== shown?.id).length;
  const holders = shown?.contexts.map((each) => each.id) ?? [];
  const open_list = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    open_context_menu({ clientX: box.left, clientY: box.bottom, preventDefault: () => undefined }, [
      ...list.map((each) => ({ label: each.title, hint: when_used(each), radio: true, checked: each.id === shown?.id, run: () => on_pick(each.id) })),
      { label: "New conversation", separator_before: list.length > 0, run: () => on_pick(null) },
    ]);
  };
  const more: MenuItem[] = shown
    ? [
        { label: "Rename…", run: () => rename_conversation(shown) },
        { label: context_id ? "Move to…" : "Move to a context…", run: () => move_to_context({ id: conversation_item_id(shown.id), title: shown.title }, context_id, holders, (moved_to) => open_conversation(shown.id, [moved_to], null)) },
        { label: "Also add to…", run: () => add_to_contexts({ id: conversation_item_id(shown.id), title: shown.title }, holders) },
        { label: "Save as blueprint", disabled: shown.is_running || shown.message_count === 0, run: () => void attempt(() => calls().save_as_blueprint(shown.id)) },
        { label: "Copy link", run: () => void navigator.clipboard.writeText(shown.link).then(() => toast("Link copied.")) },
        { label: "Delete…", danger: true, separator_before: true, run: () => delete_conversation(shown, () => on_pick(null)) },
      ]
    : [];
  return (
    <div className="assistant-switcher">
      <button type="button" className="assistant-switcher-pick" aria-haspopup="menu" aria-label="Conversations" title="Pick a conversation" onClick={open_list}>
        <span className="assistant-switcher-title">{shown?.title ?? "New conversation"}</span>
        {running_elsewhere > 0 && <span className="badge tone-warn">{running_elsewhere} writing</span>}
        <Icon icon={ChevronDownIcon} />
      </button>
      {shown && (
        <button type="button" className="icon" aria-label="Rename the conversation" title="Rename" onClick={() => rename_conversation(shown)}>
          <Icon icon={EditIcon} />
        </button>
      )}
      <button type="button" className="icon" aria-label="New conversation" title="New conversation" disabled={shown === null} onClick={() => on_pick(null)}>
        <Icon icon={AddIcon} />
      </button>
      {shown && <MenuButton label="More for this conversation" items={more} />}
    </div>
  );
}

// ── Pane ─────────────────────────────────────────────────────────────────────

function NoEngine({ status }: { status: AssistantStatus }) {
  return (
    <div className="assistant-empty">
      <Empty title="No engine is set up" hint={status.problem} />
      <a className="button" href="#/settings">
        Open Settings
      </a>
    </div>
  );
}

// How each reply ended, once each: those of the conversation shown, and those this pane sent, which may end before the
// pane knows which conversation a new one went to.
function use_ends(ended: { error: string; run_id: string } | null): [{ error: string; key: number } | null, (run_id: string) => void] {
  const [end, set_end] = useState<{ error: string; key: number } | null>(null);
  const noted = useRef(new Set<string>());
  const unclaimed = useRef(new Map<string, string>());
  const awaited = useRef(new Set<string>());
  const note = (run_id: string, error: string) => {
    if (noted.current.has(run_id)) return;
    noted.current.add(run_id);
    set_end((before) => ({ error, key: (before?.key ?? 0) + 1 }));
  };
  useEffect(() => {
    if (ended) note(ended.run_id, ended.error);
  }, [ended]);
  useEffect(
    () =>
      page().on_conversation((event) => {
        if (event.type !== "finished") return;
        if (awaited.current.delete(event.run_id)) note(event.run_id, event.error);
        else unclaimed.current.set(event.run_id, event.error);
        if (unclaimed.current.size > 20) unclaimed.current.delete(unclaimed.current.keys().next().value!);
      }),
    [],
  );
  const sent = (run_id: string) => {
    const error = unclaimed.current.get(run_id);
    if (error === undefined) awaited.current.add(run_id);
    else note(run_id, error);
  };
  return [end, sent];
}

function use_moment(ended: { error: string; key: number } | null): { mood: MascotMood; key: number } | null {
  const [moment, set_moment] = useState<{ mood: MascotMood; key: number } | null>(null);
  useEffect(() => {
    const mood = ended ? moment_after(ended.error) : null;
    if (ended && mood) set_moment({ mood, key: ended.key });
  }, [ended]);
  return moment;
}

// Which conversation the pane shows on this context: the one picked or asked for, else the most recently used; null
// for a new one not yet sent to.
function use_shown(context_id: string | null, list: ConversationSummary[] | null | undefined): [string | null, (id: string | null) => void, () => void] {
  const [choice, set_choice] = useState<{ context_id: string | null; id: string | null } | null>(null);
  const asked = use_watch(wanted_watch);
  useEffect(() => {
    const id = take_wanted(context_id);
    if (id) set_choice({ context_id, id });
  }, [asked, context_id]);
  const picked = choice && choice.context_id === context_id ? choice.id : undefined;
  const shown = picked === undefined ? (list?.[0]?.id ?? null) : picked;
  return [shown, (id) => set_choice({ context_id, id }), () => set_choice(null)];
}

export function AssistantPane({ context_id }: { context_id: string | null }) {
  const status = use_data((api) => api.get_assistant_status());
  const list = use_data((api) => api.list_conversations(context_id), [context_id]);
  const [shown_id, pick, forget_pick] = use_shown(context_id, list.data);
  const { conversation, run, ended } = use_conversation(shown_id);
  const [end, on_sent_run] = use_ends(ended);
  // One picked that has gone, such as one deleted on another device, gives way to the most recent.
  useEffect(() => {
    if (conversation.status === "failed") forget_pick();
  }, [conversation.status]);
  const moment = use_moment(end);
  const list_end = useRef<HTMLDivElement>(null);
  const engine = status.data?.engine ?? null;
  const is_running = run !== null && !run.finished;
  const mood = lasting_mood({ has_engine: engine !== null, is_reachable: status.status !== "failed" && conversation.status !== "failed", is_running });
  const data = shown_id ? conversation.data : null;
  const shown = list.data?.find((each) => each.id === shown_id) ?? data ?? null;
  const waiting = data?.proposals.filter((proposal) => proposal.status === "waiting") ?? [];
  const decided = new Map((data?.proposals ?? []).map((proposal) => [proposal.id, proposal.status]));
  const undo_list = use_data((api) => (shown_id ? api.list_change_undos(shown_id) : Promise.resolve([])), [shown_id]);
  const undos: Undos = new Map((undo_list.data ?? []).map((each) => [`${each.message_id}:${each.call_id}`, each]));
  const collectors = use_data((api) => api.list_collectors());
  const blueprint_proposals = use_data((api) => (shown_id ? api.list_blueprint_proposals(shown_id) : Promise.resolve([])), [shown_id]);
  const label_of = (source: string) => collectors.data?.find((each) => each.id === source)?.label ?? source;
  const asked_text = (id: string) => data?.messages.find((message) => message.id === id)?.text ?? null;
  const count = (data?.messages.length ?? 0) + waiting.length + (blueprint_proposals.data?.length ?? 0) + (run ? 1 : 0);

  // In braces, since a browser's scrollIntoView may give back a promise, which React would take for a cleanup.
  useEffect(() => {
    list_end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  return (
    <div className="assistant">
      <header className="assistant-head">
        <Mascot mood={mood} moment={moment} />
        <p className="muted small">
          {engine ? [run?.engine || engine.label, run?.model || engine.model].filter(Boolean).join(" · ") : status.status === "failed" ? "CODEX cannot be reached." : "Asleep"}
          {engine && " "}
          {engine && <span className={`badge tone-${engine.is_local ? "none" : "warn"}`} title={engine.is_local ? "Answers on this computer or your own network." : "Answers from a company's servers; it is sent only the items of sources you marked for it."}>{engine.is_local ? "local" : "hosted"}</span>}
        </p>
        <Switcher context_id={context_id} list={list.data ?? []} shown={shown} on_pick={pick} />
      </header>
      {status.data && !engine && <NoEngine status={status.data} />}
      <div className="assistant-messages">
        {shown_id && !data ? (
          <Skeleton lines={3} />
        ) : (
          <>
            {!data?.messages.length && !run && engine && (
              <p className="muted small">{context_id ? "A new conversation about this context: ask about it, or ask CODEX to change it." : "No context is open, so this conversation will be in no context."}</p>
            )}
            {data?.messages.map((message) => (
              <Message key={message.id} message={message} decided={decided} undos={undos} />
            ))}
            {run && <Reply run={run} />}
            {waiting.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} asked={asked_text(proposal.evidence.asked_by)} label_of={label_of} />
            ))}
            {!run && (blueprint_proposals.data ?? []).map((proposal) => (
              <BlueprintProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </>
        )}
        <div ref={list_end} />
      </div>
      {engine && <Composer key={shown_id ?? "new"} context_id={context_id} conversation_id={shown_id} is_running={is_running} on_sent={(sent) => (pick(sent.conversation_id), on_sent_run(sent.run_id))} />}
    </div>
  );
}
