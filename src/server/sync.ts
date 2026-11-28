// The two shapes a host's sync takes today: the server's exchange every device syncs against, and the desktop's client
// syncing with a server. Each fills the runtime's sync slot.

// ── Imports ──────────────────────────────────────────────────────────────────

import { join } from "node:path";

import { create_sync_client, sync_device_methods } from "@x-tech-laboratories/x-libs/sync_client";
import { file_sync_storage } from "@x-tech-laboratories/x-libs/sync_file_storage";
import type { SyncDeviceMethods } from "@x-tech-laboratories/x-libs/sync_protocol";
import { register_sync_routes } from "@x-tech-laboratories/x-libs/server/sync_routes";

import { settings_store } from "../shared/store.ts";
import type { SyncContext, SyncRole } from "./runtime.ts";

// ── Server ───────────────────────────────────────────────────────────────────

// The exchange every device syncs against; a setting only the user may change syncs only from the user's own devices.
export function sync_hub(context: SyncContext): SyncRole {
  return {
    routes: (api) =>
      register_sync_routes(api, {
        engine: context.engine,
        database: context.database,
        back_up: context.back_up,
        on_change: (request) => context.announce(context.changes.client_id_of(request)),
        device_only: settings_store.is_device_only,
      }),
    start: () => undefined,
    stop: () => undefined,
  };
}

// ── Desktop ──────────────────────────────────────────────────────────────────

// This computer syncing with a server, its state kept in the profile and its status streamed to every window.
export function sync_client_role(device_name: string) {
  return (context: SyncContext): SyncRole & { methods: SyncDeviceMethods } => {
    const sync = create_sync_client({
      engine: context.engine,
      database: context.database,
      storage: file_sync_storage({ file: join(context.profile, "sync.json"), back_up_before_download: context.back_up }),
      data_name: "context data",
      device_name,
      on_remote_change: () => context.announce(),
      on_status: (status) => context.changes.send(JSON.stringify(status), { event: "sync_status" }),
    });
    return { methods: sync_device_methods(sync), before_restore: () => sync.disconnect(), start: () => sync.start(), stop: () => sync.stop() };
  };
}
