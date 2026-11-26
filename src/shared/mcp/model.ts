// The shapes the MCP servers feature hands the page and other programs: each MCP server the user added, reached over
// streamable HTTP or started as a local command over stdio, with the tools it listed. The page imports only these.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";
import type { PluginManifest } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../collectors/collector.ts";

// ── Names ────────────────────────────────────────────────────────────────────

// The synced setting holding the servers, one of the settings only the user may change.
export const mcp_servers_setting = "mcp_servers";

export const mcp_plugin_id = "codex.mcp";

export const mcp_manifest: PluginManifest = {
  id: mcp_plugin_id,
  name: "MCP servers",
  version: app_info.version,
  app: app_info.id,
  description: "Offers the assistant the tools of the MCP servers you add below, each a tool plugin of its own with its own marks.",
};

// The id each server's tools are provided under, which is their namespace: mcp_<id>__<tool>.
export function mcp_provider_of(server_id: string): string {
  return `mcp_${server_id}`;
}

// The key its marks and tool choices are kept under, as for any tool plugin.
export function mcp_key_of(server_id: string): string {
  return `${mcp_plugin_id}/${mcp_provider_of(server_id)}`;
}

// ── Servers ──────────────────────────────────────────────────────────────────

export type McpTransport = "http" | "stdio";

// A tool as the server listed it; its description is the server's own words.
export interface McpToolRecord {
  name: string;
  description: string;
  // The server marks it read-only; every other tool counts as changing something.
  read_only: boolean;
  input_schema: JsonSchema;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: McpTransport;
  // For http: the address it answers at, and a bearer token, empty for none.
  address: string;
  token: string;
  // For stdio: the program started, without a shell, its arguments, and the names of CODEX's own environment
  // variables passed to it.
  command: string;
  args: string[];
  variables: string[];
  enabled: boolean;
  tools: McpToolRecord[];
  // When its tools were last listed.
  listed_at: string;
}

// What the page sends to add or change a server; a token left null keeps the one stored.
export interface McpServerFields {
  name: string;
  transport: McpTransport;
  address?: string;
  token?: string | null;
  command?: string;
  args?: string[];
  variables?: string[];
  enabled?: boolean;
}

export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransport;
  address: string;
  has_token: boolean;
  command: string;
  args: string[];
  variables: string[];
  enabled: boolean;
  tools: { name: string; description: string; read_only: boolean }[];
  listed_at: string;
  // The key its marks and tool choices are kept under.
  key: string;
  // Its tools count as sending their arguments outside this machine.
  sends_outside: boolean;
}

// ── Where it runs ────────────────────────────────────────────────────────────

// Whether an address is this machine's own: localhost or a loopback address.
export function is_loopback_address(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1" || /^::ffff:127\./.test(host);
}

// A server's tools stay on this machine only when it is a local command or answers on a loopback address.
export function sends_outside(server: Pick<McpServerRecord, "transport" | "address">): boolean {
  return server.transport === "http" && !is_loopback_address(server.address);
}
