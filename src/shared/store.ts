// The one database every CODEX device keeps: every feature's tables brought up to date, sync set to stamp every
// change, and every feature's calls in one table the page reaches through whichever host it runs on.

// ── Imports ──────────────────────────────────────────────────────────────────

import { page_only_calls, type ApiSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { migrate, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";
import { hide_secrets, keep_secrets, type PluginRecords } from "@x-tech-laboratories/x-libs/plugins";
import { create_sync_engine } from "@x-tech-laboratories/x-libs/sync_engine";

import { plugins_setting } from "./collectors/collector.ts";
import { bundled_manifests } from "./collectors/manifests.ts";

import { contexts_feature } from "./contexts/store.ts";
import { assistant_host, use_assistant_host, type AssistantHost } from "./conversations/host.ts";
import { conversations_feature } from "./conversations/store.ts";
import { graph_feature } from "./graph/store.ts";
import { forget_synced_changes, history_feature, install_history, record_history } from "./history/store.ts";
import { items_feature } from "./items/store.ts";
import { is_read_only, is_user_only_setting_write, page_only_methods, page_only_refusal } from "./page_api.ts";
import { policy_feature } from "./policy/store.ts";
import { privacy_feature } from "./privacy/store.ts";
import { search_feature } from "./search/store.ts";
import { settings_feature } from "./settings.ts";
import { item_sources_setting } from "./sources/model.ts";
import { hide_tokens, keep_tokens } from "./sources/records.ts";
import { sources_feature } from "./sources/store.ts";

// ── Features ─────────────────────────────────────────────────────────────────

export const features = [settings_feature, contexts_feature, history_feature, conversations_feature, policy_feature, privacy_feature, search_feature, graph_feature, items_feature, sources_feature];

export const sync_engine = create_sync_engine({ tables: features.flatMap((feature) => feature.tables), after_apply: forget_synced_changes });

export const setting_defaults = Object.assign({}, ...features.map((feature) => feature.setting_defaults ?? {})) as Record<string, unknown>;

// ── Opening ──────────────────────────────────────────────────────────────────

// Whether opening would change the schema of a database that already holds data, so it can be backed up first.
export function needs_upgrade(database: SqlDatabase): boolean {
  const has_versions = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'").get() !== undefined;
  if (!has_versions) return false;
  const version_of = database.prepare("SELECT version FROM schema_versions WHERE owner = ?");
  return features.some((feature) => ((version_of.get(feature.id) as { version: number } | undefined)?.version ?? 0) < feature.migrations.length);
}

// Brings an open connection up to date and sets sync to stamp every change; run once each time the database opens.
export function open_store(database: SqlDatabase): void {
  database.exec("PRAGMA foreign_keys = ON");
  // Each feature keeps its own schema version, so features grow apart without renumbering each other's steps.
  for (const feature of features) migrate(database, feature.migrations, { owner: feature.id });
  install_history(database);
  sync_engine.install(database);
  for (const feature of features) feature.on_open?.(database);
}

// ── Calls ────────────────────────────────────────────────────────────────────

const all_methods = {
  ...(Object.assign({}, ...features.map((feature) => feature.methods)) as typeof settings_feature.methods &
    typeof contexts_feature.methods &
    typeof history_feature.methods &
    typeof conversations_feature.methods &
    typeof policy_feature.methods &
    typeof privacy_feature.methods &
    typeof search_feature.methods &
    typeof graph_feature.methods &
    typeof items_feature.methods &
    typeof sources_feature.methods),
  // Every setting, the ones never set at their defaults, with plugin keys and apps' tokens hidden from the page and other programs.
  get_settings: (database: SqlDatabase): Record<string, unknown> => {
    const settings: Record<string, unknown> = { ...setting_defaults, ...settings_feature.methods.get_settings(database) };
    const records = settings[plugins_setting] as PluginRecords | undefined;
    const hidden = { ...settings, [item_sources_setting]: hide_tokens(settings[item_sources_setting]) };
    return records ? { ...hidden, [plugins_setting]: hide_secrets(bundled_manifests, records) } : hidden;
  },
  // A plugin key or an app's token sent back hidden keeps the value stored.
  set_setting: (database: SqlDatabase, key: string, value: unknown): void => {
    const stored_settings = settings_feature.methods.get_settings(database);
    const stored = (stored_settings[plugins_setting] ?? {}) as PluginRecords;
    const kept = key === plugins_setting ? keep_secrets(bundled_manifests, stored, value as PluginRecords) : key === item_sources_setting ? keep_tokens(stored_settings[item_sources_setting], value) : value;
    settings_feature.methods.set_setting(database, key, kept);
  },
};

type Bound<Methods> = {
  [Name in keyof Methods]: Methods[Name] extends (database: SqlDatabase, ...args: infer Args) => infer Result ? (...args: Args) => Result : never;
};

// Every call the page can make, as it makes them, without the database.
export type ContextMethods = Bound<typeof all_methods>;

export const method_names = Object.keys(all_methods) as (keyof ContextMethods & string)[];

export { is_read_only };

// What every call does and takes, for programs other than the page, the calls only the user may make marked page-only.
export const context_api = Object.fromEntries(
  Object.entries(Object.assign({}, ...features.map((feature) => feature.api)) as ApiSpec<ContextMethods>).map(([method, spec]) => [method, page_only_methods.has(method) ? { ...spec, page_only: true } : spec]),
) as ApiSpec<ContextMethods>;

// The calls and setting writes only the user at the page may make, as the server's sign-in and both MCP endpoints refuse them.
export const page_only = page_only_calls(context_api, { rule: is_user_only_setting_write, refusal: page_only_refusal });

// The calls run on the database given; after each write the features catch up, the history records what it touched and
// on_change tells the other pages and devices.
export function bind_methods(database: () => SqlDatabase, on_change: () => void): ContextMethods {
  const bound = method_names.map((name) => {
    const method = all_methods[name] as (database: SqlDatabase, ...args: unknown[]) => unknown;
    const call = (...args: unknown[]): unknown => {
      const result = method(database(), ...args);
      if (is_read_only(name)) return result;
      const after_write = () => {
        for (const feature of features) feature.after_write?.(database());
        record_history(database());
        on_change();
      };
      if (result instanceof Promise) return result.then((value: unknown) => (after_write(), value));
      after_write();
      return result;
    };
    return [name, call];
  });
  return Object.fromEntries(bound) as ContextMethods;
}

// ── The assistant ────────────────────────────────────────────────────────────

// Lets runs start where this store runs, changing data through the same calls the page makes and streaming to its pages.
export function start_assistant(options: Omit<AssistantHost, "call">): void {
  use_assistant_host({
    ...options,
    call: async (method, args) => {
      if (!(method_names as string[]).includes(method)) throw new Error(`There is no call ${method}.`);
      const bound = bind_methods(options.database, options.announce) as unknown as Record<string, (...args: unknown[]) => unknown>;
      return bound[method]!(...args);
    },
  });
}

// After the index's own work changed the store, such as links a rule made: History records it and open pages hear of it.
export function after_index_change(database: SqlDatabase): void {
  record_history(database);
  try {
    assistant_host().announce();
  } catch {
    // No assistant host here, so no page to tell.
  }
}
