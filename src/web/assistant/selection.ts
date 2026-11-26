// Which conversation the pane is asked to show, by an item, a search hit or a codex://conversation link: the pane
// takes it once it is open on the context named, and the window opens the pane for it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_watch } from "@x-tech-laboratories/x-libs/web/watch";

import { conversation_route } from "../../shared/conversations/model.ts";
import { context_href } from "../contexts/actions.tsx";

// ── Asked for ────────────────────────────────────────────────────────────────

export interface WantedConversation {
  // The context the pane should be open on when it shows it, or null for no context.
  context_id: string | null;
  id: string;
}

let wanted: WantedConversation | null = null;

// Bumped whenever a conversation is asked for.
export const wanted_watch = create_watch();

export function want_conversation(context_id: string | null, id: string): void {
  wanted = { context_id, id };
  wanted_watch.bump();
}

export function wanted_conversation(): WantedConversation | null {
  return wanted;
}

// Taken by the pane once it shows it.
export function take_wanted(context_id: string | null): string | null {
  if (!wanted || wanted.context_id !== context_id) return null;
  const { id } = wanted;
  wanted = null;
  return id;
}

// Shows a conversation in the pane: on the context open now when it holds it, or else on the first holding it, or the
// first page for one in no context.
export function open_conversation(id: string, holders: string[], open_context: string | null): void {
  const target = open_context !== null && holders.includes(open_context) ? open_context : (holders[0] ?? null);
  want_conversation(target, id);
  const route = target ? context_href(target) : "#/overview";
  if (target !== open_context || window.location.hash.startsWith(conversation_route(id))) window.location.replace(route);
}
