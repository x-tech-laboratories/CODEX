// What can be done to an item from anywhere it shows, a conversation included: move it to another context, put it in
// more contexts, and, for a conversation, rename or delete it, asking first.

// ── Imports ──────────────────────────────────────────────────────────────────

import { confirm_dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { pick_list_dialog, type PickableList } from "@x-tech-laboratories/x-libs/web/react/list_picker";

import { blueprint_collector } from "../../shared/blueprints/model.ts";
import { conversation_collector } from "../../shared/conversations/model.ts";
import { attempt, calls, succeeds } from "../api.ts";
import { NameDialog } from "./actions.tsx";

// ── Contexts ─────────────────────────────────────────────────────────────────

async function pickable_contexts(holders: string[]): Promise<PickableList[]> {
  const contexts = await calls().list_contexts(false);
  return contexts.map((context) => ({ id: context.id, name: context.name, holds: holders.includes(context.id) }));
}

async function new_context(name: string): Promise<string> {
  return calls().add_context(name, null);
}

// Puts an item in more contexts, ticking those that hold it already.
export function add_to_contexts(item: { id: string; title: string }, holders: string[]): void {
  pick_list_dialog({
    title: `Also add ${item.title} to`,
    load: () => pickable_contexts(holders),
    add: (context_id) => calls().add_item_to_contexts(item.id, [context_id], ""),
    create: async (name) => {
      const id = await new_context(name);
      await calls().add_item_to_contexts(item.id, [id], "");
      return { id, name, holds: true };
    },
    new_label: "New context",
    empty_text: "No contexts yet.",
  });
}

// Moves an item out of one context into the one picked, or, for a conversation in no context, into it.
export function move_to_context(item: { id: string; title: string }, from_context: string | null, holders: string[], on_moved?: (context_id: string) => void): void {
  const move = async (context_id: string) => {
    if (from_context) await calls().move_item(from_context, item.id, context_id);
    else await calls().add_item_to_contexts(item.id, [context_id], "");
    close();
    on_moved?.(context_id);
  };
  const close = pick_list_dialog({
    title: `Move ${item.title} to`,
    load: () => pickable_contexts(holders),
    add: move,
    create: async (name) => {
      const id = await new_context(name);
      await move(id);
      return { id, name, holds: true };
    },
    new_label: "New context",
    empty_text: "No contexts yet.",
  });
}

// ── Conversations ────────────────────────────────────────────────────────────

export function rename_conversation(conversation: { id: string; title: string; is_named: boolean }): void {
  open_dialog((close) => (
    <NameDialog
      title="Rename conversation"
      label="Title (empty goes back to its first message)"
      allow_empty
      initial={conversation.is_named ? conversation.title : ""}
      submit_label="Rename"
      on_close={close}
      on_name={(title) => succeeds(() => calls().rename_conversation(conversation.id, title))}
    />
  ));
}

export function delete_conversation(conversation: { id: string; title: string }, on_deleted?: () => void): void {
  confirm_dialog({
    title: `Delete ${conversation.title}?`,
    message: "Every message and proposal in it is deleted, from every context holding it. The contexts and their other items stay as they are.",
    confirm_label: "Delete",
    busy_label: "Deleting…",
    danger: true,
    run: async () => {
      if (await succeeds(() => calls().delete_conversation(conversation.id))) on_deleted?.();
    },
  });
}

// Takes an item out of a context; a conversation or blueprint this is the last context of is deleted, once the user agrees.
export function remove_from_context(context_id: string, item: { id: string; title: string; collector: string; source_id: string }, other_holders: number): void {
  if (item.collector === conversation_collector && other_holders === 0) {
    delete_conversation({ id: item.source_id, title: item.title });
    return;
  }
  if (item.collector === blueprint_collector && other_holders === 0) {
    confirm_dialog({
      title: `Delete ${item.title}?`,
      message: "This is the last context it applies in; taking it out deletes it, as it would otherwise apply everywhere. History keeps its versions.",
      confirm_label: "Delete",
      busy_label: "Deleting…",
      danger: true,
      run: async () => void (await succeeds(() => calls().remove_blueprint(item.source_id))),
    });
    return;
  }
  const own = item.collector === conversation_collector || item.collector === blueprint_collector;
  void attempt(() => calls().remove_item(context_id, item.id), own ? "Removed; it stays in its other contexts." : "Removed; the item stays in its app.");
}
