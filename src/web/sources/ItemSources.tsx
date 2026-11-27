// Settings → Plugins → Apps: each app read through the standard item calls as a row whose dialog holds its name,
// address and token, whether it answers now, its two marks and Remove, and a row to add another.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";

import { Dialog, SettingsDialogRow, confirm_dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { ItemSourceSummary } from "../../shared/sources/model.ts";
import { attempt, calls, data_watch, succeeds, use_data } from "../api.ts";
import { GuidanceField } from "../guidance/GuidanceField.tsx";
import { SourceMarks } from "../privacy/PrivacySettings.tsx";

// ── Form ─────────────────────────────────────────────────────────────────────

interface Values {
  name: string;
  address: string;
  token: string;
}

// The name, address and token; an app being changed keeps its token while the field is left empty.
function SourceFields({ id, values, on_change, has_token }: { id: string; values: Values; on_change: (values: Values) => void; has_token: boolean }) {
  return (
    <>
      <FormRow label="Name" id={`${id}-name`} hint="What CODEX calls the app, such as X-Tasks.">
        <input id={`${id}-name`} value={values.name} onChange={(event) => on_change({ ...values, name: event.target.value })} />
      </FormRow>
      <FormRow label="Address" id={`${id}-address`} hint="The app's server, such as https://tasks.example.org.">
        <input id={`${id}-address`} type="url" value={values.address} placeholder="https://tasks.example.org" onChange={(event) => on_change({ ...values, address: event.target.value })} />
      </FormRow>
      <FormRow label="Token" id={`${id}-token`} hint={has_token ? "Set. Leave empty to keep it, or give a new read-only token." : "A read-only token made on the app's account page."}>
        <input id={`${id}-token`} type="password" autoComplete="off" value={values.token} onChange={(event) => on_change({ ...values, token: event.target.value })} />
      </FormRow>
    </>
  );
}

function AddSourceDialog({ on_close }: { on_close: () => void }) {
  const [values, set_values] = useState<Values>({ name: "", address: "", token: "" });
  const [busy, set_busy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    set_busy(true);
    const added = await succeeds(() => calls().add_item_source(values.name, values.address, values.token), `${values.name.trim()} added.`);
    set_busy(false);
    if (added) {
      data_watch.bump();
      on_close();
    }
  };
  return (
    <Dialog
      title="Add an app"
      subtitle="Any app that answers the X-Tech item calls, such as another X-app. CODEX only reads it."
      on_close={on_close}
      form={{ on_submit: (event) => void submit(event), submit_label: busy ? "Checking…" : "Add", submit_disabled: busy }}
    >
      <SourceFields id="new-app" values={values} on_change={set_values} has_token={false} />
    </Dialog>
  );
}

// ── An app ───────────────────────────────────────────────────────────────────

function SourceStatus({ id }: { id: string }) {
  const [tick, set_tick] = useState(0);
  const status = use_data((api) => api.get_item_source_status(id), [id, tick]);
  return (
    <SettingRow label="Answers" hint="Whether the app answers the item calls now with the address and token kept.">
      <Loaded resource={status} lines={1}>
        {(found) => <span className={`badge ${found.ok ? "tone-good" : "tone-bad"}`}>{found.message}</span>}
      </Loaded>
      <button type="button" onClick={() => set_tick(tick + 1)}>Check again</button>
    </SettingRow>
  );
}

function SourceDialogBody({ source }: { source: ItemSourceSummary }) {
  const [values, set_values] = useState<Values>({ name: source.name, address: source.address, token: "" });
  const [busy, set_busy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    set_busy(true);
    const saved = await succeeds(() => calls().change_item_source(source.id, values.name, values.address, values.token === "" ? null : values.token), "Saved.");
    set_busy(false);
    if (saved) set_values({ ...values, token: "" });
  };
  const remove = () =>
    confirm_dialog({
      title: `Remove ${source.name}?`,
      message: "CODEX stops reading it. The items it brought stay in their contexts as last seen.",
      confirm_label: "Remove",
      danger: true,
      run: async () => void (await attempt(() => calls().remove_item_source(source.id))),
    });
  return (
    <>
      <form onSubmit={(event) => void save(event)}>
        <SourceFields id={`app-${source.id}`} values={values} on_change={set_values} has_token={source.has_token} />
        <SettingRow label="Save" hint="CODEX checks the app answers before keeping the change.">
          <button type="submit" disabled={busy}>{busy ? "Checking…" : "Save"}</button>
        </SettingRow>
      </form>
      <SourceStatus id={source.id} />
      <SourceMarks plugin_id={source.mark_key} />
      <GuidanceField source={source.collector} />
      <SettingRow label="Remove" hint="Stop reading this app.">
        <button type="button" className="danger" onClick={remove}>Remove…</button>
      </SettingRow>
    </>
  );
}

function kinds_words(source: ItemSourceSummary): string {
  return source.kinds.length ? source.kinds.map((each) => each.label).join(", ") : "No kinds";
}

// A row per app, then a row to add one.
export function ItemSourceRows() {
  const sources = use_data((api) => api.list_item_sources());
  return (
    <Loaded resource={sources} lines={1}>
      {(list) => (
        <>
          {list.map((source) => (
            <SettingsDialogRow key={source.id} name={source.name} status={kinds_words(source)} about={source.address}>
              <SourceDialogBody source={source} />
            </SettingsDialogRow>
          ))}
          <SettingRow label="Apps" hint="Read any app that answers the X-Tech item calls, such as another X-app, with a read-only token. Each is a source of its own, with its own marks.">
            <button type="button" onClick={() => open_dialog((close) => <AddSourceDialog on_close={close} />)}>Add an app…</button>
          </SettingRow>
        </>
      )}
    </Loaded>
  );
}
