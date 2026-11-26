import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { create_plugin_host, type Plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { bare_message_id, email_plugin, email_uri, forget_x_tasks_paths, html_text, shorten, trilium_plugin, web_address, x_tasks_feeds, x_tasks_in_feed, x_tasks_plugin } from "../src/shared/collectors/bundled.ts";
import { app_info, type Collector } from "../src/shared/collectors/collector.ts";
import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import { files_plugin, find_files, folders_of, look_up_files, most_content_bytes, read_text_files } from "../src/server/collectors/files.ts";
import { status_of } from "../src/web/plugins.tsx";

// ── Helpers ──────────────────────────────────────────────────────────────────

// The collector a plugin provides, started with the settings given.
async function collector_of(plugin: Plugin<ContextPluginApi>, settings: SettingValues = {}): Promise<Collector> {
  const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: { read: () => ({ [plugin.id]: { enabled: true, settings } }), write: () => undefined } });
  await host.add(plugin);
  await host.start();
  return host.providers("collector")[0]!.value;
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  forget_x_tasks_paths();
});

// ── X-Tasks ──────────────────────────────────────────────────────────────────

const tasks = [
  { id: "t1", title: "Order seeds", notes: "From the catalogue", is_done: false, due_at: "2026-12-01" },
  { id: "t2", title: "Seed list", notes: "", is_done: true, due_at: null },
  { id: "t3", title: "Fix fence", notes: "", is_done: false, due_at: null },
];

describe("the X-Tasks collector", () => {
  it("finds tasks by every word typed, open ones first, with their links and states", async () => {
    const fetch = vi.fn(async () => answer(tasks));
    vi.stubGlobal("fetch", fetch);
    const collector = await collector_of(x_tasks_plugin, { address: "https://tasks.example.org/", token: "t0k" });

    const found = await collector.search!("seed");

    expect(found.map((item) => [item.source_id, item.status])).toEqual([
      ["t1", ""],
      ["t2", "done"],
    ]);
    expect(found[0]).toMatchObject({ kind: "task", uri: "x-tasks://task/t1", snippet: "From the catalogue", detail: { due: "2026-12-01" } });
    expect(fetch).toHaveBeenCalledWith("https://tasks.example.org/api/call/list_tasks", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer t0k" }) }));
  });

  it("falls back to the older path for an X-Tasks server from before the standard one, and keeps to it", async () => {
    const fetch = vi.fn(async (url: string) => (url.includes("/api/call/") ? answer({}, 404) : answer(tasks)));
    vi.stubGlobal("fetch", fetch);
    const collector = await collector_of(x_tasks_plugin, { address: "https://old.example.org", token: "t0k" });
    expect(await collector.search!("seed")).toHaveLength(2);
    expect(await collector.search!("fence")).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://old.example.org/api/call/list_tasks", "https://old.example.org/api/list_tasks", "https://old.example.org/api/list_tasks"]);
  });

  it("looks up only the tasks asked for, leaving out the ones gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(tasks)));
    const collector = await collector_of(x_tasks_plugin, { address: "https://tasks.example.org", token: "t0k" });
    expect(Object.keys(await collector.resolve!(["t3", "gone"]))).toEqual(["t3"]);
  });

  it("says plainly when it is not set up or its token is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({}, 401)));
    await expect((await collector_of(x_tasks_plugin, { address: "", token: "" })).search!("x")).rejects.toThrow("Set the X-Tasks server's address");
    await expect((await collector_of(x_tasks_plugin, { address: "https://tasks.example.org", token: "bad" })).search!("x")).rejects.toThrow("refused the token");
  });
});

