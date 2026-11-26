// The Files collector: finds files and folders by name under the folders set, and says which are gone. It reads the
// disk of the machine its server or daemon runs on, so it lives here rather than with the store.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { FoundItem } from "../../shared/collectors/collector.ts";
import type { ContextPluginApi } from "../../shared/collectors/host.ts";
import { files_manifest } from "../../shared/collectors/manifests.ts";

// ── Folders ──────────────────────────────────────────────────────────────────

const most_found = 30;
// Stops a search of a huge tree after this many entries, so a short word cannot keep the daemon busy.
const most_entries_read = 50_000;
const skipped_folders = new Set(["node_modules", ".git", "__pycache__", ".cache"]);

// The folders set, one per line, with ~ as the home folder.
export function folders_of(settings: SettingValues): string[] {
  return String(settings.folders ?? "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => resolve(line.replace(/^~(?=$|\/)/, homedir())));
}

function file_item(path: string, is_folder: boolean, modified: Date): FoundItem {
  return {
    source_id: path,
    kind: is_folder ? "folder" : "file",
    title: basename(path),
    snippet: dirname(path),
    uri: pathToFileURL(path).href,
    detail: { modified: modified.toISOString() },
  };
}

// ── Search ───────────────────────────────────────────────────────────────────

// Names holding every word typed, nearest the top first, hidden files and build folders left out.
export async function find_files(roots: string[], query: string, depth: number): Promise<FoundItem[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found: FoundItem[] = [];
  let entries_read = 0;
  let level: string[] = roots;
  for (let step = 0; step < depth && level.length > 0 && found.length < most_found; step++) {
    const next: string[] = [];
    for (const folder of level) {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++entries_read > most_entries_read || found.length >= most_found) break;
        if (entry.name.startsWith(".")) continue;
        const path = join(folder, entry.name);
        const is_folder = entry.isDirectory();
        if (is_folder && !skipped_folders.has(entry.name)) next.push(path);
        const name = entry.name.toLowerCase();
        if (!words.every((word) => name.includes(word))) continue;
        try {
          found.push(file_item(path, is_folder, (await stat(path)).mtime));
        } catch {
          continue;
        }
      }
    }
    level = next;
  }
  return found;
}

// Each path that is still there; one moved or deleted is left out.
export async function look_up_files(paths: string[]): Promise<Record<string, FoundItem>> {
  const answers = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        return file_item(path, info.isDirectory(), info.mtime);
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(answers.filter((item) => item !== null).map((item) => [item.source_id, item]));
}

// ── Content ──────────────────────────────────────────────────────────────────

// Plain text and Markdown files are read for the search index; any other file is skipped rather than guessed at.
const text_extensions = new Set([".txt", ".text", ".md", ".markdown"]);

// The longest file read, so a huge log cannot fill the index.
export const most_content_bytes = 256 * 1024;

// The text of each plain text or Markdown file no larger than the cap; others, folders and files gone are left out.
export async function read_text_files(paths: string[]): Promise<Record<string, string>> {
  const answers = await Promise.all(
    paths.map(async (path): Promise<[string, string] | null> => {
      if (!text_extensions.has(extname(path).toLowerCase())) return null;
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > most_content_bytes) return null;
        const text = await readFile(path, "utf8");
        // A NUL byte means a binary file with a text name.
        return text.includes("\u0000") ? null : [path, text];
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(answers.filter((answer) => answer !== null));
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const files_plugin = define_plugin<ContextPluginApi>({
  ...files_manifest,
  start: (context) =>
    context.provide("collector", "files", {
      label: "Files",
      kinds: ["file", "folder"],
      search: (query) => find_files(folders_of(context.settings()), query, Number(context.settings().depth) || 6),
      resolve: look_up_files,
      content: read_text_files,
    }),
});
