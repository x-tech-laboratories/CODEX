// The bundled collectors that need only the network, so they run wherever the store does: X-Tasks, Trilium, web
// links and email pushed from Thunderbird.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { Feed, FoundItem } from "./collector.ts";
import type { ContextPlugin, ContextPluginApi } from "./host.ts";
import { email_manifest, links_manifest, trilium_manifest, x_tasks_manifest } from "./manifests.ts";

// ── Requests ─────────────────────────────────────────────────────────────────

const snippet_length = 200;

// The address without a slash at its end, or a plain refusal while it is not set.
function server_of(settings: SettingValues, service: string): string {
  const address = String(settings.address ?? "").trim().replace(/\/+$/, "");
  if (!address) throw new Error(`Set the ${service} server's address under Settings → Plugins.`);
  return address;
}

async function read_json(response: Response, service: string): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new Error(`${service} refused the token; check it under Settings → Plugins.`);
  if (!response.ok) throw new Error(`${service} answered ${response.status} ${response.statusText}.`);
  return response.json();
}

export function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > snippet_length ? `${flat.slice(0, snippet_length - 1)}…` : flat;
}

function matches(query: string, ...texts: string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// ── X-Tasks ──────────────────────────────────────────────────────────────────

interface XTask {
  id: string;
  title: string;
  notes: string;
  is_done: boolean;
  due_at: string | null;
  parent_id?: string | null;
  tag_ids?: string[];
}

interface XTag {
  id: string;
  name: string;
  parent_id: string | null;
  // The filter group it is in; empty for none.
  group_id?: string;
  // Set on a tag X-Tasks gives by a rule rather than by hand, which tasks do not list.
  rule?: unknown;
}

const most_tasks_found = 30;

function task_item(task: XTask): FoundItem {
  return {
    source_id: task.id,
    kind: "task",
    title: task.title || "Untitled task",
    snippet: shorten(task.notes ?? ""),
    uri: `x-tasks://task/${task.id}`,
    status: task.is_done ? "done" : "",
    detail: task.due_at ? { due: task.due_at } : {},
  };
}

async function call_x_tasks<Result>(settings: SettingValues, method: string): Promise<Result> {
  const response = await fetch(`${server_of(settings, "X-Tasks")}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${String(settings.token ?? "")}` },
    body: "[]",
  });
  return (await read_json(response, "X-Tasks")) as Result;
}

function list_x_tasks(settings: SettingValues): Promise<XTask[]> {
  return call_x_tasks<XTask[]>(settings, "list_tasks");
}

// Every id under the ones given, by parent, the given ones included.
function with_descendants<Row extends { id: string; parent_id?: string | null }>(rows: Row[], roots: string[]): Set<string> {
  const found = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parent_id && found.has(row.parent_id) && !found.has(row.id)) {
        found.add(row.id);
        grew = true;
      }
    }
  }
  return found;
}

// A tag's name with its parents', such as "Home/Garden".
function tag_path(tags: XTag[], tag: XTag): string {
  const names = [tag.name];
  let parent = tags.find((each) => each.id === tag.parent_id);
  while (parent && names.length < 20) {
    names.unshift(parent.name);
    const parent_id = parent.parent_id;
    parent = tags.find((each) => each.id === parent_id);
  }
  return names.join("/");
}

interface XTagGroup {
  id: string;
  name: string;
}

// The filter group a tag is in, or none.
function group_of(groups: XTagGroup[], tag: XTag): { group?: { id: string; label: string } } {
  const group = groups.find((each) => each.id === tag.group_id);
  return group ? { group: { id: group.id, label: group.name } } : {};
}

// The tags given by hand, each with its filter group, then the open tasks that have subtasks.
export function x_tasks_feeds(tasks: XTask[], tags: XTag[], groups: XTagGroup[] = []): Feed[] {
  const tag_feeds = tags.filter((tag) => !tag.rule).map((tag) => ({ id: `tag:${tag.id}`, label: tag_path(tags, tag), kind: "Tag", ...group_of(groups, tag) }));
  const parents = new Set(tasks.map((task) => task.parent_id).filter((id): id is string => Boolean(id)));
  const task_feeds = tasks.filter((task) => parents.has(task.id) && !task.is_done).map((task) => ({ id: `task:${task.id}`, label: task.title || "Untitled task", kind: "Task with subtasks" }));
  const by_label = (first: Feed, second: Feed) => first.label.localeCompare(second.label);
  return [...tag_feeds.sort(by_label), ...task_feeds.sort(by_label)];
}

// The tasks a feed holds: those with the tag or any tag inside it, or the task and every task under it.
export function x_tasks_in_feed(tasks: XTask[], tags: XTag[], feed_id: string, include_done: boolean): XTask[] {
  const [kind, id = ""] = feed_id.split(/:(.*)/s);
  let held: XTask[];
  if (kind === "tag") {
    const wanted = with_descendants(tags, [id]);
    held = tasks.filter((task) => (task.tag_ids ?? []).some((tag_id) => wanted.has(tag_id)));
  } else if (kind === "task") {
    const wanted = with_descendants(tasks, [id]);
    held = tasks.filter((task) => wanted.has(task.id));
  } else throw new Error(`X-Tasks has no feed ${feed_id}.`);
  return include_done ? held : held.filter((task) => !task.is_done);
}

