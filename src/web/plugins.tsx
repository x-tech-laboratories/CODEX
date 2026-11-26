// The page's side of the plugins: a row in Settings for each collector, whose dialog holds its on or off and its
// settings. On or off and each plugin's settings are the same synced records the store's side reads, so a collector
// turned off here stops everywhere.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { create_plugin_host, define_plugin, type PluginHost, type PluginManifest, type PluginRecords } from "@x-tech-laboratories/x-libs/plugins";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PluginSettings, use_plugins } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";

import { app_info, plugins_setting } from "../shared/collectors/collector.ts";
import { bundled_manifests } from "../shared/collectors/manifests.ts";
import { calls } from "./api.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

// The page side of a collector has only its settings; its work runs where the store does.
const bundled_pages = bundled_manifests.map((manifest) => define_plugin({ ...manifest, start: () => undefined }));

let started: Promise<PluginHost> | null = null;

// Started once, since its records come from the store.
export function start_page_plugins(): Promise<PluginHost> {
  started ??= (async () => {
    const host = create_plugin_host({
      app: app_info,
      storage: {
        read: async () => (await calls().get_settings())[plugins_setting] as PluginRecords | undefined,
        write: (records) => calls().set_setting(plugins_setting, records),
      },
      on_error: (plugin_id, error) => console.warn(`plugin ${plugin_id}:`, error),
    });
    for (const plugin of bundled_pages) await host.add(plugin);
    await host.start();
    return host;
  })();
  return started;
}

// For tests, which each start from nothing.
export function forget_page_plugins(): void {
  started = null;
}

function use_page_plugins(): PluginHost | null {
  const [host, set_host] = useState<PluginHost | null>(null);
  useEffect(() => void start_page_plugins().then(set_host), []);
  return host;
}

// ── Settings ─────────────────────────────────────────────────────────────────

// "Not set up" while a server address or key is empty, so a collector that finds nothing says why.
export function status_of(manifest: PluginManifest, state: string, values: Record<string, unknown>): string {
  if (state === "off") return "Off";
  if (state !== "running") return "Not running";
  return (manifest.settings ?? []).some((field) => field.type === "text" && (field.secret || field.key === "address") && values[field.key] === "") ? "Not set up" : "On";
}

function Rows({ host }: { host: PluginHost }) {
  const statuses = use_plugins(host);
  return (
    <>
      {statuses.map(({ manifest, state }) => (
        <SettingsDialogRow key={manifest.id} name={manifest.name} status={status_of(manifest, state, host.settings(manifest.id))} about={manifest.description}>
          <PluginSettings host={host} plugin_id={manifest.id} heading={null} />
        </SettingsDialogRow>
      ))}
    </>
  );
}

// A row for each collector, each opening its own dialog.
export function CollectorRows() {
  const host = use_page_plugins();
  return host ? <Rows host={host} /> : <Skeleton lines={2} />;
}
