// Every plugin where the store runs on Node, the server or the desktop daemon: the bundled collectors, Files among
// them, the bundled engines, embedder and tool plugins, Firefox bookmarks on the desktop alone, and any from the plugins folder.

// ── Imports ──────────────────────────────────────────────────────────────────

import { load_plugin_folder } from "@x-tech-laboratories/x-libs/plugin_folder";

import { network_plugins } from "../../shared/collectors/bundled.ts";
import { embedder_plugins } from "../embedders/openai.ts";
import { engine_plugins } from "../engines/index.ts";
import { use_mcp_connector } from "../../shared/mcp/connector.ts";
import { node_mcp_connector } from "../tools/mcp_client.ts";
import { tool_plugins } from "../tools/web.ts";
import { use_plugins, type ContextPlugin, type ContextPluginApi } from "../../shared/collectors/host.ts";
import { bookmarks_plugin } from "./bookmarks.ts";
import { files_plugin } from "./files.ts";

// ── Plugins ──────────────────────────────────────────────────────────────────

export const bundled_plugins: ContextPlugin[] = [files_plugin, ...network_plugins, ...engine_plugins, ...embedder_plugins, ...tool_plugins];

// The ones that read what only the user's own computer has, such as Firefox's profile.
export const desktop_plugins: ContextPlugin[] = [bookmarks_plugin];

// Hands the store the bundled plugins, the desktop's where asked, and the plugins folder's, if one is given, and the
// connector its MCP servers are reached through; a broken plugin is reported and skipped.
export async function load_collectors(plugins_folder: string | null, on_desktop = false): Promise<void> {
  const from_folder: ContextPlugin[] = [];
  if (plugins_folder) {
    const loaded = await load_plugin_folder<ContextPluginApi>(plugins_folder, "server");
    for (const problem of loaded.problems) console.warn(`plugin ${problem.name}: ${problem.problem}`);
    from_folder.push(...loaded.plugins);
  }
  use_plugins([...bundled_plugins, ...(on_desktop ? desktop_plugins : []), ...from_folder]);
  use_mcp_connector(node_mcp_connector);
}
