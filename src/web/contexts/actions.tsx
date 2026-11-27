// What can be done to a context from anywhere it shows: make one, rename it, archive it or delete it, each asking
// first where it needs to.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { confirm_dialog, Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import type { MenuItem } from "@x-tech-laboratories/x-libs/web/menus";

import { global_context_id } from "../../shared/contexts/model.ts";
import type { ContextSummary } from "../../shared/contexts/model.ts";
import { new_blueprint } from "../blueprints/BlueprintView.tsx";
import { job_dialog } from "../jobs/JobDialog.tsx";
import { attempt, calls, succeeds } from "../api.ts";

// ── Routes ───────────────────────────────────────────────────────────────────

export function context_href(id: string): string {
  return `#/context/${id}`;
}

function go_to(id: string): void {
  window.location.hash = context_href(id).slice(1);
}

// ── Naming ───────────────────────────────────────────────────────────────────

interface NameDialogProps {
  title: string;
  // The field's label; "Name" unless given.
  label?: string;
  // Lets the name be left empty, such as a conversation's, which then goes by its first message.
  allow_empty?: boolean;
  initial: string;
  submit_label: string;
  on_close: () => void;
  // Gives false when it failed, so the dialog stays open with the name typed.
  on_name: (name: string) => Promise<boolean>;
}

export function NameDialog({ title, label = "Name", allow_empty = false, initial, submit_label, on_close, on_name }: NameDialogProps) {
  const [name, set_name] = useState(initial);
  return (
    <Dialog
      title={title}
      on_close={on_close}
      form={{
        submit_label,
        submit_disabled: !allow_empty && !name.trim(),
        on_submit: (event) => {
          event.preventDefault();
          void on_name(name).then((done) => done && on_close());
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FormRow label={label} id="context-name">
        <input id="context-name" value={name} autoFocus onChange={(event) => set_name(event.target.value)} />
      </FormRow>
    </Dialog>
  );
}

// Asks for a name and makes a context, inside the parent given, then opens it.
export function new_context(parent_id: string | null = null): void {
  open_dialog((close) => (
    <NameDialog
      title={parent_id && parent_id !== global_context_id ? "New context inside" : "New context"}
      initial=""
      submit_label="Add"
      on_close={close}
      on_name={async (name) => {
        const id = await attempt(() => calls().add_context(name, parent_id));
        if (id) go_to(id);
        return id !== undefined;
      }}
    />
  ));
}

export function rename_context(context: { id: string; name: string }): void {
  open_dialog((close) => <NameDialog title="Rename context" initial={context.name} submit_label="Rename" on_close={close} on_name={(name) => succeeds(() => calls().rename_context(context.id, name))} />);
}

export function delete_context(context: { id: string; name: string }, on_deleted?: () => void): void {
  confirm_dialog({
    title: `Delete ${context.name}?`,
    message: "The context and every context inside it go, with the conversations no other context holds. The items stay in their own apps, and History can bring the context back without those conversations.",
    confirm_label: "Delete",
    danger: true,
    run: async () => {
      if (await succeeds(() => calls().remove_context(context.id))) on_deleted?.();
    },
  });
}

// The menu a context shows on a right-click or its More button; Global, the root, can only be renamed.
export function context_menu(context: ContextSummary, on_deleted?: () => void): MenuItem[] {
  const shared: MenuItem[] = [
    { label: "New context inside", run: () => new_context(context.id) },
    { label: "New blueprint…", run: () => new_blueprint(context) },
    { label: "New job…", run: () => job_dialog({ context_id: context.id }) },
    { label: "Rename…", run: () => rename_context(context) },
  ];
  if (context.id === global_context_id) return shared;
  return [
    ...shared,
    { label: context.is_archived ? "Bring back" : "Archive", run: () => void succeeds(() => calls().set_context_archived(context.id, !context.is_archived)) },
    { label: "Delete…", danger: true, separator_before: true, run: () => delete_context(context, on_deleted) },
  ];
}
