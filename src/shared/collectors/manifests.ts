// The bundled collector plugins as the plugin host knows them: their names, versions and settings. The store and the
// page each start their own side of a plugin from the same manifest, so this file imports nothing either would not.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginManifest } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "./collector.ts";

// ── Collectors ───────────────────────────────────────────────────────────────

function manifest(id: string, name: string, description: string, settings: PluginManifest["settings"] = []): PluginManifest {
  return { id: `codex.${id}`, name, version: app_info.version, app: app_info.id, description, settings };
}

export const files_manifest = manifest("files", "Files", "Finds files and folders by name under the folders you list, and notices when one is moved away or deleted.", [
  {
    key: "folders",
    label: "Folders",
    hint: "The folders searched, one per line, such as ~/Documents; folders inside them are searched too.",
    type: "text",
    default: "~/Documents",
    placeholder: "~/Documents",
  },
  { key: "depth", label: "Depth", hint: "How many folders down a search goes.", type: "number", default: 6, min: 1, max: 20 },
]);

export const x_tasks_manifest = manifest("x-tasks", "X-Tasks", "Finds tasks in an X-Tasks server and shows whether each is done.", [
  { key: "address", label: "Server address", hint: "The X-Tasks server, such as https://tasks.example.org.", type: "text", default: "", placeholder: "https://tasks.example.org" },
  { key: "token", label: "Token", hint: "A read-only token made on your account page in X-Tasks.", type: "text", default: "", secret: true },
  {
    key: "include_done",
    label: "Include done tasks",
    hint: "Followed tags and tasks bring their done tasks too; off, a task leaves the context once it is done.",
    type: "switch",
    default: false,
  },
]);

export const trilium_manifest = manifest("trilium", "Trilium", "Finds notes in Trilium Notes through its ETAPI and keeps their titles up to date.", [
  { key: "address", label: "Server address", hint: "The Trilium server, such as https://notes.example.org.", type: "text", default: "", placeholder: "https://notes.example.org" },
  { key: "token", label: "ETAPI token", hint: "Made in Trilium under Options → ETAPI.", type: "text", default: "", secret: true },
]);

export const bookmarks_manifest = manifest(
  "bookmarks",
  "Firefox bookmarks",
  "Finds Firefox bookmarks and offers each bookmark folder to follow. It runs in the desktop app, on the computer where Firefox is.",
  [
    {
      key: "profile",
      label: "Profile folder",
      hint: "The Firefox profile whose bookmarks are read; left empty, Firefox's default profile.",
      type: "text",
      default: "",
      placeholder: "~/.mozilla/firefox/abcd1234.default",
    },
  ],
);

export const links_manifest = manifest("links", "Web links", "Keeps web pages and bookmarks by their address and title.");

export const email_manifest = manifest("email", "Email", "Takes emails sent from Thunderbird with the CODEX add-on, keyed by their Message-ID so a moved email is still found.");

export const item_sources_manifest = manifest(
  "items",
  "Apps answering the item calls",
  "Reads any app that answers the X-Tech item calls, such as another X-app, with a read-only token; add each app under Apps below.",
);

export const bundled_manifests = [files_manifest, bookmarks_manifest, x_tasks_manifest, trilium_manifest, links_manifest, email_manifest, item_sources_manifest];
