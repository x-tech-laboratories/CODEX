// Settings → Index: how far the local search index has come, which embedder gives it meaning, and a rebuild.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import type { IndexState } from "../../shared/search/model.ts";
import { calls, set_setting, succeeds, use_data } from "../api.ts";
import { ReplyError } from "../assistant/AssistantPane.tsx";
import { DeclaredChoice, use_declared } from "../declared/declared.tsx";
import { EmbedderRows } from "../plugins/plugins.tsx";

// ── State ────────────────────────────────────────────────────────────────────

const recheck_ms = 3000;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// What the index holds, in words.
export function held_words(state: IndexState): string {
  return `${plural(state.items, "item")}, ${plural(state.contexts, "context")} and ${plural(state.messages, "message")}.`;
}

// How far embedding has come, in words.
export function embedding_words(state: IndexState): string {
  if (!state.embedder) return state.embedder_problem || "No embedder is chosen, so search finds words only.";
  const parts = [`${state.embedded} of ${plural(state.chunks - state.withheld, "piece")} of text embedded`];
  if (state.pending > 0) parts.push(`${state.pending} waiting`);
  if (state.withheld > 0) parts.push(`${state.withheld} never sent, since the embedder is hosted and their sources are not marked for hosted engines`);
  return `${parts.join("; ")}.`;
}

export function StateRows({ state }: { state: IndexState }) {
  return (
    <>
      <SettingRow label="Indexed" hint={state.is_working ? "Indexing now…" : state.last_indexed_at ? `Last brought up to date ${new Date(state.last_indexed_at).toLocaleString()}.` : "Not indexed yet."}>
        <span className="small">{held_words(state)}</span>
      </SettingRow>
      <SettingRow label="Meaning" hint={state.embedder ? `${state.embedder.label}, ${state.embedder.model}, ${state.embedder.is_local ? "local" : "hosted"}.` : "Choose an embedder below to also find what means the same in other words."}>
        <span className="small">{embedding_words(state)}</span>
      </SettingRow>
      {state.last_error && (
        <SettingRow class_name="index-problem" label="Last problem" hint="Indexing carries on; this is what went wrong last time.">
          <ReplyError error={state.last_error} detail={state.last_error_detail} />
        </SettingRow>
      )}
    </>
  );
}

function IndexStateRows() {
  const [tick, set_tick] = useState(0);
  const state = use_data((api) => api.get_index_state(), [tick]);
  const busy = state.data != null && (state.data.is_working || state.data.pending > 0);
  // Read again while it works, since indexing announces nothing as it goes.
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => set_tick((count) => count + 1), recheck_ms);
    return () => clearTimeout(timer);
  }, [busy, tick]);
  return <Loaded resource={state}>{(loaded) => <StateRows state={loaded} />}</Loaded>;
}

// ── Embedder ─────────────────────────────────────────────────────────────────

function EmbedderChoice({ chosen }: { chosen: string }) {
  const state = use_data((api) => api.get_index_state());
  const declared = use_declared().embedder;
  if (declared) return <DeclaredChoice label="Embedder" value={(state.data ?? null)?.embedders?.find((embedder) => embedder.id === declared)?.label ?? declared} />;
  const options: [string, string][] = [["", "None: words only"], ...((state.data ?? null)?.embedders ?? []).map((embedder): [string, string] => [embedder.id, embedder.label])];
  // A chosen embedder that is not running stays listed, so the choice is not lost while its plugin is off.
  if (chosen && !options.some(([id]) => id === chosen)) options.push([chosen, `${chosen} (not running)`]);
  return (
    <SettingRow label="Embedder" hint="Turns text into vectors so search also finds by meaning. Its vectors stay in the index on this device; changing it or its model embeds everything again.">
      <Select label="Embedder" bare options={options} value={chosen} on_change={(embedder) => void set_setting("embedder", embedder)} />
    </SettingRow>
  );
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

function rebuild(): void {
  confirm_dialog({
    title: "Rebuild the index?",
    message: "The search index is thrown away and built again from your contexts, their items and the apps' text, then embedded again. Nothing you keep is changed; search finds less until it is done.",
    confirm_label: "Rebuild",
    busy_label: "Starting…",
    run: async () => {
      if (await succeeds(() => calls().rebuild_index())) toast("Rebuilding the index.", { tone: "good" });
    },
  });
}

// ── Section ──────────────────────────────────────────────────────────────────

export function index_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "index",
    heading: "Index",
    hint: "A search index kept beside your data on this device or server: never synced, never in backups, and safe to delete, since it is rebuilt from what CODEX keeps and the apps' text.",
    content: (
      <>
        <IndexStateRows />
        <EmbedderChoice chosen={String(settings.embedder ?? "")} />
        <EmbedderRows />
        <SettingRow label="Rebuild" hint="Builds the index again from nothing, such as after a problem.">
          <button type="button" onClick={rebuild}>
            Rebuild…
          </button>
        </SettingRow>
      </>
    ),
  };
}
