// The page's side of the plugins: a row in Settings for each collector and each engine, whose dialog holds its on or off
// and its settings. On or off and each plugin's settings are the same synced records the store's side reads, so a
// plugin turned off here stops everywhere.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { create_plugin_host, define_plugin, type PluginHost, type PluginManifest, type PluginRecords } from "@x-tech-laboratories/x-libs/plugins";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { PluginSettings, use_plugins } from "@x-tech-laboratories/x-libs/web/react/plugins";
import { Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";

import { app_info, plugins_setting } from "../shared/collectors/collector.ts";
import { bundled_manifests } from "../shared/collectors/manifests.ts";
import { embedder_manifests } from "../shared/embedders/manifests.ts";
import { engine_manifests } from "../shared/engines/manifests.ts";
import { mcp_manifest, mcp_plugin_id } from "../shared/mcp/model.ts";
import { tool_manifests } from "../shared/tools/manifests.ts";
import { calls } from "./api.ts";
import { SourceMarks } from "./privacy/PrivacySettings.tsx";
import { ItemSourceRows } from "./sources/ItemSources.tsx";
import { McpServerRows } from "./mcp/McpServers.tsx";
import { OtherToolPluginRows, ToolPluginSettings } from "./tools/ToolSettings.tsx";
import { item_sources_plugin_id } from "../shared/sources/model.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

// The page side of a collector, engine or tool plugin has only its settings; its work runs where the store does.
const bundled_pages = [...bundled_manifests, ...engine_manifests, ...embedder_manifests, ...tool_manifests, mcp_manifest].map((manifest) => define_plugin({ ...manifest, start: () => undefined }));

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

// "Not set up" while a server address, key or model is empty, so a collector that finds nothing, or an engine that
// cannot answer, says why.
export function status_of(manifest: PluginManifest, state: string, values: Record<string, unknown>): string {
  if (state === "off") return "Off";
  if (state !== "running") return "Not running";
  const needed = (key: string, secret = false) => secret || key === "address" || key === "model";
  return (manifest.settings ?? []).some((field) => field.type === "text" && needed(field.key, field.secret) && values[field.key] === "") ? "Not set up" : "On";
}

// A collector's row also holds its privacy and trust marks, but for the apps' plugin, whose apps each have their own; a
// tool plugin's holds its marks and its tools.
function Rows({ host, ids, with_marks = false }: { host: PluginHost; ids: Set<string>; with_marks?: boolean }) {
  const statuses = use_plugins(host).filter(({ manifest }) => ids.has(manifest.id));
  return (
    <>
      {statuses.map(({ manifest, state }) => (
        <SettingsDialogRow key={manifest.id} name={manifest.name} status={status_of(manifest, state, host.settings(manifest.id))} about={manifest.description}>
          <PluginSettings host={host} plugin_id={manifest.id} heading={null} />
          {with_marks && tool_ids.has(manifest.id) && state === "running" && <ToolPluginSettings plugin_id={manifest.id} />}
          {with_marks && manifest.id !== item_sources_plugin_id && !tool_ids.has(manifest.id) && manifest.id !== mcp_plugin_id && <SourceMarks plugin_id={manifest.id} />}
        </SettingsDialogRow>
      ))}
    </>
  );
}

const engine_ids = new Set(engine_manifests.map((manifest) => manifest.id));
const embedder_ids = new Set(embedder_manifests.map((manifest) => manifest.id));
const tool_ids = new Set(tool_manifests.map((manifest) => manifest.id));

// A row for each plugin but the engines and embedders, each opening its own dialog, then each tool plugin the page has
// no manifest of, then the MCP servers and the apps read through the item calls, each marked on its own in its dialog.
export function CollectorRows() {
  const host = use_page_plugins();
  const ids = host ? new Set(host.list().map((status) => status.manifest.id).filter((id) => !engine_ids.has(id) && !embedder_ids.has(id))) : null;
  if (!host || !ids) return <Skeleton lines={2} />;
  return (
    <>
      <Rows host={host} ids={ids} with_marks />
      <OtherToolPluginRows known={new Set(host.list().map((status) => status.manifest.id))} />
      <McpServerRows />
      <ItemSourceRows />
    </>
  );
}

// A row for each engine, each opening its own dialog with the engine's model, endpoint and key command.
export function EngineRows() {
  const host = use_page_plugins();
  return host ? <Rows host={host} ids={engine_ids} /> : <Skeleton lines={2} />;
}

// A row for each bundled embedder, each opening its own dialog with its endpoint, model, dimensions and key command.
export function EmbedderRows() {
  const host = use_page_plugins();
  return host ? <Rows host={host} ids={embedder_ids} /> : <Skeleton lines={1} />;
}