describe("X-Tasks feeds", () => {
  const family = [
    { id: "p", title: "Kitchen", notes: "", is_done: false, due_at: null, parent_id: null, tag_ids: [] },
    { id: "c1", title: "Worktop", notes: "", is_done: false, due_at: null, parent_id: "p", tag_ids: ["garden"] },
    { id: "c2", title: "Tiles", notes: "", is_done: true, due_at: null, parent_id: "c1", tag_ids: ["beds"] },
    { id: "o", title: "Other", notes: "", is_done: false, due_at: null, parent_id: null, tag_ids: [] },
  ];
  const tags = [
    { id: "garden", name: "Garden", parent_id: null },
    { id: "beds", name: "Beds", parent_id: "garden" },
    { id: "auto", name: "Overdue", parent_id: null, rule: { kind: "overdue" } },
  ];

  it("offers the tags given by hand with their parents' names, then the open tasks with subtasks", () => {
    expect(x_tasks_feeds(family, tags)).toEqual([
      { id: "tag:garden", label: "Garden", kind: "Tag" },
      { id: "tag:beds", label: "Garden/Beds", kind: "Tag" },
      { id: "task:c1", label: "Worktop", kind: "Task with subtasks" },
      { id: "task:p", label: "Kitchen", kind: "Task with subtasks" },
    ].sort((first, second) => (first.kind === second.kind ? first.label.localeCompare(second.label) : first.kind === "Tag" ? -1 : 1)));
  });

  it("names each tag's filter group", () => {
    const grouped_tags = tags.map((tag) => (tag.id === "garden" ? { ...tag, group_id: "areas" } : tag));
    const feeds = x_tasks_feeds(family, grouped_tags, [{ id: "areas", name: "Areas" }]);
    expect(feeds.find((feed) => feed.id === "tag:garden")?.group).toEqual({ id: "areas", label: "Areas" });
    expect(feeds.find((feed) => feed.id === "tag:beds")?.group).toBeUndefined();
  });

  it("holds the tasks with a tag or any tag inside it, or a task and everything under it, done ones only when asked", () => {
    const ids = (feed: string, done = false) => x_tasks_in_feed(family, tags, feed, done).map((task) => task.id);
    expect(ids("tag:garden")).toEqual(["c1"]);
    expect(ids("tag:garden", true)).toEqual(["c1", "c2"]);
    expect(ids("task:p", true)).toEqual(["p", "c1", "c2"]);
    expect(ids("task:p")).toEqual(["p", "c1"]);
    expect(() => ids("folder:x")).toThrow("no feed");
  });

  it("reads the tasks and tags from the server as a plugin", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => answer(url.endsWith("/list_tags") ? tags : url.endsWith("/list_tag_groups") ? [{ id: "areas", name: "Areas" }] : family)));
    const collector = await collector_of(x_tasks_plugin, { address: "https://tasks.example.org", token: "t0k", include_done: false });
    expect((await collector.feeds!.list()).length).toBe(4);
    expect((await collector.feeds!.items("tag:garden")).map((item) => item.title)).toEqual(["Worktop"]);
  });
});

// ── Trilium ──────────────────────────────────────────────────────────────────

describe("the Trilium collector", () => {
  it("searches through ETAPI with its token and links each note into the server's page", async () => {
    const fetch = vi.fn(async () => answer({ results: [{ noteId: "abc", title: "Bed layout", type: "text", dateModified: "2026-11-01" }] }));
    vi.stubGlobal("fetch", fetch);
    const collector = await collector_of(trilium_plugin, { address: "https://notes.example.org", token: "etapi" });

    expect(await collector.search!("bed & layout")).toEqual([{ source_id: "abc", kind: "note", title: "Bed layout", uri: "https://notes.example.org/#root/abc", detail: { modified: "2026-11-01" } }]);
    expect(fetch).toHaveBeenCalledWith("https://notes.example.org/etapi/notes?search=bed%20%26%20layout&limit=30", { headers: { authorization: "etapi" } });
  });

  it("looks up each note and leaves out one Trilium no longer has", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/abc") ? answer({ noteId: "abc", title: "Renamed", type: "text" }) : answer({}, 404))));
    const collector = await collector_of(trilium_plugin, { address: "https://notes.example.org", token: "etapi" });
    const found = await collector.resolve!(["abc", "gone"]);
    expect(Object.keys(found)).toEqual(["abc"]);
    expect(found.abc!.title).toBe("Renamed");
  });
});

// ── Links and email ──────────────────────────────────────────────────────────

describe("web links and email", () => {
  it("take a web address with https:// added where it was left off, and refuse anything else", () => {
    expect(web_address(" example.org/a ")).toBe("https://example.org/a");
    expect(web_address("http://example.org")).toBe("http://example.org/");
    expect(() => web_address("")).toThrow("address");
    expect(() => web_address("ftp://example.org")).toThrow("http");
  });

  it("key an email on its Message-ID without the brackets, opening it as a mid: link", async () => {
    expect(bare_message_id(" <abc@example.org> ")).toBe("abc@example.org");
    expect(email_uri("<abc@example.org>")).toBe("mid:abc@example.org");
    const collector = await collector_of(email_plugin);
    expect(collector.search).toBeUndefined();
    expect(collector.pushed_from).toContain("Thunderbird");
  });

  it("shortens a long snippet to one line", () => {
    expect(shorten("a\n  b")).toBe("a b");
    expect(shorten("x".repeat(300))).toHaveLength(200);
  });
});

// ── Files ────────────────────────────────────────────────────────────────────

