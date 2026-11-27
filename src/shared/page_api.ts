// What the page knows of its host without loading the store: the names the calls travel under, and the api's shape.
// The browser build imports only this, so the stores and Drizzle stay out of the page a server serves.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { backup_method_names, type BackupClient, type BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import type { CertificateClient } from "@x-tech-laboratories/x-libs/certificate_protocol";
import type { LocalMcpClient } from "@x-tech-laboratories/x-libs/local_mcp_protocol";
import { sync_device_method_names, type SyncDeviceMethods, type SyncStatus } from "@x-tech-laboratories/x-libs/sync_protocol";

import type { ConversationEvent } from "./conversations/model.ts";
import type { DesktopMethods } from "./desktop.ts";
import type { ContextMethods } from "./store.ts";

// ── Names ────────────────────────────────────────────────────────────────────

export const context_api_name = "codex";
export const device_api_name = "codex_device";
export const events_api_name = "codex_events";
export const certificates_api_name = "codex_certificates";
export const local_mcp_api_name = "codex_local_mcp";
export const desktop_api_name = "codex_desktop";

// ── Device calls ─────────────────────────────────────────────────────────────

// Sync with a server and backups of the device's own database; a browser is already on the server.
export type DeviceMethods = SyncDeviceMethods & BackupMethods;

export const device_method_names = [...sync_device_method_names, ...backup_method_names] as const;

// The named event a reply's progress streams under, from the server or the daemon.
export const conversation_event = "conversation";

// What the main process tells the page on its own: the data changed elsewhere, sync's status moved, the tray asked
// for a route such as "#/context/<id>", or a reply being written moved on.
export type ContextEvents = { changed: null; sync_status: SyncStatus; open: string; conversation: ConversationEvent };

// ── The page's api ───────────────────────────────────────────────────────────

export type Host = "web" | "desktop" | "android";

export interface PageApi {
  host: Host;
  calls: Client<ContextMethods>;
  // Null in a browser, which syncs nothing itself.
  device: Client<DeviceMethods> | null;
  // The backups of whichever database the page works on: the device's own, or the server's for a browser; left out where
  // none are offered, and Settings then shows no Backups section.
  backups?: BackupClient;
  // Where a phone keeps its backups: a folder the user picks once, with no backups until then.
  backup_folder?: { get: () => Promise<string>; choose: () => Promise<string> };
  // Set where the app makes its own connections and can trust a certificate the system refuses.
  certificates?: CertificateClient;
  // Set on the desktop, which can serve its own MCP endpoint to AI clients on the same computer.
  local_mcp?: LocalMcpClient;
  // Set on the desktop, whose tray, background running and start at login belong to the computer.
  desktop?: Client<DesktopMethods>;
  // Runs whenever the data changed somewhere else; returns the function that stops listening.
  on_change: (listener: () => void) => () => void;
  // Runs as a reply being written moves on, wherever it runs; returns the function that stops listening.
  on_conversation: (listener: (event: ConversationEvent) => void) => () => void;
}

// ── Calls ────────────────────────────────────────────────────────────────────

// A call that only reads; any other call announces a change.
export function is_read_only(method: string): boolean {
  return /^(list|get|search|lookup|export)_/.test(method);
}

// Calls that keep the user in charge of the assistant, approving and undoing its changes, the graph's proposals and
// proposed blueprints, bringing a blueprint back or widening where it applies, turning a job on, running one now and
// choosing the device that runs them, a maintenance job's switch and budget, the tool plugins' marks, which of their tools are offered and at what level, the guidance the specialists are given, the
// MCP servers added, changed, refreshed, moved to this device or removed (a local one's command runs on this machine), the dates the mood remembers, the assistant's interests added, accepted, paused, dropped or capped (an accepted topic is sent to a search engine),
// setting how freely it may make them and what each source's items may reach, which apps are read with which token, and
// reading what this computer's configuration declares,
// answered only for the user at the page: a signed-in browser, or the desktop window. Their specs are marked page-only
// with X-Libs `api_spec`, so a token, MCP and any engine are refused them and nothing a program does can approve a
// change or raise a level.
export const page_only_methods: ReadonlySet<string> = new Set([
  "resolve_proposal",
  "undo_change",
  "set_action_level",
  "set_source_mark",
  "accept_graph_proposals",
  "reject_graph_proposals",
  "add_item_source",
  "change_item_source",
  "remove_item_source",
  "accept_blueprint_proposals",
  "reject_blueprint_proposals",
  "restore_blueprint",
  "place_blueprint",
  "set_job_on",
  "run_job_now",
  "set_background_device",
  "set_maintenance_job",
  "set_tool_plugin_mark",
  "set_plugin_tool_offer",
  "set_plugin_tool_level",
  "set_plugin_guidance",
  "add_mcp_server",
  "change_mcp_server",
  "refresh_mcp_server",
  "move_mcp_server_here",
  "remove_mcp_server",
  "set_mood_dates",
  "add_interest",
  "accept_interest",
  "set_interest_state",
  "set_max_interests",
  "get_declared_config",
  "refresh_declared_mcp_server",
]);

// Settings that keep the user in charge, written only by the user at the page: the action policy, the source marks,
// which engine answers and which embedder the index uses, how long the hosted log is kept, and every plugin's on or
// off and settings, which hold each engine's and embedder's endpoint and key command, the apps read through the
// item calls with their tokens, whether background work runs at all, is paused, on which device, how often it looks
// for work, whether it may use a hosted engine and how much a day, each maintenance job's switch and budget, and the tool plugins' marks
// and which of their tools are offered, the guidance each plugin's specialist is given, and the MCP servers with their addresses, tokens and commands, and the assistant's mood: its switches, its dates and
// the mood itself, which only CODEX's own code writes, and the interests' cap and the context their findings are kept in. They are read like any other,
// and only the user's own devices may sync a change to them.
export const user_only_settings: ReadonlySet<string> = new Set(["action_policy", "source_marks", "engine", "embedder", "hosted_log.keep_days", "plugins", "item_sources", "background.enabled", "background.daily_runs", "background.daily_tokens", "background.paused", "background.device", "background.tick_minutes", "background.hosted", "maintenance.jobs", "tool_plugins", "mcp_servers", "plugin_guidance", "mood.enabled", "mood.tone", "mood.dates", "mood.current", "interests.max_accepted", "interests.context"]);

// Whether this call with these arguments, in order, writes a setting only the user may change; X-Libs adds the marked calls.
export function is_user_only_setting_write(method: string, args: readonly unknown[]): boolean {
  return method === "set_setting" && user_only_settings.has(String(args[0]));
}

// Backup calls that replace or delete data, answered only for the user at the page: restoring a backup would rewrite
// every setting only the user may change, and deleting backups, or a schedule keeping fewer, takes away the way back.
// Listing, taking a backup and reading the schedule stay open to an admin's token.
export const user_only_backup_calls: ReadonlySet<string> = new Set(["restore_backup", "remove_backup", "set_backup_schedule"]);

export const page_only_refusal = "Only you can do this, from CODEX's own page; a token or an MCP client cannot.";
