// The Firefox bookmarks collector: finds bookmarks by title or address, says which are gone, and offers each bookmark
// folder to follow. It reads a copy of the profile's places.sqlite on the machine its daemon runs on, since Firefox
// keeps the file locked while it runs, so it lives here rather than with the store.

// ── Imports ──────────────────────────────────────────────────────────────────

import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { Feed, FoundItem } from "../../shared/collectors/collector.ts";
import type { ContextPluginApi } from "../../shared/collectors/host.ts";
import { bookmarks_manifest } from "../../shared/collectors/manifests.ts";

// ── Profile ──────────────────────────────────────────────────────────────────

// Where Firefox keeps its profiles: the XDG folder newer versions use, then the older one.
function firefox_folders(): string[] {
  return [join(homedir(), ".config", "mozilla", "firefox"), join(homedir(), ".mozilla", "firefox")];
}

// The default profile named in a profiles.ini, as a folder relative to it or absolute.
export function default_profile_of(ini: string): { path: string; is_relative: boolean } | null {
  const sections = ini.split(/^\[/m).map((section) => {
    const [head = "", ...lines] = section.split("\n");
    const values = Object.fromEntries(lines.map((line) => line.split(/=(.*)/s)).filter((pair) => pair.length >= 2).map(([key, value]) => [key!.trim(), value!.trim()]));
    return { head: head.replace(/\].*$/, ""), values };
  });
  const install = sections.find((section) => section.head.startsWith("Install") && section.values.Default);
  if (install) return { path: install.values.Default!, is_relative: true };
  const profiles = sections.filter((section) => section.head.startsWith("Profile") && section.values.Path);
  const chosen = profiles.find((section) => section.values.Default === "1") ?? profiles[0];
  return chosen ? { path: chosen.values.Path!, is_relative: chosen.values.IsRelative !== "0" } : null;
}