describe("the Files collector", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "codex-files-"));
    roots.push(root);
    mkdirSync(join(root, "Garden plans", "deep", "deeper"), { recursive: true });
    mkdirSync(join(root, "node_modules", "garden"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, "Garden plans", "beds.txt"), "");
    writeFileSync(join(root, "Garden plans", "deep", "deeper", "garden-map.png"), "");
    writeFileSync(join(root, ".hidden", "garden.txt"), "");
    return root;
  }

  it("finds files and folders by name, nearest first, within the depth set, skipping hidden and build folders", async () => {
    const root = tree();
    expect((await find_files([root], "garden", 6)).map((item) => [item.kind, item.title])).toEqual([
      ["folder", "Garden plans"],
      ["file", "garden-map.png"],
    ]);
    expect((await find_files([root], "garden", 1)).map((item) => item.title)).toEqual(["Garden plans"]);
    expect(await find_files([root], "  ", 6)).toEqual([]);
    expect(await find_files([join(root, "missing")], "garden", 6)).toEqual([]);
  });

  it("looks files up again, leaving out one moved away, and links each as a file:// address", async () => {
    const root = tree();
    const path = join(root, "Garden plans", "beds.txt");
    const found = await look_up_files([path, join(root, "gone.txt")]);
    expect(Object.keys(found)).toEqual([path]);
    expect(found[path]).toMatchObject({ kind: "file", title: "beds.txt", snippet: join(root, "Garden plans"), uri: `file://${path.replace(/ /g, "%20")}` });
  });

  it("reads its folders one per line with ~ as home, and searches them as a plugin", async () => {
    const root = tree();
    expect(folders_of({ folders: `~/Documents\n\n ${root} ` })[1]).toBe(root);
    expect(folders_of({ folders: "~/Documents" })[0]).toMatch(/\/Documents$/);
    const collector = await collector_of(files_plugin, { folders: root, depth: 3 });
    expect((await collector.search!("beds")).map((item) => item.title)).toEqual(["beds.txt"]);
  });
});

// ── Settings status ──────────────────────────────────────────────────────────

describe("a collector's status in Settings", () => {
  it("says Not set up while its address or key is empty", () => {
    expect(status_of(trilium_plugin, "running", { address: "", token: "" })).toBe("Not set up");
    expect(status_of(trilium_plugin, "running", { address: "https://notes.example.org", token: "x" })).toBe("On");
    expect(status_of(trilium_plugin, "off", {})).toBe("Off");
    expect(status_of(trilium_plugin, "failed", {})).toBe("Not running");
  });
});

// ── Content for the index ────────────────────────────────────────────────────

describe("each collector's text for the index", () => {
  it("reads plain text and Markdown files under the size cap, skipping every other file", async () => {
    const folder = mkdtempSync(join(tmpdir(), "codex-content-"));
    try {
      writeFileSync(join(folder, "plan.md"), "# Kitchen\nTiles first.");
      writeFileSync(join(folder, "notes.TXT"), "Grout is grey.");
      writeFileSync(join(folder, "photo.png"), "not text");
      writeFileSync(join(folder, "fake.txt"), "text\u0000with a nul");
      writeFileSync(join(folder, "huge.md"), "x".repeat(most_content_bytes + 1));
      mkdirSync(join(folder, "folder.md"));
      const paths = ["plan.md", "notes.TXT", "photo.png", "fake.txt", "huge.md", "folder.md", "gone.md"].map((name) => join(folder, name));
      expect(await read_text_files(paths)).toEqual({ [join(folder, "plan.md")]: "# Kitchen\nTiles first.", [join(folder, "notes.TXT")]: "Grout is grey." });
      const collector = await collector_of(files_plugin, { folders: folder });
      expect(Object.keys(await collector.content!([join(folder, "plan.md")]))).toEqual([join(folder, "plan.md")]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("gives an X-Task's notes, leaving out tasks with none and tasks gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(tasks)));
    const collector = await collector_of(x_tasks_plugin, { address: "https://tasks.example.org", token: "t0k" });
    expect(await collector.content!(["t1", "t2", "gone"])).toEqual({ t1: "From the catalogue" });
  });

  it("reads a Trilium text note as words and a code note as it is, read-only, skipping other notes", async () => {
    const notes: Record<string, { type: string; body: string }> = {
      n1: { type: "text", body: "<h1>Kitchen</h1><p>Tiles &amp; grout&nbsp;first.</p><ul><li>Grey</li><li>&#x263A; &#65;</li></ul><script>x()</script>" },
      n2: { type: "code", body: "print('hi')" },
      n3: { type: "image", body: "" },
      n4: { type: "text", body: "" },
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const [, id, content] = /\/etapi\/notes\/([^/]+)(\/content)?$/.exec(url)!;
      const note = notes[id!];
      if (!note) return answer({}, 404);
      if (id === "n4" && content) return new Response("", { status: 500 });
      return content ? new Response(note.body) : answer({ noteId: id, title: id, type: note.type });
    });
    vi.stubGlobal("fetch", fetch);
    const collector = await collector_of(trilium_plugin, { address: "https://notes.example.org", token: "etapi" });
    expect(await collector.content!(["n1", "n2", "n3", "n4", "gone"])).toEqual({ n1: "Kitchen\n\nTiles & grout first.\n\nGrey\n\n☺ A", n2: "print('hi')" });
    expect(html_text("a&bogus;b")).toBe("a&bogus;b");
  });
});
