// The tools CODEX hands one engine run, served as an MCP server on a loopback port with a token of the run's own, so a
// harness that reaches tools only through MCP servers, such as SmartHarness, can call them. It offers exactly the
// tools it is given, each answered through the run's own `call` (and so through the action policy), and closes with the
// run.

// ── Imports ──────────────────────────────────────────────────────────────────

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";

import type { ToolDefinition, ToolOutcome } from "../../shared/engines/engine.ts";

// ── Bridge ───────────────────────────────────────────────────────────────────

export interface ToolBridge {
  // Where the server answers, on 127.0.0.1 at a port the system chose.
  url: string;
  // The token, as the header every request must carry.
  headers: Record<string, string>;
  // The tools offered, by name.
  names: string[];
  close(): Promise<void>;
}

export type BridgeCall = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

// The most a request body may hold; a tool's arguments are far smaller.
const most_body_bytes = 1_000_000;

function bridge_server(tools: ToolDefinition[], call: BridgeCall): McpServer {
  const server = new McpServer({ name: "codex", version: "1.0.0" });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema(tool.parameters as Parameters<typeof fromJsonSchema>[0]) }, async (given: unknown) => {
      const args = given !== null && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
      const outcome = await call(tool.name, args);
      return { content: [{ type: "text" as const, text: outcome.result }], ...(outcome.is_error ? { isError: true } : {}) };
    });
  }
  return server;
}

async function body_of(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > most_body_bytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function holds_token(request: IncomingMessage, expected: Buffer): boolean {
  const given = Buffer.from(String(request.headers.authorization ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Serves the tools until closed; a request without the run's token, or to any other path, is refused.
export async function open_tool_bridge(tools: ToolDefinition[], call: BridgeCall): Promise<ToolBridge> {
  const token = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${token}`;
  const expected = Buffer.from(authorization);
  const handler = createMcpHandler(() => bridge_server(tools, call));
  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") return void response.writeHead(404).end();
    if (!holds_token(request, expected)) return void response.writeHead(401).end();
    const reads_body = request.method !== "GET" && request.method !== "HEAD";
    const body = reads_body ? await body_of(request) : null;
    if (reads_body && body === null) return void response.writeHead(413).end();
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const aborted = new AbortController();
    response.on("close", () => aborted.abort());
    const reply = await handler.fetch(new Request(url, { method: request.method ?? "GET", headers, signal: aborted.signal, ...(body ? { body: new Uint8Array(body) } : {}) }));
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (!reply.body) return void response.end();
    Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
  };
  const server = createServer((request, response) => {
    answer(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: authorization },
    names: tools.map((tool) => tool.name),
    close: async () => {
      await handler.close?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
