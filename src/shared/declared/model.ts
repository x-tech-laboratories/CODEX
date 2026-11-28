// What this computer's configuration declares, such as a NixOS module writes: engines, the embedder, the X-Tasks and
// Trilium collectors, the Web plugin and MCP servers, each of which may name the collector for its app, each secret
// named only by the path of a file holding it. Declared
// entries are this device's alone: never synced, never stored in the settings, and not changed from the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { fits, type PluginManifest, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { trilium_manifest, x_tasks_manifest } from "../collectors/manifests.ts";
import { embedder_manifests, openai_embedder_id } from "../embedders/manifests.ts";
import { anthropic_engine_id, engine_manifests, openai_engine_id, smartharness_engine_id } from "../engines/manifests.ts";
import { tool_manifests, web_manifest } from "../tools/manifests.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One plugin as declared: the settings given, each secret field's file and, for an engine or embedder, its key's file.
export interface DeclaredPlugin {
  plugin_id: string;
  settings: SettingValues;
  // A secret field's key, such as token, to the path of the file holding it.
  secret_files: Record<string, string>;
  // The file holding the API key, for an engine or the embedder; empty for none.
  key_file: string;
  // What was wrong with the entry, in plain words; what was right of it still holds.
  problems: string[];
}

export type DeclaredTransport = "http" | "stdio";

export interface DeclaredServer {
  // Made from the declared id, such as cfg-x-budget, so it never meets a server the user added.
  id: string;
  name: string;
  transport: DeclaredTransport;
  address: string;
  // The file holding the bearer token; empty for none.
  token_file: string;
  command: string;
  args: string[];
  // The id of the collector for the same app, such as x-tasks, whose specialist is given this server's tools; empty for
  // none, when the server is a tool plugin with a specialist of its own.
  collector: string;
}

export interface DeclaredConfig {
  plugins: DeclaredPlugin[];
  // The engine that answers and the embedder the index uses, by the id each is provided under; null when not declared.
  engine: string | null;
  embedder: string | null;
  mcp_servers: DeclaredServer[];
  // What was wrong with the file as a whole or an entry left out, in plain words.
  problems: string[];
}

export const no_declarations: DeclaredConfig = {
  plugins: [],
  engine: null,
  embedder: null,
  mcp_servers: [],
  problems: [],
};

// The words Settings shows on every declared entry.
export const declared_words = "Set by this computer's configuration";

// What the page is told of the declarations: everything but the files' paths, which name where the secrets live.
export interface DeclaredSummary {
  plugins: {
    plugin_id: string;
    settings: SettingValues;
    secret_fields: string[];
    has_key_file: boolean;
    problems: string[];
  }[];
  engine: string | null;
  embedder: string | null;
  mcp_servers: DeclaredServerSummary[];
  problems: string[];
}

export interface DeclaredServerSummary {
  id: string;
  name: string;
  transport: DeclaredTransport;
  address: string;
  has_token_file: boolean;
  command: string;
  args: string[];
  // The collector whose specialist is given its tools; empty for none.
  collector: string;
  tools: { name: string; description: string; read_only: boolean }[];
  listed_at: string;
  // The key its marks and tool choices are kept under.
  key: string;
  sends_outside: boolean;
  // Why its tools could not be listed, or its token file read; empty when they were.
  problem: string;
}

// ── Reading ──────────────────────────────────────────────────────────────────

const engine_ids: Record<string, string> = {
  "codex.anthropic": anthropic_engine_id,
  "codex.openai": openai_engine_id,
  "codex.smartharness": smartharness_engine_id,
};

const source_manifests = [x_tasks_manifest, trilium_manifest];

const is_record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const text_of = (value: unknown) => (typeof value === "string" ? value.trim() : "");

// The entry's settings checked against its manifest: a secret only from `<key>_file`, an engine's key only from key_file.
function declared_plugin(manifest: PluginManifest, entry: unknown, with_key: boolean): DeclaredPlugin {
  const plugin: DeclaredPlugin = {
    plugin_id: manifest.id,
    settings: {},
    secret_files: {},
    key_file: "",
    problems: [],
  };
  if (!is_record(entry)) {
    plugin.problems.push(`${manifest.name} is not a set of settings.`);
    return plugin;
  }
  const fields = manifest.settings ?? [];
  for (const [key, value] of Object.entries(entry)) {
    if (with_key && key === "key_file") {
      if (text_of(value)) plugin.key_file = text_of(value);
      else plugin.problems.push(`${manifest.name}'s key_file is not a path.`);
      continue;
    }
    const secret = fields.find((field) => field.type === "text" && field.secret && `${field.key}_file` === key);
    if (secret) {
      if (text_of(value)) plugin.secret_files[secret.key] = text_of(value);
      else plugin.problems.push(`${manifest.name}'s ${key} is not a path.`);
      continue;
    }
    const field = fields.find((each) => each.key === key);
    if (!field || field.key === "api_key_command") {
      plugin.problems.push(`${manifest.name} has no setting ${key}${field ? "; name a key_file instead" : ""}.`);
      continue;
    }
    if (field.type === "text" && field.secret) {
      plugin.problems.push(`${manifest.name}'s ${key} is a secret; give the file holding it as ${key}_file.`);
      continue;
    }
    if (!fits(field, value)) {
      plugin.problems.push(`${manifest.name}'s ${key} does not fit: ${JSON.stringify(value)}.`);
      continue;
    }
    plugin.settings[key] = value as SettingValues[string];
  }
  return plugin;
}

