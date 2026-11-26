// The assistant's pane on the right: its face and the engine answering, the open context's conversation (the general
// one with no context open) with the reply streaming in, the changes waiting for the user, and the message box.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FormGroup } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Empty, Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";
import { Send, Square, Trash2 } from "lucide-react";

import type { AssistantStatus, ConversationMessage, ToolCallRecord } from "../../shared/conversations/model.ts";
import type { Proposal } from "../../shared/policy/model.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";
import { Mascot } from "./Mascot.tsx";
import { lasting_mood, moment_after, type MascotMood } from "./mascot.ts";
import { use_conversation, type LiveRun } from "./use_conversation.ts";

// ── Tool calls ───────────────────────────────────────────────────────────────

const outcome_words: Record<ToolCallRecord["outcome"], string> = {
  pending: "running",
  ran: "done",
  proposed: "waits for you",
  refused: "not permitted",
  failed: "failed",
};

const outcome_tones: Record<ToolCallRecord["outcome"], string> = { pending: "none", ran: "good", proposed: "warn", refused: "bad", failed: "bad" };

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// One call the engine made, folded to its name and outcome; open, its arguments and what came back.
export function ToolCallRow({ call }: { call: ToolCallRecord }) {
  const made_by = call.applied_by === "user_approval" ? "approved by you" : call.applied_by === "engine_auto" ? "made by the assistant" : "";
  return (
    <FormGroup
      class_name="tool-call"
      summary={
        <span className="tool-call-summary">
          <code>{call.name}</code>
          <span className={`badge tone-${outcome_tones[call.outcome]}`}>{outcome_words[call.outcome]}</span>
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
}

// ── Messages ─────────────────────────────────────────────────────────────────

function Message({ message }: { message: ConversationMessage }) {
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
          <ToolCallRow key={call.id} call={call} />
        ))}
      </div>
    );
  }
  return (
    <div className="chat-message from-assistant">
      {message.tool_calls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
      {message.text && <Markdown text={message.text} />}
      {message.error && <p className={message.error === "Stopped." ? "muted small" : "tone-bad"}>{message.error}</p>}
      {message.engine && <p className="muted small">{[message.engine, message.model].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

function Reply({ run }: { run: LiveRun }) {
  return (
    <div className="chat-message from-assistant" aria-live="polite" aria-busy={!run.finished}>
      {run.tool_calls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
      {run.text ? <Markdown text={run.text} follow /> : <p className="muted small">Thinking…</p>}
    </div>
  );
}

// ── Proposals ────────────────────────────────────────────────────────────────

// A change waiting for the user, with what it would do in plain words.
export function ProposalCard({ proposal }: { proposal: Proposal }) {
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

function Composer({ context_id, is_running, can_clear }: { context_id: string | null; is_running: boolean; can_clear: boolean }) {
  const [text, set_text] = useState("");
  const [sending, set_sending] = useState(false);

  const send = async () => {
    if (!text.trim() || is_running || sending) return;
    set_sending(true);
    const sent = await attempt(() => calls().send_message(context_id, text));
    set_sending(false);
    if (sent) set_text("");
  };
  const on_key_down = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };
  const clear = () =>
    confirm_dialog({
      title: "Clear this conversation?",
      message: "Every message and proposal in it is deleted. The contexts and items stay as they are.",
      confirm_label: "Clear",
      busy_label: "Clearing…",
      danger: true,
      run: async () => void (await calls().clear_conversation(context_id)),
    });

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
        <button type="button" className="icon" aria-label="Clear the conversation" title="Clear the conversation" disabled={is_running || !can_clear} onClick={clear}>
          <Trash2 size={16} />
        </button>
        {is_running ? (
          <button type="button" onClick={() => void attempt(() => calls().stop_reply(context_id))}>
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

function use_moment(ended: { error: string; key: number } | null): { mood: MascotMood; key: number } | null {
  const [moment, set_moment] = useState<{ mood: MascotMood; key: number } | null>(null);
  useEffect(() => {
    const mood = ended ? moment_after(ended.error) : null;
    if (ended && mood) set_moment({ mood, key: ended.key });
  }, [ended]);
  return moment;
}

export function AssistantPane({ context_id }: { context_id: string | null }) {
  const status = use_data((api) => api.get_assistant_status());
  const { conversation, run, ended } = use_conversation(context_id);
  const moment = use_moment(ended);
  const list_end = useRef<HTMLDivElement>(null);
  const engine = status.data?.engine ?? null;
  const is_running = run !== null && !run.finished;
  const mood = lasting_mood({ has_engine: engine !== null, is_reachable: status.status !== "failed" && conversation.status !== "failed", is_running });
  const data = conversation.data;
  const waiting = data?.proposals.filter((proposal) => proposal.status === "waiting") ?? [];
  const count = (data?.messages.length ?? 0) + waiting.length + (run ? 1 : 0);

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
      </header>
      {status.data && !engine && <NoEngine status={status.data} />}
      <div className="assistant-messages">
        {!data ? (
          <Skeleton lines={3} />
        ) : (
          <>
            {data.messages.length === 0 && !run && engine && <p className="muted small">{context_id ? "Ask about this context, or ask CODEX to change it." : "No context is open, so this is the general conversation."}</p>}
            {data.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {run && <Reply run={run} />}
            {waiting.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
          </>
        )}
        <div ref={list_end} />
      </div>
      {engine && <Composer context_id={context_id} is_running={is_running} can_clear={(data?.messages.length ?? 0) + (data?.proposals.length ?? 0) > 0} />}
    </div>
  );
}
