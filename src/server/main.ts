// Starts the CODEX web server on the database the config names: the runtime every host shares, served to browsers,
// tokens and MCP clients over HTTP, and the exchange every device syncs against.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import { read_server_config } from "@x-tech-laboratories/x-libs/server/config";
import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";

import { build_app } from "./app.ts";
import { declared_file_of } from "./declared.ts";
import { start_runtime } from "./runtime.ts";
import { sync_hub } from "./sync.ts";

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

// ── Server ───────────────────────────────────────────────────────────────────

// Read before anything opens, so a missing accounts file stops the server before it touches the database.
const accounts = load_accounts("CODEX_PASSWORD_HASH_FILE");

const runtime = await start_runtime({
  database_path,
  index_path: join(dirname(database_path), `${basename(database_path, extname(database_path))}-index.db`),
  backups_folder: resolve(config.backups_folder),
  profile: dirname(database_path),
  plugins_folder: config.plugins_folder ? resolve(config.plugins_folder) : null,
  desktop_plugins: false,
  declared_file: declared_file_of(process.env, ""),
  device: `server on ${hostname()}`,
  kind: "server",
  restore: "staged",
  stop_soon: () => void stop(),
  sync: sync_hub,
});

const app = await build_app({
  database: runtime.database(),
  declared: accounts,
  web_folder: server_config.web_folder,
  backups: runtime.backups,
  changes: runtime.changes,
  sync: runtime.sync,
});

await app.listen({ host: server_config.host, port: server_config.port });
console.info(`CODEX is serving http://${server_config.host}:${server_config.port}/`);

async function stop(): Promise<void> {
  await runtime.stop();
  await app.close();
  runtime.database().close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop());
