// The MCP servers the user adds as tool plugins: added, changed, refreshed, moved and removed by the user alone at
// CODEX's own page, each checked by listing its tools as it is saved, and listed for anyone with its token hidden. A
// local command runs only on the device that added it, until the user moves it to another after reading the command.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of } from "../api_schemas.ts";
import { declared_server } from "../declared/current.ts";
import { declared_words } from "../declared/model.ts";
import { define_feature } from "../feature.ts";
import { device_id_of, list_devices } from "../jobs/records.ts";
import { mcp_connector } from "./connector.ts";
import { mcp_key_of, mcp_servers_setting, runs_on, sends_outside, type McpCommandConfirmation, type McpServerFields, type McpServerRecord, type McpServerSummary } from "./model.ts";
import { read_servers, write_servers } from "./records.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

// The longest description a listing shows; the engine is shown up to its own limit.
const listed_description = 300;

function summary_of(database: SqlDatabase, server: McpServerRecord): McpServerSummary {
  const device_name = server.device ? (list_devices(database).find((device) => device.id === server.device)?.name ?? "") : "";
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    address: server.address,
    has_token: server.token !== "",
    command: server.command,
    args: server.args,
    variables: server.variables,
    enabled: server.enabled,
    tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description.length > listed_description ? `${tool.description.slice(0, listed_description - 1)}…` : tool.description, read_only: tool.read_only })),
    listed_at: server.listed_at,
    key: mcp_key_of(server.id),
    sends_outside: sends_outside(server),
    runs_here: runs_on(server, device_id_of(database)),
    device: server.device,
    device_name,
  };
}

function server_of(database: SqlDatabase, id: string): McpServerRecord {
  const declared = declared_server(id);
  if (declared) throw new Error(`${declared.name} is ${declared_words.toLowerCase()}, so it is changed there, not here.`);
  const found = read_servers(database).find((server) => server.id === id);
  if (!found) throw new Error(`There is no MCP server ${id} under Settings → Plugins.`);
  return found;
}

function list_mcp_servers(database: SqlDatabase): McpServerSummary[] {
  return read_servers(database).map((server) => summary_of(database, server));
}

// ── Checking ─────────────────────────────────────────────────────────────────

const variable_name = /^[A-Za-z_][A-Za-z0-9_]*$/;

// An id from the name, such as "files", that no other server has: letters, digits and single hyphens.
function new_server_id(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "server";
  let id = base;
  for (let number = 2; taken.has(id); number++) id = `${base}-${number}`;
  return id;
}

