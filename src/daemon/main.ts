// The desktop app's daemon: the runtime every host shares, run beside this computer's database and synced with a
// server, with what only a desktop has: its own settings, notifications, a local MCP endpoint and stopping when unused.
// The window reaches it over a Unix socket with the same calls a browser makes to the web server.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { Notifier } from "@x-tech-laboratories/x-libs/agent/desktop_notify";
import { create_certificate_trust } from "@x-tech-laboratories/x-libs/certificates";
import { create_local_mcp } from "@x-tech-laboratories/x-libs/electron/mcp";
import { DaemonRunningError, listen_on_socket } from "@x-tech-laboratories/x-libs/local_daemon";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { register_error_replies, register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";

import { context_bridge } from "../shared/bridge.ts";
import { read_desktop_settings, type DaemonMethods, type DesktopSettings } from "../shared/desktop.ts";
import type { JobRun } from "../shared/jobs/model.ts";
import { mcp_instructions } from "../shared/mcp.ts";
import type { DeviceMethods } from "../shared/page_api.ts";
import { bind_methods, context_api, is_read_only, page_only } from "../shared/store.ts";
import { register_context_calls } from "../server/calls.ts";
import { declared_file_of } from "../server/declared.ts";
import { start_runtime } from "../server/runtime.ts";
import { sync_client_role } from "../server/sync.ts";
import { socket_of } from "./profile.ts";

// ── Profile ──────────────────────────────────────────────────────────────────

// The window starts it with these set; a run on another database has a socket of its own.
const database_path = process.env.CODEX_DB;
if (!database_path) {
  console.error("codex daemon: CODEX_DB must name the database");
  process.exit(2);
}
const socket_path = socket_of(process.env, database_path, false);
const version = process.env.CODEX_VERSION || "0.0.0";
// The built daemon sits in out/main, and resources/ beside out/ both in the source tree and in the package.
const icon_path = process.env.CODEX_ICON || join(import.meta.dirname, "../../resources/icon.png");
const profile = dirname(database_path);
const device = `CODEX on ${hostname()}`;

// How long the daemon waits after its last window closed before it stops, when it is not to keep running in the background.
const unused_exit_ms = 30_000;
const unused_check_ms = 5000;

// ── Desktop settings ─────────────────────────────────────────────────────────

const desktop_file = join(profile, "desktop.json");

function read_desktop(): DesktopSettings {
  return read_desktop_settings(existsSync(desktop_file) ? JSON.parse(readFileSync(desktop_file, "utf8")) : null);
}

// Whether a window is in front, as the window tells; nothing about the Inbox is shown while the user is looking.
let window_in_front = false;

// ── Notifications ────────────────────────────────────────────────────────────

const notifier = new Notifier({ app_name: "CODEX", icons: { app: icon_path }, on_error: (message) => console.error(message) });

// What a finished run left waiting, in a line, or nothing when it left nothing.
function waiting_words(run: JobRun): string {
  if (run.outcome === "error") return `“${run.title}” failed: ${run.note}`;
  if (run.outcome === "limit") return `“${run.title}” stopped at a limit.`;
  if (run.proposed.length > 0) return `“${run.title}” proposed ${run.proposed.length === 1 ? "a change" : `${run.proposed.length} changes`} for you to decide.`;
  return "";
}

// ── Runtime ──────────────────────────────────────────────────────────────────

const runtime = await start_runtime({
  database_path,
  index_path: join(profile, "codex-index.db"),
  backups_folder: join(profile, "backups"),
  profile,
  plugins_folder: join(profile, "plugins"),
  desktop_plugins: true,
  declared_file: declared_file_of(process.env),
  device,
  kind: "desktop",
  restore: "reopen",
  sync: sync_client_role(device),
  // Tells the user when items vanished from their apps, one notice replacing the last.
  on_refresh_report: (report) => {
    if (report.missing === 0 || !read_desktop().notify_missing) return;
    const items = report.missing === 1 ? "An item is" : `${report.missing} items are`;
    void notifier.show({ key: "missing", title: "Items gone", body: `${items} no longer in its app; it is marked missing in its contexts.`, icon: "app" });
  },
  // A job that leaves something waiting says so while the window is not in front.
  on_job_finished: (run) => {
    const words = waiting_words(run);
    if (!words || window_in_front || !read_desktop().notify_inbox) return;
    void notifier.show({ key: "inbox", title: "Waiting in the Inbox", body: words, url: "codex://inbox", icon: "app" });
  },
});

// Server certificates the user trusted, such as a home server's self-signed one, handed to Node's own fetch.
const certificates = create_certificate_trust({ file: join(profile, "trusted-certificates.json"), use_in_node: true });

// Off until turned on in Settings; a change made through it reaches the open window and syncs like any other.
const local_mcp = create_local_mcp({
  name: "codex",
  version,
  instructions: mcp_instructions,
  api: context_api,
  is_read_only,
  page_only,
  settings_file: join(profile, "mcp.json"),
  default_port: 3922,
  call: (method, args) => context_bridge.dispatch(bind_methods(runtime.database, () => runtime.announce(), "program"), method, args),
});

// ── Calls ────────────────────────────────────────────────────────────────────

function device_methods(): DeviceMethods {
  return { ...runtime.sync.methods, ...runtime.backups };
}

function daemon_methods(shut_down: () => void): DaemonMethods {
  return {
    get_desktop_settings: read_desktop,
    set_desktop_setting: (key, value) => writeFileSync(desktop_file, JSON.stringify(read_desktop_settings({ ...read_desktop(), [key]: value }), null, 2)),
    // Stops once the answer has gone back.
    stop_daemon: () => void setTimeout(shut_down, 0),
    set_window_in_front: (in_front) => void (window_in_front = in_front === true),
  };
}

async function build_daemon(shut_down: () => void): Promise<FastifyInstance> {
  const daemon = fastify({ bodyLimit: 4 * 1024 * 1024, forceCloseConnections: true });
  register_lenient_json_body(daemon);
  register_error_replies(daemon);
  // A change from one window reaches the others; the one that made it already shows it.
  const tell_others = (client_id: string): void => runtime.announce(client_id);
  await daemon.register(
    async (api) => {
      runtime.changes.register(api, "/events");
      // The socket is readable by the user alone and is how the desktop window reaches the daemon, so it is the page.
      register_context_calls(api, runtime.database, runtime.changes);
      register_call_table(api, "/device", device_methods(), { is_read_only, on_change: tell_others });
      register_call_table(api, "/certificates", certificates.methods, { is_read_only });
      register_call_table(api, "/local_mcp", local_mcp.methods, { is_read_only });
      register_call_table(api, "/daemon", daemon_methods(shut_down), { is_read_only, on_change: tell_others });
    },
    { prefix: "/api" },
  );
  return daemon;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let is_stopping = false;
  let unused_timer: ReturnType<typeof setInterval> | undefined;
  const daemon = await build_daemon(() => shut_down());

  function shut_down(): void {
    if (is_stopping) return;
    is_stopping = true;
    clearInterval(unused_timer);
    void runtime
      .stop()
      .then(() => daemon.close())
      .then(() => local_mcp.stop())
      .finally(() => {
        runtime.database().close();
        process.exit(0);
      });
  }

  try {
    await listen_on_socket(socket_path, (path) => daemon.listen({ path }));
  } catch (error) {
    // Another daemon on this database got there first, which is all that was asked for.
    if (error instanceof DaemonRunningError) process.exit(0);
    throw error;
  }
  console.log(`codex daemon on ${socket_path}, using ${database_path}`);

  runtime.sync.start();
  void local_mcp.start();

  // Without "Keep running in the background", the daemon stops a while after its last window has gone.
  let unused_since = Date.now();
  unused_timer = setInterval(() => {
    if (runtime.changes.client_count > 0 || read_desktop().keep_running_in_background) unused_since = Date.now();
    else if (Date.now() - unused_since >= unused_exit_ms) shut_down();
  }, unused_check_ms);

  process.on("SIGINT", shut_down);
  process.on("SIGTERM", shut_down);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