export const x_tasks_plugin = define_plugin<ContextPluginApi>({
  ...x_tasks_manifest,
  start: (context) =>
    context.provide("collector", "x-tasks", {
      label: "X-Tasks",
      kinds: ["task"],
      search: async (query) => {
        const tasks = await list_x_tasks(context.settings());
        return tasks
          .filter((task) => matches(query, task.title, task.notes ?? ""))
          .sort((first, second) => Number(first.is_done) - Number(second.is_done))
          .slice(0, most_tasks_found)
          .map(task_item);
      },
      resolve: async (source_ids) => {
        const wanted = new Set(source_ids);
        const tasks = await list_x_tasks(context.settings());
        return Object.fromEntries(tasks.filter((task) => wanted.has(task.id)).map((task) => [task.id, task_item(task)]));
      },
      feeds: {
        list: async () => {
          const settings = context.settings();
          const [tasks, tags, groups] = await Promise.all([list_x_tasks(settings), call_x_tasks<XTag[]>(settings, "list_tags"), call_x_tasks<XTagGroup[]>(settings, "list_tag_groups")]);
          return x_tasks_feeds(tasks, tags, groups);
        },
        items: async (feed_id) => {
          const settings = context.settings();
          const [tasks, tags] = await Promise.all([list_x_tasks(settings), call_x_tasks<XTag[]>(settings, "list_tags")]);
          return x_tasks_in_feed(tasks, tags, feed_id, settings.include_done === true).map(task_item);
        },
      },
    }),
});

// ── Trilium ──────────────────────────────────────────────────────────────────

interface TriliumNote {
  noteId: string;
  title: string;
  type: string;
  dateModified?: string;
}

const most_notes_found = 30;

function note_item(address: string, note: TriliumNote): FoundItem {
  return {
    source_id: note.noteId,
    kind: "note",
    title: note.title || "Untitled note",
    uri: `${address}/#root/${note.noteId}`,
    detail: note.dateModified ? { modified: note.dateModified } : {},
  };
}

function trilium_headers(settings: SettingValues): Record<string, string> {
  return { authorization: String(settings.token ?? "") };
}

export const trilium_plugin = define_plugin<ContextPluginApi>({
  ...trilium_manifest,
  start: (context) =>
    context.provide("collector", "trilium", {
      label: "Trilium",
      kinds: ["note"],
      search: async (query) => {
        const settings = context.settings();
        const address = server_of(settings, "Trilium");
        const url = `${address}/etapi/notes?search=${encodeURIComponent(query)}&limit=${most_notes_found}`;
        const found = (await read_json(await fetch(url, { headers: trilium_headers(settings) }), "Trilium")) as { results: TriliumNote[] };
        return found.results.map((note) => note_item(address, note));
      },
      resolve: async (source_ids) => {
        const settings = context.settings();
        const address = server_of(settings, "Trilium");
        const answers = await Promise.all(
          source_ids.map(async (id) => {
            const response = await fetch(`${address}/etapi/notes/${encodeURIComponent(id)}`, { headers: trilium_headers(settings) });
            if (response.status === 404) return null;
            return note_item(address, (await read_json(response, "Trilium")) as TriliumNote);
          }),
        );
        return Object.fromEntries(answers.filter((item) => item !== null).map((item) => [item.source_id, item]));
      },
    }),
});

// ── Web links ────────────────────────────────────────────────────────────────

// A web address with its scheme, https:// added where it was left off.
export function web_address(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Give the page's address.");
  const address = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Give a web address starting with http:// or https://.");
  return url.href;
}

export const links_plugin = define_plugin<ContextPluginApi>({
  ...links_manifest,
  start: (context) =>
    context.provide("collector", "links", {
      label: "Web links",
      kinds: ["link"],
      manual: {
        fields: [
          { key: "url", label: "Address", placeholder: "https://example.org/page", is_required: true },
          { key: "title", label: "Title", placeholder: "What the page is" },
        ],
        make: (values) => {
          const url = web_address(values.url ?? "");
          return { source_id: url, kind: "link", title: values.title?.trim() || new URL(url).host, uri: url };
        },
      },
    }),
});

// ── Email ────────────────────────────────────────────────────────────────────

// A Message-ID without the angle brackets mail headers put round it.
export function bare_message_id(text: string): string {
  return text.trim().replace(/^<|>$/g, "");
}

// Where an email opens: Thunderbird answers mid: links with the message, wherever it was filed.
export function email_uri(message_id: string): string {
  return `mid:${bare_message_id(message_id)}`;
}

export const email_plugin = define_plugin<ContextPluginApi>({
  ...email_manifest,
  start: (context) =>
    context.provide("collector", "email", {
      label: "Email",
      kinds: ["email"],
      pushed_from: "In Thunderbird, install the CODEX add-on from the app's thunderbird folder, give it this server's address and a token, then use Add to context on any email.",
    }),
});

export const network_plugins: ContextPlugin[] = [x_tasks_plugin, trilium_plugin, links_plugin, email_plugin];