// The profile folder set, with ~ as the home folder, or else Firefox's default profile.
export async function profile_of(settings: SettingValues): Promise<string> {
  const set = String(settings.profile ?? "").trim();
  if (set) return resolve(set.replace(/^~(?=$|\/)/, homedir()));
  for (const folder of firefox_folders()) {
    let ini: string;
    try {
      ini = await readFile(join(folder, "profiles.ini"), "utf8");
    } catch {
      continue;
    }
    const found = default_profile_of(ini);
    if (found) return found.is_relative ? join(folder, found.path) : found.path;
  }
  throw new Error("Firefox's profile was not found; set its folder under Settings → Plugins.");
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface BookmarkRow {
  id: number;
  parent: number;
  type: number;
  title: string | null;
  guid: string;
  url: string | null;
}

// Every bookmark and folder, outside the tags Firefox keeps as folders of their own.
export interface Bookmarks {
  rows: BookmarkRow[];
  by_id: Map<number, BookmarkRow>;
}

const bookmark_type = 1;
const folder_type = 2;
const root_names: Record<string, string> = { menu________: "Menu", toolbar_____: "Toolbar", unfiled_____: "Other Bookmarks", mobile______: "Mobile" };

let kept: { key: string; bookmarks: Bookmarks } | null = null;

// The bookmarks in places.sqlite, read from a copy taken with its write-ahead log; read again only once either changes.
export async function read_bookmarks(profile: string): Promise<Bookmarks> {
  const places = join(profile, "places.sqlite");
  const sizes = await Promise.all([places, `${places}-wal`].map((path) => stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => "")));
  if (!sizes[0]) throw new Error(`Firefox's bookmarks were not found in ${profile}.`);
  const key = `${places}|${sizes.join("|")}`;
  if (kept?.key === key) return kept.bookmarks;
  const folder = await mkdtemp(join(tmpdir(), "x-context-bookmarks-"));
  try {
    const copy = join(folder, "places.sqlite");
    await copyFile(places, copy);
    if (sizes[1]) await copyFile(`${places}-wal`, `${copy}-wal`);
    const database = new DatabaseSync(copy);
    try {
      const rows = database
        .prepare("SELECT b.id, b.parent, b.type, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position")
        .all() as unknown as BookmarkRow[];
      const tags = rows.find((row) => row.guid === "tags________")?.id;
      const by_id = new Map(rows.map((row) => [row.id, row]));
      const shown = rows.filter((row) => {
        let parent = row.parent;
        for (let step = 0; step < 50 && parent; step++) {
          if (parent === tags) return false;
          parent = by_id.get(parent)?.parent ?? 0;
        }
        return row.id !== tags;
      });
      const bookmarks = { rows: shown, by_id: new Map(shown.map((row) => [row.id, row])) };
      kept = { key, bookmarks };
      return bookmarks;
    } finally {
      database.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// A folder's names from its root down, such as "Other Bookmarks/1. Career/5. Job Hunting".
export function folder_path(bookmarks: Bookmarks, id: number): string {
  const names: string[] = [];
  let row = bookmarks.by_id.get(id);
  for (let step = 0; step < 50 && row && row.parent !== 0; step++) {
    names.unshift(root_names[row.guid] ?? (row.title ?? "").trim());
    row = bookmarks.by_id.get(row.parent);
  }
  return names.join("/");
}

function bookmark_item(bookmarks: Bookmarks, row: BookmarkRow): FoundItem {
  const folder = folder_path(bookmarks, row.parent);
  return { source_id: row.guid, kind: "link", title: (row.title ?? "").trim() || row.url || "Untitled bookmark", snippet: folder, uri: row.url ?? "", detail: { folder } };
}

function is_bookmark(row: BookmarkRow): boolean {
  return row.type === bookmark_type && Boolean(row.url) && !row.url!.startsWith("place:");
}

const most_found = 30;

// Bookmarks whose title or address holds every word typed.
export function find_bookmarks(bookmarks: Bookmarks, query: string): FoundItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return bookmarks.rows
    .filter((row) => is_bookmark(row) && words.every((word) => `${row.title ?? ""} ${row.url}`.toLowerCase().includes(word)))
    .slice(0, most_found)
    .map((row) => bookmark_item(bookmarks, row));
}

// Each bookmark still there, by guid; one deleted is left out.
export function look_up_bookmarks(bookmarks: Bookmarks, guids: string[]): Record<string, FoundItem> {
  const wanted = new Set(guids);
  return Object.fromEntries(bookmarks.rows.filter((row) => is_bookmark(row) && wanted.has(row.guid)).map((row) => [row.guid, bookmark_item(bookmarks, row)]));
}

// Every folder that is not one of Firefox's roots, by its path.
export function bookmark_feeds(bookmarks: Bookmarks): Feed[] {
  return bookmarks.rows
    .filter((row) => row.type === folder_type && row.parent !== 0 && !root_names[row.guid] && bookmarks.by_id.get(row.parent))
    .map((row) => ({ id: `folder:${row.guid}`, label: folder_path(bookmarks, row.id), kind: "Folder" }))
    .sort((first, second) => first.label.localeCompare(second.label, undefined, { numeric: true }));
}

// The bookmarks in a folder and every folder inside it.
export function bookmarks_in_feed(bookmarks: Bookmarks, feed_id: string): FoundItem[] {
  const [kind, guid] = feed_id.split(/:(.*)/s);
  const folder = kind === "folder" ? bookmarks.rows.find((row) => row.guid === guid && row.type === folder_type) : undefined;
  if (!folder) throw new Error(`Firefox has no bookmark folder ${feed_id}.`);
  const inside = new Set([folder.id]);
  // Rows come by parent, so a folder can come before the one holding it; go again until nothing new is found.
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of bookmarks.rows) {
      if (row.type === folder_type && inside.has(row.parent) && !inside.has(row.id)) {
        inside.add(row.id);
        grew = true;
      }
    }
  }
  return bookmarks.rows.filter((row) => is_bookmark(row) && inside.has(row.parent)).map((row) => bookmark_item(bookmarks, row));
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const bookmarks_plugin = define_plugin<ContextPluginApi>({
  ...bookmarks_manifest,
  start: (context) => {
    const bookmarks = async () => read_bookmarks(await profile_of(context.settings()));
    context.provide("collector", "bookmarks", {
      label: "Firefox bookmarks",
      kinds: ["link"],
      search: async (query) => find_bookmarks(await bookmarks(), query),
      resolve: async (guids) => look_up_bookmarks(await bookmarks(), guids),
      feeds: {
        list: async () => bookmark_feeds(await bookmarks()),
        items: async (feed_id) => bookmarks_in_feed(await bookmarks(), feed_id),
      },
    });
  },
});
