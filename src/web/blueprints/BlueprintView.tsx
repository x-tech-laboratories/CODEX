// One blueprint in the workspace: its title, when it applies and its rules and steps, edited by the user and saved as
// a version in History; where it applies, its uses, the changes proposed to it, and retiring or deleting it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog, Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { HistoryIcon, Icon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { FormRow, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { RichText } from "@x-tech-laboratories/x-libs/web/react/rich_text";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { ScrollText } from "lucide-react";

import { blueprint_route, type Blueprint, type BlueprintStatus } from "../../shared/blueprints/model.ts";
import { global_context_id, global_first, type ContextSummary } from "../../shared/contexts/model.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";
import { open_item_history } from "../history/HistoryView.tsx";
import { BlueprintProposalCard } from "./ProposalCard.tsx";

// ── Actions ──────────────────────────────────────────────────────────────────

export const status_words: Record<BlueprintStatus, [words: string, tone: "warn" | "good" | "none"]> = {
  proposed: ["Proposed", "warn"],
  active: ["Active", "good"],
  retired: ["Retired", "none"],
};

export function StatusBadge({ status }: { status: BlueprintStatus }) {
  const [words, tone] = status_words[status];
  return <Badge tone={tone}>{words}</Badge>;
}

function BlueprintFields({ title, applies_when, body, on_change }: { title: string; applies_when: string; body: string; on_change: (field: "title" | "applies_when" | "body", value: string) => void }) {
  return (
    <>
      <FormRow label="Title" id="blueprint-title">
        <input id="blueprint-title" value={title} maxLength={120} onChange={(event) => on_change("title", event.target.value)} />
      </FormRow>
      <FormRow label="Applies when" id="blueprint-applies" hint="One sentence naming the task; the assistant is given this blueprint when your message matches it.">
        <textarea id="blueprint-applies" rows={2} maxLength={400} value={applies_when} onChange={(event) => on_change("applies_when", event.target.value)} />
      </FormRow>
      <RichText label="Rules and steps" placeholder="The rules to keep, then the steps in order." value={body} on_change={(markdown) => on_change("body", markdown)} />
    </>
  );
}

// Asks for a new blueprint's text and writes it, active at once, in the context given or everywhere, then opens it.
export function new_blueprint(context: { id: string; name: string } | null): void {
  open_dialog((close) => <NewBlueprintDialog context={context} on_close={close} />);
}