// The fields made whole and checked: a name; for http a whole http or https address; for stdio a program and the
// names of the variables passed on. Throws a plain error saying what is wrong.
function checked_fields(fields: McpServerFields, stored?: McpServerRecord): Omit<McpServerRecord, "id" | "tools" | "listed_at" | "device"> {
  if (!fields || typeof fields !== "object") throw new Error("Give the server's name and how to reach it.");
  const name = String(fields.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Give the server a name, such as Files.");
  if (fields.transport !== "http" && fields.transport !== "stdio") throw new Error("A server is reached over http, at an address, or started as a local command over stdio.");
  const enabled = fields.enabled ?? stored?.enabled ?? true;
  if (fields.transport === "http") {
    const address = String(fields.address ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(address);
    } catch {
      throw new Error("Give the server's whole address, such as https://mcp.example.org/mcp.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("The address must start with http:// or https://.");
    if (parsed.username || parsed.password) throw new Error("Give a token in its own field, not in the address.");
    const token = fields.token === null || fields.token === undefined ? (stored?.transport === "http" ? stored.token : "") : String(fields.token).trim();
    return { name, transport: "http", address: parsed.href, token, command: "", args: [], variables: [], enabled };
  }
  const command = String(fields.command ?? "").trim();
  if (!command) throw new Error("Give the program that starts the server, such as /run/current-system/sw/bin/mcp-server-files.");
  const args = Array.isArray(fields.args) ? fields.args.map(String) : [];
  const variables = (Array.isArray(fields.variables) ? fields.variables.map((each) => String(each).trim()) : []).filter(Boolean);
  const wrong = variables.find((each) => !variable_name.test(each));
  if (wrong !== undefined) throw new Error(`${wrong} is not a variable's name; give names alone, such as GITHUB_TOKEN.`);
  return { name, transport: "stdio", address: "", token: "", command, args, variables: [...new Set(variables)], enabled };
}

// How to reach a server changed, so its tools are listed again and its connection closed.
function reached_differently(before: McpServerRecord, after: Omit<McpServerRecord, "id" | "tools" | "listed_at" | "device">): boolean {
  return JSON.stringify([before.transport, before.address, before.token, before.command, before.args, before.variables]) !== JSON.stringify([after.transport, after.address, after.token, after.command, after.args, after.variables]);
}

// Where a server runs, in plain words, for a refusal.
function where_it_runs(database: SqlDatabase, server: McpServerRecord): string {
  const name = summary_of(database, server).device_name;
  return name ? `It runs on ${name}` : server.device ? "It runs on another device" : "No device was recorded for it";
}

// Refuses to start a local server on a device other than the one that added it.
function check_runs_here(database: SqlDatabase, server: McpServerRecord): void {
  if (!runs_on(server, device_id_of(database))) throw new Error(`${server.name} is a command on another device. ${where_it_runs(database, server)}; move it to this device first, after reading its command.`);
}

// The server with the tools it lists now and its instructions; fails, saying why, when it cannot be reached.
async function listed(server: McpServerRecord): Promise<McpServerRecord> {
  const { tools, instructions } = await mcp_connector().list_tools(server);
  return { ...server, tools, instructions, listed_at: new Date().toISOString() };
}

// ── Writing ──────────────────────────────────────────────────────────────────

async function add_mcp_server(database: SqlDatabase, fields: McpServerFields): Promise<string> {
  const checked = checked_fields(fields);
  const id = new_server_id(checked.name, new Set(read_servers(database).map((server) => server.id)));
  const device = checked.transport === "stdio" ? device_id_of(database) : "";
  const server = await listed({ id, ...checked, device, tools: [], listed_at: "" });
  await mcp_connector().forget(id);
  const servers = read_servers(database);
  if (servers.some((each) => each.id === id)) throw new Error("Another server was just added under that name; try again.");
  write_servers(database, [...servers, server]);
  return id;
}

async function change_mcp_server(database: SqlDatabase, id: string, fields: McpServerFields): Promise<void> {
  const stored = server_of(database, id);
  const checked = checked_fields(fields, stored);
  const changed = reached_differently(stored, checked);
  // A command typed here runs here; a command kept from another device stays there and is not started here.
  const device = checked.transport === "http" ? "" : stored.transport === "stdio" ? stored.device : device_id_of(database);
  const server = { ...stored, ...checked, device };
  if (changed && stored.transport === "stdio" && checked.transport === "stdio") check_runs_here(database, stored);
  if (changed) Object.assign(server, await listed(server));
  if (changed || !server.enabled) await mcp_connector().forget(id);
  write_servers(database, read_servers(database).map((each) => (each.id === id ? server : each)));
}

async function refresh_mcp_server(database: SqlDatabase, id: string): Promise<McpServerSummary> {
  const stored = server_of(database, id);
  check_runs_here(database, stored);
  await mcp_connector().forget(id);
  const server = await listed(stored);
  write_servers(database, read_servers(database).map((each) => (each.id === id ? { ...each, tools: server.tools, instructions: server.instructions ?? "", listed_at: server.listed_at } : each)));
  return summary_of(database, server);
}

// Makes a local server run on this device instead, once the user has read its command: the program and arguments given
// must be the ones stored, so a command changed since it was shown is not started.
async function move_mcp_server_here(database: SqlDatabase, id: string, confirmed: McpCommandConfirmation): Promise<McpServerSummary> {
  const stored = server_of(database, id);
  if (stored.transport !== "stdio") throw new Error(`${stored.name} is reached at an address, which works from every device already.`);
  const here = device_id_of(database);
  if (stored.device === here) return summary_of(database, stored);
  if (!confirmed || typeof confirmed !== "object" || confirmed.command !== stored.command || JSON.stringify(confirmed.args) !== JSON.stringify(stored.args))
    throw new Error(`${stored.name}'s command is not the one you were shown; read it again before moving it.`);
  await mcp_connector().forget(id);
  const server = await listed({ ...stored, device: here });
  write_servers(database, read_servers(database).map((each) => (each.id === id ? server : each)));
  return summary_of(database, server);
}

async function remove_mcp_server(database: SqlDatabase, id: string): Promise<void> {
  server_of(database, id);
  await mcp_connector().forget(id);
  write_servers(database, read_servers(database).filter((server) => server.id !== id));
}

// ── Feature ──────────────────────────────────────────────────────────────────

const fields_schema = {
  type: "object",
  description: "The server: its name, and how it is reached.",
  properties: {
    name: { type: "string", description: "What CODEX calls the server, such as Files." },
    transport: { type: "string", enum: ["http", "stdio"], description: "http: reached at an address over streamable HTTP; stdio: started on this machine as a local command." },
    address: { type: "string", description: "For http: the address the server answers at, such as https://mcp.example.org/mcp." },
    token: { type: ["string", "null"], description: "For http: a bearer token sent with each request, empty for none; null keeps the one stored." },
    command: { type: "string", description: "For stdio: the program that starts the server, run without a shell." },
    args: { type: "array", items: { type: "string" }, description: "For stdio: its arguments, one each." },
    variables: { type: "array", items: { type: "string" }, description: "For stdio: names of CODEX's own environment variables passed to it, such as GITHUB_TOKEN." },
    enabled: { type: "boolean", description: "Whether the assistant is offered its tools; on unless turned off." },
  },
  required: ["name", "transport"],
  additionalProperties: false,
};

export const mcp_feature = define_feature({
  id: "mcp",
  migrations: [],
  tables: [],
  methods: { list_mcp_servers, add_mcp_server, change_mcp_server, refresh_mcp_server, move_mcp_server_here, remove_mcp_server },
  api: {
    list_mcp_servers: {
      description:
        "Lists the MCP servers whose tools the assistant may use: each one's name, whether it is reached at an address or started as a local command (with the program, its arguments and the variables passed to it), whether a token is set (never the token), whether it is on, whether its tools send outside this machine, whether it runs on this device (a local command runs only on the device that added it, named here) and the tools it listed, each read-only or not.",
      params: [],
    },
    add_mcp_server: {
      description: "Adds an MCP server after listing its tools, which starts a local one; a local one runs only on this device. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "fields", schema: fields_schema }],
    },
    change_mcp_server: {
      description: "Changes an MCP server, listing its tools again when how it is reached changed. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("MCP server") },
        { name: "fields", schema: fields_schema },
      ],
    },
    refresh_mcp_server: {
      description: "Lists an MCP server's tools again; a local one only on the device it runs on. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "id", schema: id_of("MCP server") }],
    },
    move_mcp_server_here: {
      description:
        "Makes a local MCP server run on this device instead of the one that added it, starting it here to list its tools. The program and arguments given must be the ones stored, as shown to the user. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("MCP server") },
        {
          name: "confirmed",
          schema: {
            type: "object",
            description: "The command as the user read it.",
            properties: { command: { type: "string", description: "The program." }, args: { type: "array", items: { type: "string" }, description: "Its arguments, one each." } },
            required: ["command", "args"],
            additionalProperties: false,
          },
        },
      ],
    },
    remove_mcp_server: {
      description: "Removes an MCP server, stopping a local one. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "id", schema: id_of("MCP server") }],
      destructive: true,
    },
  },
  setting_defaults: { [mcp_servers_setting]: [] },
});
