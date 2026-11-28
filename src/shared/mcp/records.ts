// The MCP servers as the synced setting keeps them, their bearer tokens hidden from everything that reads settings and
// kept when a hidden one comes back, as the apps' tokens are.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema } from "@x-tech-laboratories/x-libs/api_spec";
import { hidden_secret } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { read_setting, write_setting } from "../settings.ts";
import { mcp_servers_setting, type McpServerRecord, type McpToolRecord } from "./model.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

const text_of = (value: unknown) => (typeof value === "string" ? value : "");
const texts_of = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

function tools_of(value: unknown): McpToolRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((each) => each && typeof each === "object" && typeof each.name === "string" && each.name !== "")
    .map((each) => ({
      name: String(each.name),
      description: text_of(each.description),
      read_only: each.read_only === true,
      input_schema: each.input_schema && typeof each.input_schema === "object" && !Array.isArray(each.input_schema) ? (each.input_schema as JsonSchema) : { type: "object", properties: {} },
    }));
}

// The list as stored, anything malformed left out.
export function server_records(value: unknown): McpServerRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((each) => each && typeof each === "object" && typeof each.id === "string" && each.id !== "")
    .map((each) => ({
      id: each.id,
      name: text_of(each.name) || each.id,
      transport: each.transport === "stdio" ? "stdio" : "http",
      address: text_of(each.address),
      token: text_of(each.token),
      command: text_of(each.command),
      args: texts_of(each.args),
      variables: texts_of(each.variables),
      device: each.transport === "stdio" ? text_of(each.device) : "",
      enabled: each.enabled !== false,
      tools: tools_of(each.tools),
      ...(text_of(each.instructions) ? { instructions: text_of(each.instructions) } : {}),
      listed_at: text_of(each.listed_at),
    }));
}

export function read_servers(database: SqlDatabase): McpServerRecord[] {
  return server_records(read_setting(database, mcp_servers_setting));
}

export function write_servers(database: SqlDatabase, servers: McpServerRecord[]): void {
  write_setting(database, mcp_servers_setting, servers);
}

// ── Secrets ──────────────────────────────────────────────────────────────────

// The list with every token that is set replaced by the hidden mark, for the page and other programs to read.
export function hide_server_tokens(value: unknown): unknown {
  return Array.isArray(value) ? value.map((each) => (each && typeof each === "object" && typeof each.token === "string" && each.token !== "" ? { ...each, token: hidden_secret } : each)) : value;
}

// A list sent back with hidden tokens keeps the tokens stored for the same servers.
export function keep_server_tokens(stored: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const tokens = new Map(server_records(stored).map((server) => [server.id, server.token]));
  return incoming.map((each) => (each && typeof each === "object" && each.token === hidden_secret ? { ...each, token: tokens.get(each.id) ?? "" } : each));
}
