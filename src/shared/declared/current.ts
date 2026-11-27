// The declarations in force where the store runs, and the reader of the files their secrets are in, set once by the
// server or the daemon, since reading a file needs Node. A secret is read when it is needed and never kept: not in
// the settings, sync, History, backups, logs or any call's answer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginRecords, SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { mcp_key_of, sends_outside, type McpListing, type McpServerRecord, type McpToolRecord } from "../mcp/model.ts";
import { no_declarations, type DeclaredConfig, type DeclaredPlugin, type DeclaredServer, type DeclaredSummary } from "./model.ts";

// ── Source ───────────────────────────────────────────────────────────────────

export interface DeclaredSource {
  declarations(): DeclaredConfig;
  // The secret in the file, trimmed; throws a plain error naming the file when it cannot be read or is empty.
  read_secret(path: string): string;
}

const none: DeclaredSource = {
  declarations: () => no_declarations,
  read_secret: () => {
    throw new Error("Secrets from files are read only where CODEX's data is: the server or the desktop app's daemon.");
  },
};

let current: DeclaredSource = none;

export function use_declared(source: DeclaredSource | null): void {
  current = source ?? none;
  listed.clear();
}

export function declarations(): DeclaredConfig {
  return current.declarations();
}

export function declared_plugin(plugin_id: string): DeclaredPlugin | undefined {
  return declarations().plugins.find((plugin) => plugin.plugin_id === plugin_id);
}

// The secret in a declared file, or the reason it could not be read; the message never holds what the file holds.
export function read_declared_secret(path: string): { secret: string } | { problem: string } {
  try {
    return { secret: current.read_secret(path) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

// ── Plugin records ───────────────────────────────────────────────────────────

// The stored records with each declared plugin on and its declared settings laid over, its secrets read from their
// files; a file that cannot be read leaves its field empty, so the plugin says it is not set up.
export function with_declared(stored: PluginRecords, config: DeclaredConfig = declarations()): PluginRecords {
  const records: PluginRecords = { ...stored };
  for (const plugin of config.plugins) {
    const secrets = Object.fromEntries(
      Object.entries(plugin.secret_files).map(([key, path]) => {
        const read = read_declared_secret(path);
        return [key, "secret" in read ? read.secret : ""];
      }),
    );
    const key_command: SettingValues = plugin.key_file ? { api_key_command: "" } : {};
    records[plugin.plugin_id] = {
      ...stored[plugin.plugin_id],
      enabled: true,
      settings: {
        ...stored[plugin.plugin_id]?.settings,
        ...plugin.settings,
        ...key_command,
        ...secrets,
      },
    };
  }
  return records;
}

// The records a plugin host writes with every declared plugin's record put back as stored, so nothing declared, and
// no secret read from a file, ever reaches the synced settings.
export function without_declared(written: PluginRecords, stored: PluginRecords, config: DeclaredConfig = declarations()): PluginRecords {
  const records: PluginRecords = { ...written };
  for (const plugin of config.plugins) {
    const kept = stored[plugin.plugin_id];
    if (kept) records[plugin.plugin_id] = kept;
    else delete records[plugin.plugin_id];
  }
  return records;
}

// ── MCP servers ──────────────────────────────────────────────────────────────

interface Listed {
  tools: McpToolRecord[];
  instructions: string;
  listed_at: string;
  problem: string;
}

// The tools each declared server listed, kept in memory on this device alone, by id.
const listed = new Map<string, Listed>();

// A declared server as the MCP connector takes it, its token read from its file now; null with the reason when the file cannot be read.
export function server_record(server: DeclaredServer, device_id: string): { record: McpServerRecord } | { problem: string } {
  let token = "";
  if (server.token_file) {
    const read = read_declared_secret(server.token_file);
    if ("problem" in read) return { problem: read.problem };
    token = read.secret;
  }
  const tools = listed.get(server.id)?.tools ?? [];
  const device = server.transport === "stdio" ? device_id : "";
  return {
    record: {
      id: server.id,
      name: server.name,
      transport: server.transport,
      address: server.address,
      token,
      command: server.command,
      args: server.args,
      variables: [],
      device,
      enabled: true,
      tools,
      instructions: listed.get(server.id)?.instructions ?? "",
      listed_at: listed.get(server.id)?.listed_at ?? "",
    },
  };
}

export function declared_server(id: string): DeclaredServer | undefined {
  return declarations().mcp_servers.find((server) => server.id === id);
}

// Lists one declared server's tools again and keeps them in memory, or keeps why it could not.
export async function list_declared_server(
  server: DeclaredServer,
  device_id: string,
  list: (record: McpServerRecord) => Promise<McpListing>,
): Promise<void> {
  const made = server_record(server, device_id);
  if ("problem" in made) {
    listed.set(server.id, {
      tools: listed.get(server.id)?.tools ?? [],
      instructions: listed.get(server.id)?.instructions ?? "",
      listed_at: listed.get(server.id)?.listed_at ?? "",
      problem: made.problem,
    });
    return;
  }
  try {
    listed.set(server.id, {
      ...(await list(made.record)),
      listed_at: new Date().toISOString(),
      problem: "",
    });
  } catch (error) {
    listed.set(server.id, {
      tools: listed.get(server.id)?.tools ?? [],
      instructions: listed.get(server.id)?.instructions ?? "",
      listed_at: listed.get(server.id)?.listed_at ?? "",
      problem: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

// What the page is shown: every declared entry with its settings and problems, but no file's path or content.
export function declared_summary(config: DeclaredConfig = declarations()): DeclaredSummary {
  return {
    plugins: config.plugins.map((plugin) => ({
      plugin_id: plugin.plugin_id,
      settings: plugin.settings,
      secret_fields: Object.keys(plugin.secret_files),
      has_key_file: plugin.key_file !== "",
      problems: [
        ...plugin.problems,
        ...[...Object.values(plugin.secret_files), ...(plugin.key_file ? [plugin.key_file] : [])].flatMap((path) => {
          const read = read_declared_secret(path);
          return "problem" in read ? [read.problem] : [];
        }),
      ],
    })),
    engine: config.engine,
    embedder: config.embedder,
    mcp_servers: config.mcp_servers.map((server) => {
      const known = listed.get(server.id);
      return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        address: server.address,
        has_token_file: server.token_file !== "",
        command: server.command,
        args: server.args,
        tools: (known?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          read_only: tool.read_only,
        })),
        listed_at: known?.listed_at ?? "",
        key: mcp_key_of(server.id),
        sends_outside: sends_outside(server),
        problem: known?.problem ?? "",
      };
    }),
    problems: config.problems,
  };
}
