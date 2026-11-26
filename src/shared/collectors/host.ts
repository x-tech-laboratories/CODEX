// The store's side of the plugins: an X-Libs plugin host whose plugins provide collectors and engines, with every plugin's on or off
// and settings kept in the synced settings. The server and the desktop daemon hand over their plugins once at start,
// since a collector such as Files needs Node and so cannot live in this folder.

// ── Imports ──────────────────────────────────────────────────────────────────

import { create_plugin_host, type Plugin, type PluginHost, type PluginRecords, type PluginStorage } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { conversations_plugin } from "../conversations/collector.ts";
import type { Embedder } from "../embedders/embedder.ts";
import type { Engine } from "../engines/engine.ts";
import { settings_feature } from "../settings.ts";
import { item_sources_plugin } from "../sources/collector.ts";
import { app_info, plugins_setting, type Collector } from "./collector.ts";

// ── Api ──────────────────────────────────────────────────────────────────────

// A plugin provides collectors, which bring items from other apps, engines, which answer the conversations, or
// embedders, which turn text into vectors for the search index.
export interface ContextPluginApi {
  providers: { collector: Collector; engine: Engine; embedder: Embedder };
}

export type ContextPlugin = Plugin<ContextPluginApi>;

// ── Storage ──────────────────────────────────────────────────────────────────

export function plugin_records(database: SqlDatabase): PluginRecords {
  const saved = settings_feature.methods.get_settings(database)[plugins_setting];
  return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as PluginRecords) : {};
}

function settings_storage(database: SqlDatabase): PluginStorage {
  return {
    read: () => plugin_records(database),
    write: (records) => settings_feature.methods.set_setting(database, plugins_setting, records),
  };
}

// ── Host ─────────────────────────────────────────────────────────────────────

let known_plugins: ContextPlugin[] = [];

// The plugins every host starts, bundled and from the plugins folder; set once where the store runs.
export function use_plugins(plugins: ContextPlugin[]): void {
  known_plugins = plugins;
}

// Made afresh for each use, so a plugin turned on or off on any device, or given a new key, holds at once. The apps
// read through the item calls and the conversations' own collector come last, answering from this database.
export async function open_plugin_host(database: SqlDatabase): Promise<PluginHost<ContextPluginApi>> {
  const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: settings_storage(database), on_error: (plugin_id, error) => console.warn(`plugin ${plugin_id}:`, error) });
  for (const plugin of known_plugins) await host.add(plugin);
  await host.add(item_sources_plugin(database));
  await host.add(conversations_plugin(database));
  await host.start();
  return host;
}
