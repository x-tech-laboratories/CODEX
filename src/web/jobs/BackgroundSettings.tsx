// Settings → Assistant → Background work: the global switch, off by default, today's caps with today's use, and whether
// this device is the one that runs jobs.

// ── Imports ──────────────────────────────────────────────────────────────────

import { NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";

import { background_settings } from "../../shared/jobs/model.ts";
import { calls, page, set_setting, succeeds, use_data } from "../api.ts";

// ── Section ──────────────────────────────────────────────────────────────────

function BackgroundRows() {
  const state = use_data((api) => api.get_background_state());
  const now = state.data;
  if (!now) return null;
  const here = page().host === "web" ? "The server" : "This device";
  return (
    <>
      <SettingRow label="Background work" hint="Lets the assistant run its jobs with nobody present. Off, nothing runs." as_label>
        <Switch label="Background work" checked={now.enabled} on_change={(on) => void succeeds(() => set_setting(background_settings.enabled, on))} />
      </SettingRow>
      <SettingRow
        label={`${here} runs background work`}
        hint={`Only one of your devices and server should, since the data syncs to all of them. ${now.device ? `Runs are recorded as “${now.device}”.` : ""}`}
        as_label
      >
        <Switch label={`${here} runs background work`} checked={now.runs_here} on_change={(on) => void succeeds(() => calls().set_background_device(on))} />
      </SettingRow>
      <SettingRow label="Runs a day" hint={`Every job on every device together. Today: ${now.runs_today}.`}>
        <NumberField label="Runs a day" bare min={0} value={now.daily_runs} on_change={(value) => void succeeds(() => set_setting(background_settings.daily_runs, value ?? 24))} />
      </SettingRow>
      <SettingRow label="Tokens a day" hint={`Read and written by every job's runs together. Today: ${now.tokens_today.toLocaleString()}.`}>
        <NumberField label="Tokens a day" bare min={0} step={1000} value={now.daily_tokens} on_change={(value) => void succeeds(() => set_setting(background_settings.daily_tokens, value ?? 200_000))} />
      </SettingRow>
    </>
  );
}

export const background_section: SettingsSection = {
  id: "background",
  heading: "Background work",
  hint: "Jobs run on a schedule with nobody present: only changes set to “Allowed, even in the background” are made, and the rest wait in the Inbox. Each job has limits of its own, under Jobs.",
  content: <BackgroundRows />,
};
