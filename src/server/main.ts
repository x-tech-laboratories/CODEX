// Starts the CODEX web server on the database the config names.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { keep_backing_up } from "@x-tech-laboratories/x-libs/backups";
import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import { sqlite_backups, take_staged_restore } from "@x-tech-laboratories/x-libs/server/sqlite_backups";

import { codex_backup_naming, read_schedule } from "../shared/backups.ts";
import { keep_running_jobs } from "../shared/jobs/runner.ts";
import { keep_indexing, open_index } from "../shared/search/indexer.ts";
import { keep_maintaining } from "../shared/maintenance/loop.ts";
import { after_index_change, needs_upgrade, open_store, sync_engine } from "../shared/store.ts";
import { build_app } from "./app.ts";
import { load_collectors } from "./collectors/index.ts";
import { keep_refreshing } from "./refreshing.ts";

// ── Config ───────────────────────────────────────────────────────────────────

interface ContextConfig {
  database: string;
  backups_folder: string;
  // Each subfolder a plugin, such as a collector for another app; left out for none.
  plugins_folder?: string;
}

const server_config = read_server_config({
  program: "codex",
  summary: "Serves CODEX as a web app and syncs its devices.",
  env_prefix: "CODEX",
  default_port: 7770,
  secret: false,
  web_folder_default: join(import.meta.dirname, "../../out/web"),
  options: { config: { variable: "CODEX_CONFIG", help: "the JSON config naming the database and the backups folder", placeholder: "<file>", required: true } },
});

const config = JSON.parse(readFileSync(server_config.values.config!, "utf8")) as ContextConfig;
const database_path = resolve(config.database);
const backups_folder = resolve(config.backups_folder);

// ── Database ─────────────────────────────────────────────────────────────────

mkdirSync(dirname(database_path), { recursive: true });
// A backup restored from the page waits beside the database until the server starts again.
const restored = take_staged_restore(database_path);
const database = new DatabaseSync(database_path);
database.exec("PRAGMA journal_mode = WAL");

// ── Backups ──────────────────────────────────────────────────────────────────

const answer_delay_ms = 500;

// A restore is staged for the next start, then the server stops, once the page has its answer, so its service starts it
// again on the backup.
const kept = sqlite_backups({
  folder: () => {
    mkdirSync(backups_folder, { recursive: true });
    return backups_folder;
  },
  naming: codex_backup_naming,
  database: () => database,
  database_path: () => database_path,
  after_staging: () => void setTimeout(stop, answer_delay_ms),
});

if (needs_upgrade(database)) await kept.create();
open_store(database);
// The restored data is no longer what the devices last saw, so each chooses again which copy to keep.
if (restored) sync_engine.forget_history(database);

// The schedule belongs to this server, so it is kept beside the database rather than in the synced settings.
const schedule_file = join(dirname(database_path), "backup-schedule.json");
const read_backup_schedule = () => read_schedule(existsSync(schedule_file) ? JSON.parse(readFileSync(schedule_file, "utf8")) : null);
const backing_up = keep_backing_up(kept, read_backup_schedule);

// ── Collectors ───────────────────────────────────────────────────────────────

await load_collectors(config.plugins_folder ? resolve(config.plugins_folder) : null);
const refreshing = keep_refreshing(() => database);

// ── Search index ─────────────────────────────────────────────────────────────

// A file of its own beside the database, never synced or backed up, and rebuilt from the store if it is deleted.
const index_path = join(dirname(database_path), `${basename(database_path, extname(database_path))}-index.db`);
const index = new DatabaseSync(index_path);
index.exec("PRAGMA journal_mode = WAL");
open_index(index);
const indexing = keep_indexing({ database: () => database, index: () => index });

// The maintenance jobs: this device's own index and embeddings, and, on the device chosen for background work, the
// graph's upkeep and the daily digest, each within its budget.
const maintaining = keep_maintaining({ database: () => database, index: () => index, device: `server on ${hostname()}`, kind: "server", now: () => Date.now(), on_change: () => after_index_change(database) });

// ── Server ───────────────────────────────────────────────────────────────────

const app = await build_app({
  database,
  declared: load_accounts("CODEX_PASSWORD_HASH_FILE"),
  web_folder: server_config.web_folder,
  backups: {
    list_backups: kept.list,
    create_backup: () => kept.create(),
    restore_backup: kept.restore,
    remove_backup: kept.remove,
    get_backup_schedule: read_backup_schedule,
    set_backup_schedule: (schedule) => {
      writeFileSync(schedule_file, JSON.stringify(read_schedule(schedule), null, 2));
      void backing_up.check();
    },
  },
});
// The server runs the assistant's jobs only once the user chose it as the device that does.
const jobs = keep_running_jobs({ database: () => database, device: `server on ${hostname()}`, now: () => Date.now() });

await app.listen({ host: server_config.host, port: server_config.port });
console.info(`CODEX is serving http://${server_config.host}:${server_config.port}/`);

function stop(): void {
  refreshing.stop();
  void jobs.stop();
  void maintaining.stop().then(() => indexing.stop()).then(() => index.close());
  backing_up.stop();
  void app.close().then(() => database.close());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
