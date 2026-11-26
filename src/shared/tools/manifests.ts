// The bundled tool plugins as the plugin host knows them: their names and settings. The store's side runs them and the
// page's side shows their settings, from the same manifests.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginManifest } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../collectors/collector.ts";

// ── Web ──────────────────────────────────────────────────────────────────────

export const web_manifest: PluginManifest = {
  id: "codex.web",
  name: "Web",
  version: app_info.version,
  app: app_info.id,
  description:
    "Lets the assistant read public web pages (web_fetch) and search the web through a SearXNG instance you name (web_search). Both send what the assistant gives them outside this computer. Off until you turn it on.",
  enabled_by_default: false,
  settings: [
    {
      key: "search_endpoint",
      label: "Search endpoint",
      hint: "The address of a SearXNG instance with its JSON format turned on, such as https://searx.example.org. CODEX asks GET <address>/search?q=<query>&format=json and reads the titles, addresses and snippets it answers. Empty, the assistant is not offered web_search.",
      type: "text",
      default: "",
      placeholder: "https://searx.example.org",
    },
    {
      key: "allowed_ports",
      label: "Other ports allowed",
      hint: "web_fetch reads only public addresses on the usual ports, 80 for http and 443 for https. List other ports it may use, separated by commas, such as 8080, 8443.",
      type: "text",
      default: "",
      placeholder: "8080, 8443",
    },
  ],
};

export const tool_manifests = [web_manifest];

// The id the web plugin provides its tools under, which is its tools' namespace: web__web_fetch, web__web_search.
export const web_tools_id = "web";
