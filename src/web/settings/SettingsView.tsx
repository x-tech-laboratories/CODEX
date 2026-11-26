// Settings: how often items refresh, history, the assistant's engine and action policy, the collector plugins, the
// search index, import and export, sync with a server on a device, backups, and the desktop app's tray and background
// running.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { BackupSettings } from "@x-tech-laboratories/x-libs/web/react/backup_settings";
import { LocalMcpSettings } from "@x-tech-laboratories/x-libs/web/react/local_mcp_settings";
import { PageHeading, SettingRow, SettingsPage, type SettingsCategory, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { TrustedCertificates } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { SyncSettings } from "@x-tech-laboratories/x-libs/web/react/sync_settings";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import type { DesktopSettings } from "../../shared/desktop.ts";
import { attempt, calls, data_watch, page, set_setting, show_error, use_settings } from "../api.ts";
import { read_picked, save_text } from "../files.ts";
import { engine_section, policy_section } from "../assistant/AssistantSettings.tsx";
import { CollectorRows } from "../plugins.tsx";
import { hosted_log_section } from "../privacy/PrivacySettings.tsx";
import { index_section } from "../search/IndexSettings.tsx";

// ── General ──────────────────────────────────────────────────────────────────

function general_section(settings: Record<string, unknown>, set_setting: (key: string, value: unknown) => Promise<void>): SettingsSection {
  return {
    id: "general",
    heading: "Refreshing",
    hint: "CODEX asks each collector what became of its items, so titles and states stay current and items gone from their apps are marked missing.",
    content: (
      <SettingRow label="Refresh every" hint="0 refreshes only when you ask.">
        <NumberField label="Refresh every" bare unit="minutes" min={0} value={Number(settings.refresh_minutes)} on_change={(minutes) => void set_setting("refresh_minutes", minutes ?? 30)} />
      </SettingRow>
    ),
  };
}

// ── History ──────────────────────────────────────────────────────────────────

function history_section(settings: Record<string, unknown>, set_setting: (key: string, value: unknown) => Promise<void>): SettingsSection {
  return {
    id: "history",
    heading: "History",
    hint: "Every change to a context, its name, notes and the items it holds, is kept, to look back on or restore under History.",
    content: (
      <SettingRow label="Keep changes for" hint="Older changes are pruned; each context always keeps its latest.">
        <NumberField label="Keep changes for" bare unit="days" min={1} value={Number(settings["history.keep_days"])} on_change={(days) => void set_setting("history.keep_days", days ?? 180)} />
      </SettingRow>
    ),
  };
}

// ── Collectors ───────────────────────────────────────────────────────────────

const collectors_section: SettingsSection = {
  id: "plugins",
  heading: "Plugins",
  hint: "Collectors bring items from other apps. Each keeps only a pointer and what it last saw; the item stays in its own app. Each also says whether its items may be sent to a hosted engine, and whether they are trusted.",
  content: <CollectorRows />,
};

// ── Import and export ────────────────────────────────────────────────────────

// The settings an imported file may set; anything else in it is ignored.
const importable_settings = new Set(["refresh_minutes", "history.keep_days", "plugins", "engine", "action_policy", "source_marks", "hosted_log.keep_days", "embedder"]);

function TransferRows() {
  const contexts_picker = useRef<HTMLInputElement>(null);
  const settings_picker = useRef<HTMLInputElement>(null);
  const stamp = () => new Date().toISOString().slice(0, 10);

  const import_contexts = async (event: ChangeEvent<HTMLInputElement>) => {
    const text = await read_picked(event);
    if (text === null) return;
    const done = await attempt(() => calls().import_contexts(text));
    if (done) toast(`Imported ${done.contexts} contexts and ${done.items} items.`, { tone: "good" });
  };
  const import_settings = async (event: ChangeEvent<HTMLInputElement>) => {
    const text = await read_picked(event);
    if (text === null) return;
    const file = JSON.parse(text) as { app?: string; kind?: string; settings?: Record<string, unknown> };
    if (file.app !== "codex" || file.kind !== "settings" || !file.settings) return show_error(new Error("This file is not CODEX's settings."));
    for (const [key, value] of Object.entries(file.settings)) if (importable_settings.has(key)) await attempt(() => calls().set_setting(key, value));
    toast("Settings imported.", { tone: "good" });
  };
  const save_contexts = () => attempt(async () => save_text(`codex-contexts-${stamp()}.json`, JSON.stringify(await calls().export_contexts(), null, 2)));
  const save_settings = () =>
    attempt(async () => {
      const settings = await calls().get_settings();
      save_text(`codex-settings-${stamp()}.json`, JSON.stringify({ app: "codex", kind: "settings", version: 1, exported_at: new Date().toISOString(), settings }, null, 2));
    });

  return (
    <>
      <SettingRow label="Contexts" hint="Every context, the items it holds and the notes on them, as one JSON file.">
        <button type="button" onClick={() => void save_contexts()}>Export</button>
        <button type="button" onClick={() => contexts_picker.current?.click()}>Import</button>
        <input ref={contexts_picker} type="file" accept=".json,application/json" hidden onChange={(event) => void import_contexts(event)} />
      </SettingRow>
      <SettingRow label="Settings" hint="Every setting as one JSON file, with the plugins' keys left out.">
        <button type="button" onClick={() => void save_settings()}>Export</button>
        <button type="button" onClick={() => settings_picker.current?.click()}>Import</button>
        <input ref={settings_picker} type="file" accept=".json,application/json" hidden onChange={(event) => void import_settings(event)} />
      </SettingRow>
    </>
  );
}

const transfer_section: SettingsSection = { id: "transfer", heading: "Import and export", content: <TransferRows /> };

// ── Page ─────────────────────────────────────────────────────────────────────

// A phone's backups wait for a folder it picks; the list is read again once one is, as the folder may already hold some.
function Backups() {
  const { backups, backup_folder } = page();
  const [folder_name, set_folder_name] = useState<string | null>(backup_folder ? null : "");
  useEffect(() => void backup_folder?.get().then(set_folder_name), [backup_folder]);
  if (!backups || folder_name === null) return null;

  const folder_row = backup_folder && (
    <SettingRow label="Backup folder" hint={folder_name || "Pick a folder in the phone's storage, such as Documents, where file managers and sync apps can reach the backups."}>
      <button type="button" onClick={() => void backup_folder.choose().then(set_folder_name)}>
        {folder_name ? "Change" : "Choose"}
      </button>
    </SettingRow>
  );
  return <BackupSettings key={folder_name} device={backups} data_name="context data" on_restored={() => data_watch.bump()} folder_row={folder_row} can_back_up={!backup_folder || folder_name !== ""} />;
}

// The desktop app's own settings, which belong to this computer and do not sync.
function Desktop() {
  const { desktop } = page();
  const [settings, set_settings] = useState<DesktopSettings | null>(null);
  useEffect(() => void desktop?.get_desktop_settings().then(set_settings, show_error), [desktop]);
  if (!desktop || !settings) return null;

  const change = (key: keyof DesktopSettings, on: boolean): void => {
    set_settings({ ...settings, [key]: on });
    void desktop.set_desktop_setting(key, on).catch(show_error);
  };
  return (
    <>
      <SettingRow label="Show tray icon" hint="An icon in the system tray lists your contexts to open, and brings the window back." as_label>
        <Switch label="Show tray icon" checked={settings.show_tray_icon} on_change={(on) => change("show_tray_icon", on)} />
      </SettingRow>
      <SettingRow label="Keep running in the background" hint="Sync, backups and the MCP server carry on with the window closed. Turned off, they stop shortly after the last window closes." as_label>
        <Switch label="Keep running in the background" checked={settings.keep_running_in_background} on_change={(on) => change("keep_running_in_background", on)} />
      </SettingRow>
      <SettingRow label="Start at login" hint="Starts CODEX in the background when you log in, without opening its window." as_label>
        <Switch label="Start at login" checked={settings.start_at_login} disabled={!settings.keep_running_in_background} on_change={(on) => change("start_at_login", on)} />
      </SettingRow>
      <SettingRow label="Quit completely" hint="Closes the window and stops CODEX in the background too, until you open it again.">
        <button type="button" onClick={() => void desktop.quit_completely().catch(show_error)}>Quit completely</button>
      </SettingRow>
    </>
  );
}

// Sync on a device with its own database, and backups of whichever database the page works on.
function data_category(): SettingsCategory[] {
  const { device, backups, backup_folder, certificates, local_mcp, desktop } = page();
  const sections: SettingsSection[] = [
    ...(device ? [{ id: "sync", heading: "Sync", hint: "Keep this device's data alike with your CODEX server.", content: <>
      <SyncSettings device={device} certificates={certificates} subscribe={data_watch.subscribe} data_name="context data" placeholder="https://context.example.org/" />
      {certificates && <TrustedCertificates certificates={certificates} />}
    </> }] : []),
    ...(backups
      ? [{ id: "backups", heading: "Backups", hint: backup_folder ? "Copies of this device's data, kept in a folder you pick." : device ? "Copies of this device's data, kept beside it." : "Copies of the server's data, kept in its data folder. A restore restarts the server.", content: <Backups /> }]
      : []),
    ...(local_mcp
      ? [{ id: "mcp", heading: "MCP server", hint: "Let AI assistants such as Claude Code reach this device's data without the server.", content: <LocalMcpSettings device={local_mcp} name="codex" data_name="read and change your contexts and the items they hold" /> }]
      : []),
    ...(desktop ? [{ id: "desktop", heading: "Desktop", hint: "The tray icon, and what runs while the window is closed.", content: <Desktop /> }] : []),
  ];
  return sections.length ? [{ heading: device ? "This device" : "Server", sections }] : [];
}

export function SettingsView() {
  const settings = use_settings();

  return (
    <>
      <PageHeading title="Settings" />
      <Loaded resource={settings}>
        {(values) => (
          <SettingsPage
            categories={[
              { heading: "General", sections: [general_section(values, set_setting), history_section(values, set_setting), collectors_section, index_section(values), transfer_section] },
              { heading: "Assistant", sections: [engine_section(values), policy_section, hosted_log_section(values, set_setting)] },
              ...data_category(),
            ]}
          />
        )}
      </Loaded>
    </>
  );
}
