// Choosing an engine's model from the models its endpoint lists: a field in Settings that still takes any name typed,
// and a compact picker beside the engine in the assistant pane. A model a server must load first answers slowly once.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { PluginHost, PluginManifest, SettingField } from "@x-tech-laboratories/x-libs/plugins";
import { StateBadge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { CommitInput, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { use_plugins, type PluginStatus } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { ComboField } from "@x-tech-laboratories/x-libs/web/react/suggestions";

import type { EngineSummary } from "../../shared/conversations/model.ts";
import type { EndpointModel, ModelState } from "../../shared/engines/engine.ts";
import type { EngineModels } from "../../shared/engines/store.ts";
import { attempt, calls } from "../api.ts";
import { use_declared } from "../declared/declared.tsx";
import { start_page_plugins } from "../plugins/plugins.tsx";

// ── Data ─────────────────────────────────────────────────────────────────────

// The models an engine's endpoint lists, asked again when the model or `again` changes rather than on every change,
// since each asks the endpoint.
export function use_engine_models(plugin_id: string, again: unknown[] = []) {
  return use_resource<EngineModels>(() => calls().list_engine_models(plugin_id), [plugin_id, ...again]);
}

const state_words: Record<Exclude<ModelState, "">, string> = { loaded: "loaded", loading: "loading", unloaded: "not loaded", failed: "failed to load" };

// A model's name with what its server says of it, such as "qwen3 (loaded)".
export function model_label(model: EndpointModel): string {
  return model.state ? `${model.id} (${state_words[model.state]})` : model.id;
}

// Whether the next reply with this model may wait while its server loads it: it is listed as not loaded, or, where
// the server does not say, it was only just chosen.
export function may_load(listing: EngineModels | null, model: string, just_chosen: boolean): boolean {
  const found = listing?.models.find((each) => each.id === model);
  if (found?.state) return found.state !== "loaded";
  return just_chosen;
}

export const loading_note = "The first reply after a switch may take a minute or more while the server loads the model.";

// Keeps the choice: for a declared engine on this device, over its declared model; for any other in its settings,
// through the page's plugin host so the rest of its settings, written whole, keep it.
export async function choose_model(plugin_id: string, model: string, is_declared: boolean): Promise<void> {
  if (is_declared) await calls().set_engine_model(plugin_id, model);
  else await (await start_page_plugins()).set_settings(plugin_id, { model: model.trim() });
}

// ── Settings ─────────────────────────────────────────────────────────────────

// The model as a choice from the endpoint's list, any name still typed and kept on Enter, a pick or leaving the field.
export function ModelField({ plugin_id, value, placeholder, on_choose }: { plugin_id: string; value: string; placeholder?: string; on_choose: (model: string) => void }) {
  const listing = use_engine_models(plugin_id, [value]);
  const [draft, set_draft] = useState(value);
  useEffect(() => set_draft(value), [value]);
  const keep = (model: string) => {
    set_draft(model);
    if (model.trim() !== value) on_choose(model.trim());
  };
  const models = listing.data?.models ?? [];
  return (
    <span className="model-field">
      <ComboField label="Model" value={draft} options={models.map((model) => model.id)} placeholder={placeholder} on_change={set_draft} on_take={keep} on_enter={() => keep(draft)} on_blur={() => keep(draft)} />
      {models.length > 0 ? (
        <span className="muted small">{models.map(model_label).join(", ")}</span>
      ) : (
        listing.data?.problem && <span className="muted small">{listing.data.problem}</span>
      )}
    </span>
  );
}

const model_hint = "The model's name on that endpoint: pick one it lists, or type any name it takes.";

// A declared engine's model: the declared one is the default, and a choice here holds over it on this device alone.
export function DeclaredModelRow({ plugin_id, field }: { plugin_id: string; field: SettingField }) {
  const listing = use_engine_models(plugin_id);
  const data = listing.data;
  if (!data) return null;
  const chosen = data.model !== data.declared_model;
  return (
    <SettingRow
      label={field.label}
      hint={`${model_hint} This computer's configuration declares ${data.declared_model || "none"}; a model chosen here holds over it on this device. ${loading_note}`}
    >
      <ModelField plugin_id={plugin_id} value={data.model} on_choose={(model) => void attempt(() => choose_model(plugin_id, model, true)).then(() => listing.reload(true))} />
      {chosen && data.declared_model && (
        <button type="button" onClick={() => void attempt(() => choose_model(plugin_id, "", true)).then(() => listing.reload(true))}>
          Use {data.declared_model}
        </button>
      )}
    </SettingRow>
  );
}

// Each plugin state's words and tone, as PluginSettings shows them.
const plugin_states: Parameters<typeof StateBadge<PluginStatus["state"]>>[0]["labels"] = {
  running: ["On", "good"],
  off: ["Off", "none"],
  waiting: ["Waiting", "warn"],
  failed: ["Failed", "bad"],
  unsupported: ["Unsupported", "bad"],
};

function FieldControl({ field, value, on_change }: { field: SettingField; value: unknown; on_change: (value: string | number | boolean) => void }) {
  if (field.type === "switch") return <Switch label={field.label} checked={value === true} on_change={on_change} />;
  if (field.type === "choice") return <Select bare label={field.label} options={field.choices.map((choice): [string, string] => [choice.value, choice.label])} value={String(value)} on_change={on_change} />;
  if (field.type === "number")
    return (
      <CommitInput
        type="number"
        value={Number(value)}
        min={field.min}
        max={field.max}
        step={field.step}
        on_commit={(event) => Number.isFinite(event.currentTarget.valueAsNumber) && on_change(event.currentTarget.valueAsNumber)}
      />
    );
  return (
    <CommitInput
      type={field.secret ? "password" : "text"}
      autoComplete={field.secret ? "off" : undefined}
      value={String(value)}
      placeholder={field.placeholder}
      on_commit={(event) => on_change(event.currentTarget.value)}
    />
  );
}

// An engine's own settings as X-Libs' PluginSettings lays them out, its model a choice from the endpoint's list.
export function EngineSettings({ host, manifest }: { host: PluginHost; manifest: PluginManifest }) {
  const status = use_plugins(host).find((each) => each.manifest.id === manifest.id);
  if (!status) return null;
  const values = host.settings(manifest.id);
  const running = status.state === "running";
  return (
    <>
      <SettingRow
        label={
          <>
            {manifest.name} <span className="setting-hint">{manifest.version}</span> <StateBadge labels={plugin_states} state={status.state} title={status.problem} />
          </>
        }
        hint={status.problem ?? manifest.description}
      >
        <Switch
          label={`Turn ${manifest.name} on`}
          checked={status.state !== "off" && status.state !== "unsupported"}
          on_change={(on) => void (on ? host.enable(manifest.id) : host.disable(manifest.id))}
        />
      </SettingRow>
      {(manifest.settings ?? []).map((field) =>
        field.key === "model" && field.type === "text" && running ? (
          <SettingRow key={field.key} label={field.label} hint={`${model_hint} ${loading_note}`}>
            <ModelField plugin_id={manifest.id} value={String(values.model ?? "")} placeholder={field.placeholder} on_choose={(model) => void host.set_settings(manifest.id, { model })} />
          </SettingRow>
        ) : (
          <SettingRow key={field.key} label={field.label} hint={field.hint} as_label={field.type !== "choice"}>
            <FieldControl field={field} value={values[field.key] ?? field.default} on_change={(value) => void host.set_settings(manifest.id, { [field.key]: value })} />
          </SettingRow>
        ),
      )}
    </>
  );
}

// ── The pane ─────────────────────────────────────────────────────────────────

// The engine answering and its model, a compact picker when its endpoint lists models, with a note while the model
// chosen may still have to load. `writing` is the model of the reply being written, which the picker does not change.
export function PaneModel({ engine, writing, is_running }: { engine: EngineSummary; writing: string; is_running: boolean }) {
  const declared = use_declared().plugins.some((plugin) => plugin.plugin_id === engine.plugin_id);
  const listing = use_engine_models(engine.plugin_id, [engine.model, is_running]);
  const [just_chosen, set_just_chosen] = useState(false);
  useEffect(() => {
    if (!is_running) set_just_chosen(false);
  }, [is_running]);
  const models = listing.data?.models ?? [];
  if (models.length === 0) return <>{[engine.label, writing || engine.model].filter(Boolean).join(" · ")}</>;
  const options: [string, string][] = models.map((model): [string, string] => [model.id, model_label(model)]);
  if (!models.some((model) => model.id === engine.model)) options.unshift([engine.model, engine.model || "No model"]);
  const pick = (model: string) =>
    void attempt(() => choose_model(engine.plugin_id, model, declared)).then(() => {
      set_just_chosen(true);
      void listing.reload(true);
    });
  return (
    <>
      {engine.label} · {writing && writing !== engine.model ? `${writing} → ` : ""}
      <span className="pane-model">
        <Select label="Model" bare options={options} value={engine.model} on_change={pick} />
      </span>
      {may_load(listing.data, engine.model, just_chosen) && <span className="pane-model-note">{loading_note}</span>}
    </>
  );
}
