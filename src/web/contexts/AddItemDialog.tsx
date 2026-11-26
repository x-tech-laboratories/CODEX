// Adding items to a context: pick a collector, then search its app, type the item in, or read how to send items to it
// from elsewhere, such as from Thunderbird.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Icon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Segmented, SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";
import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";

import type { CollectorSummary, FoundItem } from "../../shared/collectors/collector.ts";
import { blueprint_collector } from "../../shared/blueprints/model.ts";
import { conversation_collector } from "../../shared/conversations/model.ts";
import { attempt, calls, use_data } from "../api.ts";
import { look_of } from "./kinds.tsx";

// ── Searching ────────────────────────────────────────────────────────────────

type Found = FoundItem & { kept_in: string[] };

function SearchPane({ collector, context_id }: { collector: CollectorSummary; context_id: string }) {
  const [query, set_query] = useState("");
  const [found, set_found] = useState<Found[] | null>(null);
  const [problem, set_problem] = useState("");
  const [busy, set_busy] = useState(false);
  const [added, set_added] = useState<Set<string>>(new Set());

  const search = async (text: string) => {
    set_query(text);
    if (!text.trim()) return set_found(null);
    set_busy(true);
    set_problem("");
    try {
      set_found(await calls().search_collector(collector.id, text));
    } catch (error) {
      set_problem(describe_error(error));
      set_found(null);
    } finally {
      set_busy(false);
    }
  };

  const add = async (item: Found) => {
    const { kept_in: _kept_in, ...found_item } = item;
    if ((await attempt(() => calls().add_item([context_id], collector.id, found_item, ""))) !== undefined) set_added(new Set([...added, item.source_id]));
  };

  return (
    <>
      <SearchBox label={`Search ${collector.label}`} value={query} on_input={(text) => void search(text)} auto_focus />
      {problem && <p className="field-error" role="alert">{problem}</p>}
      {busy && <Skeleton lines={3} />}
      {!busy && found?.length === 0 && <Empty title="Nothing found" hint={`${collector.label} has nothing matching "${query}".`} />}
      {!busy && found && found.length > 0 && (
        <ul className="found-list">
          {found.map((item) => {
            const is_here = item.kept_in.includes(context_id) || added.has(item.source_id);
            return (
              <li key={item.source_id} className="found-row">
                <Icon icon={look_of(item.kind).icon} />
                <div className="found-text">
                  <span>{item.title}</span>
                  {item.snippet && <span className="muted">{item.snippet}</span>}
                </div>
                <button type="button" disabled={is_here} onClick={() => void add(item)}>
                  {is_here ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── Typing in ────────────────────────────────────────────────────────────────

function ManualPane({ collector, context_id, on_done }: { collector: CollectorSummary; context_id: string; on_done: () => void }) {
  const [values, set_values] = useState<Record<string, string>>({});
  const [note, set_note] = useState("");
  const missing = collector.manual_fields.some((field) => field.is_required && !values[field.key]?.trim());

  const submit = async () => {
    if ((await attempt(() => calls().add_manual_item([context_id], collector.id, values, note))) !== undefined) on_done();
  };

  return (
    <form
      className="manual-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {collector.manual_fields.map((field, index) => (
        <FormRow key={field.key} label={field.label} id={`manual-${field.key}`}>
          <input
            id={`manual-${field.key}`}
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            autoFocus={index === 0}
            onChange={(event) => set_values({ ...values, [field.key]: event.target.value })}
          />
        </FormRow>
      ))}
      <FormRow label="Note" id="manual-note" hint="Why it belongs here; may be left empty.">
        <input id="manual-note" value={note} onChange={(event) => set_note(event.target.value)} />
      </FormRow>
      <button type="submit" className="accent solid" disabled={missing}>
        Add
      </button>
    </form>
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────────

function Pane({ collector, context_id, on_done }: { collector: CollectorSummary; context_id: string; on_done: () => void }) {
  if (collector.can_search) return <SearchPane key={collector.id} collector={collector} context_id={context_id} />;
  if (collector.manual_fields.length > 0) return <ManualPane key={collector.id} collector={collector} context_id={context_id} on_done={on_done} />;
  return <p className="muted">{collector.pushed_from || `${collector.label} takes items sent from elsewhere.`}</p>;
}

function AddItemDialog({ context_id, context_name, on_close }: { context_id: string; context_name: string; on_close: () => void }) {
  // Conversations are started in the Assistant pane, not added here.
  const collectors = use_data(async (api) => (await api.list_collectors()).filter((each) => each.id !== conversation_collector && each.id !== blueprint_collector));
  const [picked, set_picked] = useState<string | null>(null);

  return (
    <Dialog title="Add to context" subtitle={context_name} on_close={on_close} wide buttons={<button type="button" onClick={on_close}>Done</button>}>
      <Loaded resource={collectors} empty={<Empty title="No collectors running" hint="Turn one on under Settings → Plugins." />}>
        {(list) => {
          const collector = list.find((each) => each.id === picked) ?? list[0];
          if (!collector) return <Empty title="No collectors running" hint="Turn one on under Settings → Plugins." />;
          return (
            <div className="add-item">
              <Segmented label="Collector" choices={list.map((each) => ({ value: each.id, label: each.label }))} value={collector.id} on_change={set_picked} />
              <Pane collector={collector} context_id={context_id} on_done={on_close} />
            </div>
          );
        }}
      </Loaded>
    </Dialog>
  );
}

export function add_item_dialog(context_id: string, context_name: string): void {
  open_dialog((close) => <AddItemDialog context_id={context_id} context_name={context_name} on_close={close} />);
}
