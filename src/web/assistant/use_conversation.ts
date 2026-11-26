// The conversation the pane shows: what the store keeps, with the reply being written laid over it as its events
// arrive, and the end of each reply, for the mascot's moment. A new conversation not yet sent to has nothing to load.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { Resource } from "@x-tech-laboratories/x-libs/web/react/states";

import type { Conversation, ConversationEvent, RunState } from "../../shared/conversations/model.ts";
import { page, use_data } from "../api.ts";

// ── Runs ─────────────────────────────────────────────────────────────────────

// A reply as far as the events have brought it; finished once its end is heard, until the kept message replaces it.
export interface LiveRun extends RunState {
  finished: boolean;
}

// The reply after one event; events for another run start it afresh.
export function next_run(run: LiveRun | null, event: ConversationEvent): LiveRun | null {
  if (event.type === "started") return { run_id: event.run_id, engine: event.engine, model: event.model, started_at: new Date().toISOString(), text: "", tool_calls: [], finished: false };
  const current = run && run.run_id === event.run_id ? run : { run_id: event.run_id, engine: "", model: "", started_at: "", text: "", tool_calls: [], finished: false };
  if (event.type === "text") return { ...current, text: current.text + event.text };
  if (event.type === "tool_call") return { ...current, tool_calls: [...current.tool_calls, event.call] };
  if (event.type === "tool_result") return { ...current, tool_calls: current.tool_calls.map((call) => (call.id === event.call.id ? event.call : call)) };
  return { ...current, finished: true };
}

export interface OpenConversation {
  conversation: Resource<Conversation | null>;
  // The reply being written, from the events or, for a page opened mid-reply, from the store.
  run: LiveRun | null;
  // Bumped as each reply ends, with how it ended.
  ended: { error: string; key: number; run_id: string } | null;
}

export function use_conversation(id: string | null): OpenConversation {
  const conversation = use_data((api) => (id ? api.get_conversation(id) : Promise.resolve(null)), [id]);
  const [live, set_live] = useState<LiveRun | null>(null);
  const [ended, set_ended] = useState<OpenConversation["ended"]>(null);
  const ends = useRef(0);
  // A page opened mid-reply carries on from what the store said of it.
  const stored_run = useRef<RunState | null>(null);
  stored_run.current = conversation.data?.run ?? null;

  useEffect(() => {
    set_live(null);
    return page().on_conversation((event) => {
      if (event.conversation_id !== id) return;
      set_live((run) => next_run(run ?? (stored_run.current ? { ...stored_run.current, finished: false } : null), event));
      if (event.type === "finished") set_ended({ error: event.error, key: (ends.current += 1), run_id: event.run_id });
    });
  }, [id]);

  // A finished reply gives way once the conversation is loaded again with its message kept.
  const loaded = conversation.data;
  useEffect(() => {
    if (loaded && loaded.run === null) set_live((run) => (run?.finished ? null : run));
  }, [loaded]);

  const stored = loaded?.run ? { ...loaded.run, finished: false } : null;
  const run = live && !(stored && stored.run_id !== live.run_id) ? live : stored;
  return { conversation, run, ended };
}
