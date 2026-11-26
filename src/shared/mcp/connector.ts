// How the store reaches MCP servers: a connector set once where the store runs, since starting a local server needs
// Node, which this folder may not import.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { McpServerRecord, McpToolRecord } from "./model.ts";

// ── Connector ────────────────────────────────────────────────────────────────

export interface McpConnector {
  // The tools the server lists now; throws a plain error when it cannot be reached or does not answer.
  list_tools(server: McpServerRecord): Promise<McpToolRecord[]>;
  // Runs one tool and answers with its text; throws a plain error when the tool or the server fails.
  call_tool(server: McpServerRecord, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  // Closes the connection to one server, or to every server, stopping a local one.
  forget(server_id?: string): Promise<void>;
}

let current: McpConnector | null = null;

export function use_mcp_connector(connector: McpConnector | null): void {
  current = connector;
}

export function mcp_connector(): McpConnector {
  if (!current) throw new Error("MCP servers are reached only where CODEX's data is: the server or the desktop app's daemon.");
  return current;
}
