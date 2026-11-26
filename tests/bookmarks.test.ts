import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bookmark_feeds,
  bookmarks_in_feed,
  default_profile_of,
  find_bookmarks,
  look_up_bookmarks,
  profile_of,
  read_bookmarks,
} from "../src/server/collectors/bookmarks.ts";

// ── A profile of its own ─────────────────────────────────────────────────────

let profile = "";

// A places.sqlite as Firefox keeps it: roots, a folder with one inside it, bookmarks, and a tag.
function make_places(folder: string): void {
  const database = new DatabaseSync(join(folder, "places.sqlite"));
  database.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT);
    INSERT INTO moz_places VALUES (1, 'https://jobs.example.org/', 'Jobs'), (2, 'https://cv.example.org/', 'CV'), (3, 'https://bank.example.org/', 'Bank'), (4, 'place:sort=8', 'Recent');
    INSERT INTO moz_bookmarks VALUES
      (1, 2, NULL, 0, 0, '', 'root________'),
      (2, 2, NULL, 1, 0, 'menu', 'menu________'),
      (3, 2, NULL, 1, 1, 'unfiled', 'unfiled_____'),
      (4, 2, NULL, 1, 2, 'tags', 'tags________'),
      (5, 2, NULL, 3, 0, ' 1. Career', 'career_guid'),
      (6, 1, 1, 5, 0, 'Job board', 'jobs_guid'),
      (8, 1, 2, 7, 0, 'My CV', 'cv_guid'),
      (7, 2, NULL, 5, 1, 'Portfolio', 'portfolio_guid'),
      (9, 1, 3, 3, 1, 'Bank', 'bank_guid'),
      (10, 2, NULL, 4, 0, 'money', 'tag_guid'),
      (11, 1, 3, 10, 0, NULL, 'tagged_bank'),
      (12, 1, 4, 2, 0, 'Recent', 'query_guid');
  `);
  database.close();
}

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), "x-context-firefox-"));
  make_places(profile);
});

afterEach(() => rmSync(profile, { recursive: true, force: true }));

// ── Profiles ─────────────────────────────────────────────────────────────────

describe("finding the profile", () => {
  it("takes the install's default, then the default profile, then the first", () => {
    expect(default_profile_of("[Install4F96]\nDefault=Personal\n\n[Profile0]\nName=Other\nPath=other\nDefault=1\n")).toEqual({ path: "Personal", is_relative: true });
    expect(default_profile_of("[Profile0]\nPath=a\n\n[Profile1]\nPath=/abs/b\nIsRelative=0\nDefault=1\n")).toEqual({ path: "/abs/b", is_relative: false });
    expect(default_profile_of("[Profile0]\nPath=a\n")).toEqual({ path: "a", is_relative: true });
    expect(default_profile_of("[General]\nVersion=2\n")).toBeNull();
  });

  it("uses the folder set, with ~ as home", async () => {
    expect(await profile_of({ profile: profile })).toBe(profile);
    expect(await profile_of({ profile: "~/x" })).toMatch(/\/x$/);
  });
});

// ── Bookmarks ────────────────────────────────────────────────────────────────

describe("reading bookmarks", () => {
  it("offers each folder by its path, leaving out Firefox's roots and tags", async () => {
    const bookmarks = await read_bookmarks(profile);
    expect(bookmark_feeds(bookmarks)).toEqual([
      { id: "folder:career_guid", label: "Other Bookmarks/1. Career", kind: "Folder" },
      { id: "folder:portfolio_guid", label: "Other Bookmarks/1. Career/Portfolio", kind: "Folder" },
    ]);
  });

  it("holds a folder's bookmarks and those of every folder inside it", async () => {
    const bookmarks = await read_bookmarks(profile);
    expect(bookmarks_in_feed(bookmarks, "folder:career_guid").map((item) => [item.source_id, item.title, item.snippet])).toEqual([
      ["jobs_guid", "Job board", "Other Bookmarks/1. Career"],
      ["cv_guid", "My CV", "Other Bookmarks/1. Career/Portfolio"],
    ]);
    expect(() => bookmarks_in_feed(bookmarks, "folder:nothing")).toThrow("no bookmark folder");
  });

  it("finds bookmarks by title or address, and looks up the ones still there", async () => {
    const bookmarks = await read_bookmarks(profile);
    expect(find_bookmarks(bookmarks, "bank").map((item) => item.uri)).toEqual(["https://bank.example.org/"]);
    expect(find_bookmarks(bookmarks, "recent")).toEqual([]);
    expect(find_bookmarks(bookmarks, " ")).toEqual([]);
    expect(Object.keys(look_up_bookmarks(bookmarks, ["cv_guid", "gone_guid", "tagged_bank"]))).toEqual(["cv_guid"]);
  });

  it("says plainly when the profile has no bookmarks", async () => {
    await expect(read_bookmarks(join(profile, "missing"))).rejects.toThrow("bookmarks were not found");
  });

  it("reads again once Firefox changes the file", async () => {
    const before = await read_bookmarks(profile);
    expect(await read_bookmarks(profile)).toBe(before);
    writeFileSync(join(profile, "places.sqlite-wal"), "");
    expect(await read_bookmarks(profile)).not.toBe(before);
  });
});