function NewBlueprintDialog({ context, on_close }: { context: { id: string; name: string } | null; on_close: () => void }) {
  const [text, set_text] = useState({ title: "", applies_when: "", body: "" });
  return (
    <Dialog
      title="New blueprint"
      subtitle={context && context.id !== global_context_id ? `Applies in ${context.name} and the contexts inside it` : "Applies everywhere"}
      on_close={on_close}
      form={{
        submit_label: "Add",
        on_submit: (event) => {
          event.preventDefault();
          void attempt(() => calls().add_blueprint(text.title, text.applies_when, text.body, context?.id ?? null)).then((id) => {
            if (!id) return;
            on_close();
            window.location.hash = blueprint_route(id).slice(1);
          });
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <BlueprintFields {...text} on_change={(field, value) => set_text((before) => ({ ...before, [field]: value }))} />
    </Dialog>
  );
}

export function delete_blueprint(blueprint: { id: string; title: string }, on_deleted?: () => void): void {
  confirm_dialog({
    title: `Delete ${blueprint.title}?`,
    message: "It is deleted with the changes proposed to it; History keeps its versions, so it can be brought back.",
    confirm_label: "Delete",
    busy_label: "Deleting…",
    danger: true,
    run: async () => {
      if (await succeeds(() => calls().remove_blueprint(blueprint.id))) on_deleted?.();
    },
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

function Page({ blueprint, contexts }: { blueprint: Blueprint; contexts: ContextSummary[] }) {
  const [text, set_text] = useState({ title: blueprint.title, applies_when: blueprint.applies_when, body: blueprint.body });
  const [saving, set_saving] = useState(false);
  // What another page or device saved shows, unless the user is part way through an edit.
  const [kept, set_kept] = useState(blueprint);
  useEffect(() => {
    const untouched = text.title === kept.title && text.applies_when === kept.applies_when && text.body === kept.body;
    if (untouched) set_text({ title: blueprint.title, applies_when: blueprint.applies_when, body: blueprint.body });
    set_kept(blueprint);
  }, [blueprint.updated_at]);
  const proposals = use_data(async (api) => (await api.list_blueprint_proposals()).filter((each) => each.blueprint_id === blueprint.id && each.kind === "change"), [blueprint.id]);
  const changed = text.title !== blueprint.title || text.applies_when !== blueprint.applies_when || text.body !== blueprint.body;
  const save = async () => {
    set_saving(true);
    await succeeds(() => calls().change_blueprint(blueprint.id, text), blueprint.status === "proposed" ? "Saved; the blueprint is active." : "Saved.");
    set_saving(false);
  };
  const placed = blueprint.contexts.length === 1 ? blueprint.contexts[0]!.id : blueprint.contexts.length === 0 ? global_context_id : "";
  // Global's blueprints apply everywhere, so its row says so.
  const where_options: [string, string][] = global_first(contexts).map((context): [string, string] => [context.id, context.id === global_context_id ? `Everywhere (${context.name})` : context.name]);
  const go_back = () => (window.location.hash = blueprint.contexts[0] ? `/context/${blueprint.contexts[0].id}` : "/blueprints");
  const uses = blueprint.use_count === 0 ? "Not used yet." : (
    <>
      Used {blueprint.use_count} {blueprint.use_count === 1 ? "time" : "times"}, last <Age epoch={Date.parse(blueprint.last_used_at) / 1000} />.
    </>
  );
  return (
    <>
      <PageHeading
        title={blueprint.title}
        icon={<Icon icon={ScrollText} />}
        subtitle={
          <>
            <StatusBadge status={blueprint.status} /> {uses}
          </>
        }
        actions={
          <>
            {blueprint.status === "active" && <button type="button" onClick={() => void succeeds(() => calls().retire_blueprint(blueprint.id), "Retired; it is no longer recalled.")}>Retire</button>}
            {blueprint.status === "retired" && <button type="button" onClick={() => void succeeds(() => calls().restore_blueprint(blueprint.id), "Brought back; it is recalled again.")}>Bring back</button>}
            <button type="button" className="icon" aria-label="History" title="History" onClick={() => open_item_history("blueprint", blueprint.id, blueprint.title)}>
              <Icon icon={HistoryIcon} />
            </button>
            <button type="button" className="danger" onClick={() => delete_blueprint(blueprint, go_back)}>
              Delete…
            </button>
          </>
        }
      />
      {blueprint.status === "proposed" && (
        <Section title="Waiting for you">
          <BlueprintProposalCard
            show_open={false}
            proposal={{ ...blueprint, kind: "new", blueprint_id: blueprint.id, before: null, reason: "" }}
          />
        </Section>
      )}
      {(proposals.data ?? []).length > 0 && (
        <Section title="Changes proposed">
          {proposals.data!.map((proposal) => (
            <BlueprintProposalCard key={proposal.id} proposal={proposal} show_open={false} />
          ))}
        </Section>
      )}
      <Section title="Where it applies">
        {blueprint.contexts.length > 1 ? (
          <p className="small">In {blueprint.contexts.map((each) => each.name).join(", ")} and the contexts inside them.</p>
        ) : (
          <Select<string> bare label="Where it applies" options={where_options} value={placed} on_change={(value) => void succeeds(() => calls().place_blueprint(blueprint.id, value || null))} />
        )}
      </Section>
      <Section title="The blueprint" class_name="blueprint-editor">
        <BlueprintFields {...text} on_change={(field, value) => set_text((before) => ({ ...before, [field]: value }))} />
        <div className="proposal-actions">
          <button type="button" className="accent solid" disabled={!changed || saving} onClick={() => void save()}>
            {blueprint.status === "proposed" ? "Save and make active" : "Save"}
          </button>
          <button type="button" disabled={!changed || saving} onClick={() => set_text({ title: blueprint.title, applies_when: blueprint.applies_when, body: blueprint.body })}>
            Discard changes
          </button>
        </div>
        <p className="muted small">
          {blueprint.made_by === "user" ? "You wrote it." : blueprint.made_by === "program" ? "A program wrote it." : `The assistant wrote it${blueprint.engine ? ` (${[blueprint.engine, blueprint.model].filter(Boolean).join(" · ")})` : ""}.`}{" "}
          The assistant is given it when your message matches when it applies, and says which blueprint it follows.
        </p>
      </Section>
    </>
  );
}

export function BlueprintView({ id }: { id: string }) {
  const detail = use_data(async (api) => ({ blueprint: await api.get_blueprint(id), contexts: await api.list_contexts(false) }), [id]);
  return <Loaded resource={detail}>{({ blueprint, contexts }) => <Page key={blueprint.id} blueprint={blueprint} contexts={contexts} />}</Loaded>;
}
