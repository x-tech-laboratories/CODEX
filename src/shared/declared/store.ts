// What this computer's configuration declares, shown to the user at CODEX's own page alone: no token, MCP client or
// engine may read it, and nothing here changes it, since it is changed where it is written.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of } from "../api_schemas.ts";
import { define_feature } from "../feature.ts";
import { device_id_of } from "../jobs/records.ts";
import { mcp_connector } from "../mcp/connector.ts";
import { declared_server, declared_summary, list_declared_server } from "./current.ts";
import type { DeclaredSummary } from "./model.ts";

// ── Store ────────────────────────────────────────────────────────────────────

function get_declared_config(_database: SqlDatabase): DeclaredSummary {
  return declared_summary();
}

// Lists a declared MCP server's tools again, keeping them in memory on this device, or why they could not be listed.
async function refresh_declared_mcp_server(database: SqlDatabase, id: string): Promise<DeclaredSummary> {
  const server = declared_server(id);
  if (!server) throw new Error(`This computer's configuration declares no MCP server ${id}.`);
  await mcp_connector().forget(id);
  await list_declared_server(server, device_id_of(database), (record) => mcp_connector().list_tools(record));
  return declared_summary();
}

export const declared_feature = define_feature({
  id: "declared",
  migrations: [],
  tables: [],
  methods: { get_declared_config, refresh_declared_mcp_server },
  api: {
    get_declared_config: {
      description:
        "What this computer's configuration declares: its engines, embedder, collectors, Web plugin and MCP servers with their settings, which secrets are read from files (never what the files hold), the tools each declared MCP server listed and what is wrong with any entry. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [],
    },
    refresh_declared_mcp_server: {
      description:
        "Lists the tools of an MCP server this computer's configuration declares again. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "id", schema: id_of("declared MCP server") }],
    },
  },
});
