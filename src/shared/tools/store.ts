// Tool plugins: prebuilt tools an engine may use beside CODEX's own calls, listed with the user's marks, which tools
// are offered and the level of each that changes something. Setting any of them is the user's alone, at the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "../api_schemas.ts";
import { define_feature } from "../feature.ts";
import { is_policy_level, policy_levels, type PolicyLevel } from "../policy/model.ts";
import { level_of, policy_setting, stored_levels } from "../policy/policy.ts";
import { settings_feature } from "../settings.ts";
import { tool_mark_names, tool_plugins_setting, type ToolMarkName, type ToolOfferName, type ToolPluginEntry, type ToolPluginRecord } from "./model.ts";
import { open_plugin_tools, open_tool_plugins, stored_tool_plugins } from "./offered.ts";

// ── Listing ──────────────────────────────────────────────────────────────────

// Every tool plugin running, with its marks and each tool's facts, whether it is offered and its level.
async function list_plugin_tools(database: SqlDatabase): Promise<ToolPluginEntry[]> {
  return (await open_tool_plugins(database)).map((plugin) => ({
    key: plugin.key,
    plugin_id: plugin.plugin_id,
    label: plugin.label,
    ...plugin.marks,
    problem: plugin.problem,
    tools: plugin.tools.map((tool) => ({
      name: tool.name,
      tool: tool.tool.name,
      description: tool.tool.description,
      changes: tool.tool.changes,
      sends_outside: tool.tool.sends_outside,
      enabled: tool.enabled,
      small: tool.small,
      level: tool.tool.changes ? level_of(database, tool.name) : null,
    })),
  }));
}

// ── Setting ──────────────────────────────────────────────────────────────────

function checked_key(key: string): string {
  if (typeof key !== "string" || !key.includes("/")) throw new Error("Name the tool plugin by its key, such as codex.web/web, from list_plugin_tools.");
  return key;
}

function write_record(database: SqlDatabase, key: string, change: (record: ToolPluginRecord) => ToolPluginRecord): void {
  const stored = stored_tool_plugins(database);
  settings_feature.methods.set_setting(database, tool_plugins_setting, { ...stored, [key]: change(stored[key] ?? {}) });
}

function set_tool_plugin_mark(database: SqlDatabase, key: string, mark: ToolMarkName, on: boolean): void {
  checked_key(key);
  if (!tool_mark_names.includes(mark)) throw new Error(`A mark is one of ${tool_mark_names.join(", ")}.`);
  if (typeof on !== "boolean") throw new Error("Turn a mark on with true or off with false.");
  write_record(database, key, (record) => ({ ...record, [mark]: on }));
}

function set_plugin_tool_offer(database: SqlDatabase, key: string, tool: string, offer: ToolOfferName, on: boolean): void {
  checked_key(key);
  if (typeof tool !== "string" || !tool) throw new Error("Name the tool by its own name, from list_plugin_tools.");
  if (offer !== "enabled" && offer !== "small") throw new Error("An offer is enabled or small.");
  if (typeof on !== "boolean") throw new Error("Turn it on with true or off with false.");
  write_record(database, key, (record) => {
    const given = { ...record.tools?.[tool] };
    if (offer === "enabled") given.off = !on;
    else given.small = on;
    return { ...record, tools: { ...record.tools, [tool]: given } };
  });
}

async function set_plugin_tool_level(database: SqlDatabase, name: string, level: PolicyLevel): Promise<void> {
  if (!is_policy_level(level)) throw new Error(`A level is one of ${policy_levels.join(", ")}.`);
  const tool = (await open_plugin_tools(database)).find((each) => each.name === name);
  if (!tool) throw new Error(`There is no plugin tool named ${name}; list_plugin_tools lists them.`);
  if (!tool.tool.changes) throw new Error(`${name} only reads, so it runs at once and has no level.`);
  settings_feature.methods.set_setting(database, policy_setting, { ...stored_levels(database), [name]: level });
}

// ── Feature ──────────────────────────────────────────────────────────────────

const key_schema = text("The tool plugin's key: its plugin's id and the id it provides its tools under, such as codex.web/web, from list_plugin_tools.");

export const tools_feature = define_feature({
  id: "tools",
  migrations: [],
  tables: [],
  methods: { list_plugin_tools, set_tool_plugin_mark, set_plugin_tool_offer, set_plugin_tool_level },
  api: {
    list_plugin_tools: {
      description:
        "Lists each tool plugin running, such as Web, with its three marks (send_to_hosted: what its tools give back may be sent to a hosted engine, which without it is not offered them, on until set for the bundled Web plugin alone and off until set for every other plugin and MCP server; trusted: what its tools give back does not make the assistant's changes wait; after_private: its tools that send their arguments outside this machine may still be used after the conversation read a source not marked for hosted engines), and each of its tools: the name the assistant sees, what it does, whether it changes something or sends its arguments outside, whether it is offered, whether small models are offered it too, and the level of one that changes something.",
      params: [],
    },
    set_tool_plugin_mark: {
      description: "Turns one of a tool plugin's three marks on or off. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "key", schema: key_schema },
        { name: "mark", schema: { type: "string", enum: tool_mark_names, description: "send_to_hosted, trusted or after_private." } },
        { name: "on", schema: { type: "boolean", description: "True to turn it on, false to turn it off." } },
      ],
    },
    set_plugin_tool_offer: {
      description:
        "Turns one plugin tool on or off for the assistant (enabled), or offers it to models with a small context too (small). Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "key", schema: key_schema },
        { name: "tool", schema: text("The tool's own name within its plugin, such as web_fetch, from list_plugin_tools.") },
        { name: "offer", schema: { type: "string", enum: ["enabled", "small"], description: "enabled: offered at all; small: also offered to models with a small context." } },
        { name: "on", schema: { type: "boolean", description: "True to turn it on, false to turn it off." } },
      ],
    },
    set_plugin_tool_level: {
      description: "Sets how freely the assistant may use one plugin tool that changes something. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "name", schema: text("The tool's name as the assistant sees it, such as web__web_fetch, from list_plugin_tools.") },
        {
          name: "level",
          schema: {
            type: "string",
            enum: policy_levels,
            description: "restricted: never; proposal: only once the user approves it; auto: by the assistant while the user is in the conversation; background: also by background jobs with nobody present.",
          },
        },
      ],
    },
  },
  setting_defaults: { [tool_plugins_setting]: {} },
});
