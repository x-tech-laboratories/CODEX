// What every CODEX host runs beside its database, the web server and the desktop daemon alike: the store brought up to
// date and backed up first, the collectors, the declared configuration, the refreshes, the search index, the
// maintenance and the assistant's jobs, the assistant itself, and one order to stop them in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FastifyInstance } from "fastify";
import { keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import type { BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { codex_backup_naming, read_schedule } from "../shared/backups.ts";
import type { RefreshReport } from "../shared/contexts/model.ts";
import { stop_all_runs } from "../shared/conversations/run.ts";
import type { JobRun } from "../shared/jobs/model.ts";
import { keep_running_jobs } from "../shared/jobs/runner.ts";
import { keep_maintaining } from "../shared/maintenance/loop.ts";
import { conversation_event } from "../shared/page_api.ts";
import { keep_indexing, open_index } from "../shared/search/indexer.ts";
import { after_index_change, needs_upgrade, open_store, start_assistant, sync_engine } from "../shared/store.ts";
import { load_collectors } from "./collectors/index.ts";
import { keep_declared } from "./declared.ts";
import { keep_refreshing } from "./refreshing.ts";

// ── Sync ─────────────────────────────────────────────────────────────────────

// What a host's sync is given: the database, the engine stamping its changes, a backup to take before data is replaced,
// the folder its own files go in and how to tell the pages that something changed.
export interface SyncContext {
  database: () => SqlDatabase;
  engine: typeof sync_engine;
  back_up: () => Promise<void>;
  profile: string;
  announce: (client_id?: string) => void;
  changes: EventStream;
}

// One host's sync, whatever its shape: the routes it answers, the calls the page makes on it, and its start and stop.
export interface SyncRole {
  routes?: (api: FastifyInstance) => void;
  // Before a restore replaces the database, so no device's changes land on the data being replaced.
  before_restore?: () => void;
  start: () => void;
  stop: () => void;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface RuntimeOptions<Role extends SyncRole = SyncRole> {
  database_path: string;
  index_path: string;
  backups_folder: string;
  // The folder the host's own files sit in, such as its backup schedule and its sync state.
  profile: string;
  // Each subfolder a plugin, such as a collector for another app; null for none.
  plugins_folder: string | null;
  // The desktop's plugins too, such as Firefox bookmarks, which only a computer with a browser profile can read.
  desktop_plugins: boolean;
  declared_file: string;
  // This host as runs record it, such as "CODEX on odin", and whether it is a desktop app or a server.
  device: string;
  kind: "server" | "desktop";
  // A server stages a restore for its next start, as browsers stay connected through it; the desktop reopens the database.
  restore: "staged" | "reopen";
  // Asked to stop once a restore is staged, so the service starts the server again on the backup.
  stop_soon?: () => void;
  sync: (context: SyncContext) => Role;
  on_refresh_report?: (report: RefreshReport) => void;
  on_job_finished?: (run: JobRun) => void;
}

export interface Runtime<Role extends SyncRole = SyncRole> {
  database: () => DatabaseSync;
  changes: EventStream;
  announce: (client_id?: string) => void;
  backups: BackupMethods;
  sync: Role;
  stop: () => Promise<void>;
}

// ── Starting ─────────────────────────────────────────────────────────────────

function open_database(path: string): DatabaseSync {
  const opened = new DatabaseSync(path);
  opened.exec("PRAGMA journal_mode = WAL");
  return opened;
}

export async function start_runtime<Role extends SyncRole>(options: RuntimeOptions<Role>): Promise<Runtime<Role>> {
  mkdirSync(dirname(options.database_path), { recursive: true });
  // A backup restored on a server waits beside the database until the server starts again.
  const restored = options.restore === "staged" ? take_staged_restore(options.database_path) : false;
  let database = open_database(options.database_path);

  // Every page's event stream, told when the data changed or a reply moved on.
  const changes = new EventStream();
  const announce = (client_id?: string): void => changes.announce_change(client_id);
  // Replies run here, beside the database, and stream to every page as they are written.
  start_assistant({ database: () => database, announce, emit: (event) => changes.send(JSON.stringify(event), { event: conversation_event }) });

  // ── Backups ──

  let sync: Role | null = null;
  const kept = sqlite_backups({
    folder: () => {
      mkdirSync(options.backups_folder, { recursive: true });
      return options.backups_folder;
    },
    naming: codex_backup_naming,
    database: () => database,
    database_path: () => options.database_path,
    ...(options.restore === "staged"
      ? { after_staging: () => void setTimeout(() => options.stop_soon?.(), 500) }
      : {
          close: () => database.close(),
          open: () => {
            database = open_database(options.database_path);
            open_store(database);
          },
          // The restored data no longer matches the other devices', so each chooses again which copy to keep.
          after_restore: (restored_database: SqlDatabase) => sync_engine.forget_history(restored_database),
        }),
  });

  if (needs_upgrade(database)) await kept.create();
  open_store(database);
  if (restored) sync_engine.forget_history(database);

  // The schedule belongs to this host, so it is kept beside the database rather than in the synced settings.
  const schedule_file = join(options.profile, "backup-schedule.json");
  const read_backup_schedule = () => read_schedule(existsSync(schedule_file) ? JSON.parse(readFileSync(schedule_file, "utf8")) : null);
  const backing_up = keep_backing_up(kept, read_backup_schedule);
  const backups: BackupMethods = {
    list_backups: kept.list,
    create_backup: () => kept.create(),
    restore_backup: async (name) => {
      sync?.before_restore?.();
      await kept.restore(name);
    },
    remove_backup: kept.remove,
    get_backup_schedule: read_backup_schedule,
    set_backup_schedule: (schedule) => {
      writeFileSync(schedule_file, JSON.stringify(read_schedule(schedule), null, 2));
      void backing_up.check();
    },
  };

  // ── Work ──

  await load_collectors(options.plugins_folder, options.desktop_plugins);
  // What this computer's configuration declares, read again when its file changes.
  const declared = keep_declared(options.declared_file, () => database, () => announce());
  void declared.reload();
  const refreshing = keep_refreshing(() => database, { on_change: () => announce(), on_report: options.on_refresh_report });

  // A file of its own beside the database, never synced or backed up, and rebuilt from the store if it is deleted.
  const index = open_database(options.index_path);
  open_index(index);
  const indexing = keep_indexing({ database: () => database, index: () => index });
  // This device's own index and embeddings, and, on the device chosen for background work, the graph's upkeep and the digest.
  const maintaining = keep_maintaining({ database: () => database, index: () => index, device: options.device, kind: options.kind, now: () => Date.now(), on_change: () => after_index_change(database) });
  // The assistant's jobs run only once the user chose this device as the one that does.
  const jobs = keep_running_jobs({ database: () => database, device: options.device, now: () => Date.now(), on_finished: options.on_job_finished });

  const role = options.sync({ database: () => database, engine: sync_engine, back_up: async () => void (await kept.create()), profile: options.profile, announce, changes });
  sync = role;

  // ── Stopping ──

  const stop = async (): Promise<void> => {
    stop_all_runs();
    refreshing.stop();
    declared.stop();
    role.stop();
    backing_up.stop();
    await jobs.stop();
    await maintaining.stop();
    await indexing.stop();
    index.close();
  };

  return { database: () => database, changes, announce, backups, sync: role, stop };
}