// The plugins under one heading, such as engines, keyed by plugin id; an id not among those offered is left out.
function plugins_under(heading: string, value: unknown, manifests: PluginManifest[], with_key: boolean, problems: string[]): DeclaredPlugin[] {
  if (value === undefined) return [];
  if (!is_record(value)) {
    problems.push(`${heading} is not a set of plugins by id.`);
    return [];
  }
  const found: DeclaredPlugin[] = [];
  for (const [id, entry] of Object.entries(value)) {
    const manifest = manifests.find((each) => each.id === id);
    if (manifest) found.push(declared_plugin(manifest, entry, with_key));
    else problems.push(`${heading} has no plugin ${id}; it takes ${manifests.map((each) => each.id).join(", ")}.`);
  }
  return found;
}

const server_id_pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A collector's id as plugins provide it, such as x-tasks.
const collector_id_pattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function declared_server(entry: unknown, index: number, problems: string[]): DeclaredServer | null {
  if (!is_record(entry)) {
    problems.push(`MCP server ${index + 1} is not a set of fields.`);
    return null;
  }
  const own_id = text_of(entry.id);
  if (!server_id_pattern.test(own_id) || own_id.length > 30) {
    problems.push(`MCP server ${index + 1} needs an id of lowercase letters, digits and single hyphens, such as x-budget.`);
    return null;
  }
  const name = text_of(entry.name) || own_id;
  let collector = "";
  if (entry.collector !== undefined) {
    collector = text_of(entry.collector);
    if (!collector_id_pattern.test(collector)) {
      problems.push(`MCP server ${own_id}'s collector must be a collector's id, such as x-tasks or trilium; it is linked to none.`);
      collector = "";
    }
  }
  const command = text_of(entry.command);
  const address = text_of(entry.address);
  if (command && address) {
    problems.push(`MCP server ${own_id} gives both an address and a command; give one.`);
    return null;
  }
  if (command) {
    const args = Array.isArray(entry.args) ? entry.args.filter((each): each is string => typeof each === "string") : [];
    return {
      id: `cfg-${own_id}`,
      name,
      transport: "stdio",
      address: "",
      token_file: "",
      command,
      args,
      collector,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    problems.push(`MCP server ${own_id} needs a whole address, such as https://mcp.example.org/mcp, or a command.`);
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    problems.push(`MCP server ${own_id}'s address must start with http:// or https:// and hold no user or password.`);
    return null;
  }
  return {
    id: `cfg-${own_id}`,
    name,
    transport: "http",
    address: parsed.href,
    token_file: text_of(entry.token_file),
    command: "",
    args: [],
    collector,
  };
}

// The file's JSON as declarations; whatever is wrong is said in problems and left out, never thrown.
export function read_declarations(value: unknown): DeclaredConfig {
  if (value === undefined || value === null) return no_declarations;
  if (!is_record(value))
    return {
      ...no_declarations,
      problems: ["The configuration is not a JSON object."],
    };
  const problems: string[] = [];
  const known = new Set(["engines", "engine", "embedder", "sources", "web", "mcp_servers"]);
  for (const key of Object.keys(value)) if (!known.has(key)) problems.push(`The configuration has no part ${key}; it takes ${[...known].join(", ")}.`);
  const engines = plugins_under("engines", value.engines, engine_manifests, true, problems);
  const embedders = value.embedder === undefined ? [] : [declared_plugin(embedder_manifests[0]!, value.embedder, true)];
  const sources = plugins_under("sources", value.sources, source_manifests, false, problems);
  const web = value.web === undefined ? [] : [declared_plugin(web_manifest, value.web, false)];
  let engine: string | null = null;
  if (value.engine !== undefined) {
    const named = text_of(value.engine);
    const declared_ids = engines.map((plugin) => engine_ids[plugin.plugin_id]);
    if (declared_ids.includes(named)) engine = named;
    else
      problems.push(
        `engine names ${JSON.stringify(value.engine)}, which is not a declared engine; it takes ${declared_ids.join(", ") || "none, as no engine is declared"}.`,
      );
  } else if (engines.length === 1) engine = engine_ids[engines[0]!.plugin_id]!;
  const servers: DeclaredServer[] = [];
  if (value.mcp_servers !== undefined) {
    if (!Array.isArray(value.mcp_servers)) problems.push("mcp_servers is not a list.");
    else
      value.mcp_servers.forEach((entry, index) => {
        const server = declared_server(entry, index, problems);
        if (!server) return;
        if (servers.some((each) => each.id === server.id)) problems.push(`MCP server ${server.id.slice(4)} is declared twice; the first holds.`);
        else {
          // One server per collector, so its specialist has one app's tools.
          if (server.collector && servers.some((each) => each.collector === server.collector)) {
            problems.push(`MCP servers ${servers.find((each) => each.collector === server.collector)!.id.slice(4)} and ${server.id.slice(4)} both name the collector ${server.collector}; the first holds.`);
            server.collector = "";
          }
          servers.push(server);
        }
      });
  }
  return {
    plugins: [...engines, ...embedders, ...sources, ...web],
    engine,
    embedder: embedders.length > 0 ? openai_embedder_id : null,
    mcp_servers: servers,
    problems,
  };
}

// The plugin ids a declaration can name, for the docs and tests.
export const declarable_plugin_ids = [...engine_manifests, ...embedder_manifests, ...source_manifests, ...tool_manifests].map((manifest) => manifest.id);
