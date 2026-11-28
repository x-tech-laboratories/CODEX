// The model the owner chose for an engine this computer's configuration declares, kept on this device alone and never
// synced, since the declared endpoint is this device's. It holds over the declared model, which is only the default.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { device_value, set_device_value } from "../jobs/records.ts";
import { engine_manifests } from "./manifests.ts";

// ── Choices ──────────────────────────────────────────────────────────────────

const key_of = (plugin_id: string) => `engine_model:${plugin_id}`;

// The model chosen for a declared engine on this device; empty when none was, so the declared one holds.
export function chosen_model(database: SqlDatabase, plugin_id: string): string {
  return device_value(database, key_of(plugin_id));
}

export function set_chosen_model(database: SqlDatabase, plugin_id: string, model: string): void {
  set_device_value(database, key_of(plugin_id), model);
}

// Every engine's chosen model by plugin id, leaving out those with none.
export function chosen_models(database: SqlDatabase): Record<string, string> {
  return Object.fromEntries(engine_manifests.map((manifest) => [manifest.id, chosen_model(database, manifest.id)]).filter(([, model]) => model));
}
