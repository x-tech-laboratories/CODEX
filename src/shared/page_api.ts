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

// Calls that keep the user in charge of the assistant, approving its changes, setting how freely it may make them
// and what each source's items may reach, answered only for the user at the page: a signed-in browser, or the desktop window. A token, MCP and any
// engine are refused, so nothing a program does can approve a change or raise a level.
const page_only_calls: ReadonlySet<string> = new Set(["resolve_proposal", "set_action_level", "set_source_mark"]);

export function is_page_only(method: string): boolean {
  return page_only_calls.has(method);
}

// Settings that keep the user in charge, written only by the user at the page: the action policy, the source marks,
// which engine answers and which embedder the index uses, how long the hosted log is kept, and every plugin's on or
// off and settings, which hold each engine's and embedder's endpoint and key command. They are read like any other.
export const user_only_settings: ReadonlySet<string> = new Set(["action_policy", "source_marks", "engine", "embedder", "hosted_log.keep_days", "plugins"]);

// Whether this call with these arguments, in order, is the user's alone: a page-only call, or a write to a setting
// only the user may change.
export function is_page_only_call(method: string, args: readonly unknown[]): boolean {
  return is_page_only(method) || (method === "set_setting" && user_only_settings.has(String(args[0])));
}

export const page_only_refusal = "Only you can do this, from CODEX's own page; a token or an MCP client cannot.";
