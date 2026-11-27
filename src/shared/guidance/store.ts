// Guidance per plugin: what the user writes, in Markdown, about how a tool plugin or source app works, which its
// specialist is given whole and the run asking it shortened. Setting it is the user's alone, at the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "../api_schemas.ts";
import { define_feature } from "../feature.ts";
import { settings_feature } from "../settings.ts";
import { guidance_in, guidance_setting, longest_guidance } from "./model.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

export function stored_guidance(database: SqlDatabase): Record<string, string> {
  const saved = settings_feature.methods.get_settings(database)[guidance_setting];
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.keys(saved).map((source) => [source, guidance_in(saved, source)]).filter(([, said]) => said !== ""));
}

export function user_guidance_of(database: SqlDatabase, source: string): string {
  return stored_guidance(database)[source] ?? "";
}

// ── Writing ──────────────────────────────────────────────────────────────────

// Keeps the user's guidance for one source; empty text takes it away.
function set_plugin_guidance(database: SqlDatabase, source: string, guidance: string): void {
  if (typeof source !== "string" || !source.trim()) throw new Error("Name the source by a collector's id, such as x-tasks, or a tool plugin's, such as tool:codex.web/web.");
  if (typeof guidance !== "string") throw new Error("Give the guidance as text.");
  const trimmed = guidance.trim();
  if (trimmed.length > longest_guidance) throw new Error(`Guidance may be at most ${longest_guidance.toLocaleString("en")} characters.`);
  const kept = stored_guidance(database);
  if (trimmed) kept[source] = trimmed;
  else delete kept[source];
  settings_feature.methods.set_setting(database, guidance_setting, kept);
}

// ── Feature ──────────────────────────────────────────────────────────────────

export const guidance_feature = define_feature({
  id: "guidance",
  migrations: [],
  tables: [],
  methods: { set_plugin_guidance },
  api: {
    set_plugin_guidance: {
      description:
        "Keeps the user's guidance, in Markdown, on how one tool plugin or source app works, which the assistant's specialist for it is given whole and the conversation shortened; empty text takes it away. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "source", schema: text("A collector's id, such as x-tasks from list_collectors, or tool: and a tool plugin's key, such as tool:codex.web/web from list_plugin_tools.") },
        { name: "guidance", schema: text(`The guidance in Markdown, at most ${longest_guidance} characters; empty to take it away.`) },
      ],
    },
  },
  setting_defaults: { [guidance_setting]: {} },
});
