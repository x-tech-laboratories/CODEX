// The bundled plugin `codex.mcp`: each MCP server the user added and left on is a tool plugin of its own, its tools
// the ones it listed when added or refreshed, so opening the plugin host starts no server. A tool the server marks
// read-only reads; every other one changes something. Its tools send outside unless it is a local command or answers on
// a loopback address. Its descriptions and instructions are the server's own words, so they reach the engine fenced. A local command is
// offered only on the device that added it, so a command synced from one machine never starts on another.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { declarations, server_record } from "../declared/current.ts";
import { device_id_of } from "../jobs/records.ts";
import type { ToolPlugin } from "../tools/tool.ts";
import { mcp_connector } from "./connector.ts";
import { mcp_manifest, mcp_provider_of, runs_on, sends_outside, type McpServerRecord } from "./model.ts";
import { read_servers } from "./records.ts";

// ── Plugin ───────────────────────────────────────────────────────────────────

export function server_tools(server: McpServerRecord): ToolPlugin {
  const outside = sends_outside(server);
  return {
    label: server.name,
    own_words: false,
    // What the server said of how to use it, its own words, so fenced like its descriptions.
    ...(server.instructions ? { guidance: server.instructions } : {}),
    tools: () => server.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.input_schema, changes: !tool.read_only, sends_outside: outside })),
    call: (name, args, signal) => mcp_connector().call_tool(server, name, args, signal),
  };
}

export function mcp_plugin(database: SqlDatabase): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...mcp_manifest,
    start: (context) => {
      const here = device_id_of(database);
      for (const server of read_servers(database)) if (server.enabled && runs_on(server, here)) context.provide("tools", mcp_provider_of(server.id), server_tools(server));
      // The servers this computer's configuration declares, each with its token read from its file now.
      for (const declared of declarations().mcp_servers) {
        const made = server_record(declared, here);
        if ("record" in made) context.provide("tools", mcp_provider_of(declared.id), server_tools(made.record));
      }
    },
  });
}
