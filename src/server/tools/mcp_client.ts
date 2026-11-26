// The store's connector to MCP servers, on the official SDK's client: streamable HTTP with an optional bearer token, or a
// local command started without a shell, with only the SDK's safe variables (HOME, LOGNAME, PATH, SHELL, TERM, USER) and
// those the user names. One connection per server is kept while used and closed when idle; a server that exits, hangs
// or answers badly gives a plain error and never takes CODEX down.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { app_info } from "../../shared/collectors/collector.ts";
import type { McpConnector } from "../../shared/mcp/connector.ts";
import type { McpServerRecord, McpToolRecord } from "../../shared/mcp/model.ts";

// ── Limits ───────────────────────────────────────────────────────────────────

export const mcp_limits = {
  // Starting or reaching a server and listing its tools.
  connect_ms: 20_000,
  // One tool call, unless the run stops it first.
  call_ms: 60_000,
  // A connection unused this long is closed, stopping a local server.
  idle_ms: 120_000,
  // The most tools read from one server, and of a description's characters.
  max_tools: 200,
  max_description: 2000,
  // The most of what a server wrote on stderr kept for a plain error.
  stderr_chars: 600,
};

// ── Connections ──────────────────────────────────────────────────────────────

interface Connection {
  key: string;
  client: Client;
  closed: boolean;
  idle?: ReturnType<typeof setTimeout>;
  // The last of what a local server wrote on stderr.
  stderr: string;
}

const connections = new Map<string, Connection>();

function key_of(server: McpServerRecord): string {
  return JSON.stringify([server.transport, server.address, server.token, server.command, server.args, server.variables]);
}

function where(server: McpServerRecord): string {
  if (server.transport === "stdio") return `the command ${server.command}`;
  try {
    const url = new URL(server.address);
    return url.host;
  } catch {
    return server.address;
  }
}

// What a server's failure means, in plain words, naming the server and never its token.
function plain(server: McpServerRecord, error: unknown, connection?: Connection): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const said = connection?.stderr.trim() ? ` It wrote: ${connection.stderr.trim().slice(-mcp_limits.stderr_chars)}` : "";
  const message = server.token ? raw.split(server.token).join("[hidden]") : raw;
  if (/ENOENT/.test(message)) return new Error(`${server.name} could not be started: ${server.command} was not found.`);
  if (/EACCES/.test(message)) return new Error(`${server.name} could not be started: ${server.command} may not be run.`);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/.test(message)) return new Error(`${server.name} could not be reached at ${where(server)}.`);
  if (/\b401\b|Unauthorized/i.test(message)) return new Error(`${server.name} refused the token.`);
  if (/closed|EPIPE/i.test(message)) return new Error(`${server.name} stopped: it exited or closed its connection.${said}`);
  return new Error(`${server.name} failed: ${message}${said}`);
}

function within<Value>(work: Promise<Value>, ms: number, what: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} seconds.`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function close(server_id: string): Promise<void> {
  const connection = connections.get(server_id);
  if (!connection) return;
  connections.delete(server_id);
  connection.closed = true;
  clearTimeout(connection.idle);
  await connection.client.close().catch(() => undefined);
}

function keep_alive(server_id: string, connection: Connection): void {
  clearTimeout(connection.idle);
  connection.idle = setTimeout(() => void close(server_id), mcp_limits.idle_ms);
  connection.idle.unref?.();
}

// The variables passed to a local server: only those the user named, from CODEX's own environment; the SDK adds its safe ones.
export function passed_variables(names: string[], from: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(names.filter((name) => typeof from[name] === "string").map((name) => [name, from[name]!]));
}

async function connect(server: McpServerRecord): Promise<Connection> {
  const key = key_of(server);
  const existing = connections.get(server.id);
  if (existing && existing.key === key && !existing.closed) return existing;
  if (existing) await close(server.id);
  const client = new Client({ name: "CODEX", version: app_info.version });
  const connection: Connection = { key, client, closed: false, stderr: "" };
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (server.transport === "stdio") {
    const stdio = new StdioClientTransport({ command: server.command, args: server.args, env: passed_variables(server.variables), stderr: "pipe" });
    stdio.stderr?.on("data", (chunk: Buffer) => (connection.stderr = (connection.stderr + chunk.toString("utf8")).slice(-mcp_limits.stderr_chars)));
    transport = stdio;
  } else {
    const token = server.token;
    transport = new StreamableHTTPClientTransport(new URL(server.address), token ? { authProvider: { token: async () => token } } : {});
  }
  // A failing transport ends the connection here, never the process.
  client.onerror = () => undefined;
  client.onclose = () => {
    connection.closed = true;
    if (connections.get(server.id) === connection) connections.delete(server.id);
  };
  try {
    await within(client.connect(transport), mcp_limits.connect_ms, server.name);
  } catch (error) {
    connection.closed = true;
    await client.close().catch(() => undefined);
    throw plain(server, error, connection);
  }
  connections.set(server.id, connection);
  keep_alive(server.id, connection);
  return connection;
}

// ── Results ──────────────────────────────────────────────────────────────────

// A tool's answer as text: its text parts, then what else it gave said in words.
export function result_text(result: CallToolResult): string {
  const parts: string[] = [];
  for (const part of result.content ?? []) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "resource" && "text" in part.resource && typeof part.resource.text === "string") parts.push(part.resource.text);
    else if (part.type === "resource_link") parts.push(`[${part.name}: ${part.uri}]`);
    else parts.push(`[${part.type}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n") || "(No answer.)";
}

// ── Connector ────────────────────────────────────────────────────────────────

async function list_tools(server: McpServerRecord): Promise<McpToolRecord[]> {
  const connection = await connect(server);
  try {
    const tools: McpToolRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10 && tools.length < mcp_limits.max_tools; page += 1) {
      const answer = await connection.client.listTools(cursor ? { cursor } : undefined, { timeout: mcp_limits.connect_ms });
      for (const tool of answer.tools) {
        const description = String(tool.description ?? tool.title ?? "");
        tools.push({
          name: tool.name,
          description: description.length > mcp_limits.max_description ? `${description.slice(0, mcp_limits.max_description - 1)}…` : description,
          read_only: tool.annotations?.readOnlyHint === true,
          input_schema: tool.inputSchema && typeof tool.inputSchema === "object" ? (tool.inputSchema as McpToolRecord["input_schema"]) : { type: "object", properties: {} },
        });
      }
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    keep_alive(server.id, connection);
    return tools.slice(0, mcp_limits.max_tools);
  } catch (error) {
    await close(server.id);
    throw plain(server, error, connection);
  }
}

async function call_tool(server: McpServerRecord, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const connection = await connect(server);
  let result: CallToolResult;
  try {
    result = (await connection.client.callTool({ name, arguments: args }, { signal, timeout: mcp_limits.call_ms })) as CallToolResult;
  } catch (error) {
    // A call that hung or broke leaves the server in doubt, so the next call starts afresh.
    await close(server.id);
    if (signal.aborted) throw new Error("Stopped.");
    throw plain(server, error, connection);
  }
  keep_alive(server.id, connection);
  const text = result_text(result);
  if (result.isError) throw new Error(text);
  return text;
}

async function forget(server_id?: string): Promise<void> {
  const ids = server_id === undefined ? [...connections.keys()] : [server_id];
  await Promise.all(ids.map(close));
}

export const node_mcp_connector: McpConnector = { list_tools, call_tool, forget };

// How many connections are open, for tests.
export function open_connections(): number {
  return connections.size;
}
