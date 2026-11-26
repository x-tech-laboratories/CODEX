// Fills a dev database with sample contexts and items, and a folder of sample files for the Files collector to find;
// `npm run seed` writes dev-data/, and running it again starts the sample over.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { email_uri } from "../src/shared/collectors/bundled.ts";
import type { FoundItem } from "../src/shared/collectors/collector.ts";
import { bind_methods, open_store } from "../src/shared/store.ts";

// ── Files ────────────────────────────────────────────────────────────────────

const data_folder = resolve(process.argv[2] ?? "dev-data");
const files_folder = join(data_folder, "sample-files");
const database_path = join(data_folder, "codex.db");

rmSync(files_folder, { recursive: true, force: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${database_path}${suffix}`, { force: true });
mkdirSync(join(files_folder, "Kitchen"), { recursive: true });
mkdirSync(join(files_folder, "Taxes 2026"), { recursive: true });

function sample_file(path: string): FoundItem {
  const full = join(files_folder, path);
  writeFileSync(full, "");
  return { source_id: full, kind: "file", title: path.split("/").at(-1)!, snippet: full.slice(0, full.lastIndexOf("/")), uri: pathToFileURL(full).href };
}

// ── Data ─────────────────────────────────────────────────────────────────────

const database = new DatabaseSync(database_path);
database.exec("PRAGMA journal_mode = WAL");
open_store(database);
const store = bind_methods(() => database, () => undefined);

store.set_setting("plugins", { "codex.files": { enabled: true, settings: { folders: files_folder, depth: 6 } } });

const home = store.add_context("Home renovation", null);
const kitchen = store.add_context("Kitchen", home);
const garden = store.add_context("Garden", home);
const taxes = store.add_context("Taxes 2026", null);
const launch = store.add_context("CODEX launch", null);
store.add_context("Reading list", null);

store.set_context_notes(home, "Kitchen first, then the garden once the weather turns.\n\n- Budget: keep under the quote\n- Ask about the boiler while the fitter is here");
store.set_context_notes(launch, `Ship the web and desktop apps, then the Thunderbird add-on. Once the kitchen is done: codex://context/${kitchen}`);

const task = (id: string, title: string, status = "", parent = ""): FoundItem => ({ source_id: id, kind: "task", title, uri: `x-tasks://task/${id}`, status, detail: parent ? { parent } : {} });
const note = (id: string, title: string, snippet: string): FoundItem => ({ source_id: id, kind: "note", title, snippet, uri: `https://notes.example.org/#root/${id}` });
const email = (id: string, title: string, from: string): FoundItem => ({ source_id: id, kind: "email", title, snippet: `From ${from}`, uri: email_uri(id), detail: { from } });
const link = (url: string, title: string): FoundItem => ({ source_id: url, kind: "link", title, uri: url });

store.add_item([kitchen], "x-tasks", task("sample-1", "Pick worktop colour"), "Samples are in the hall drawer");
store.add_item([kitchen], "x-tasks", task("sample-2", "Book the electrician", "done"), "");
store.add_item([kitchen], "x-tasks", task("sample-5", "Order the worktop", "", "sample-1"), "");
store.add_item([kitchen, home], "trilium", note("kitchenPlan", "Kitchen plan", "Cabinets along the north wall, island in the middle. Worktop: x-tasks://task/sample-1"), "");
store.add_item([kitchen], "email", email("quote-123@builder.example.org", "Your kitchen quote", "Builder & Sons"), "The one we went with");
store.add_item([kitchen], "files", sample_file("Kitchen/floor-plan.pdf"), "");
store.add_item([garden], "links", link("https://example.org/raised-beds", "Building raised beds"), "");
store.add_item([garden], "x-tasks", task("sample-3", "Order seeds"), "Before March");
store.add_item([taxes], "files", sample_file("Taxes 2026/receipts.csv"), "");
store.add_item([taxes], "email", email("p60-2026@employer.example.org", "Your P60 for 2026", "Payroll"), "");
store.add_item([taxes], "x-tasks", task("sample-4", "File the return"), "Due 31 January");
store.add_item([launch], "links", link("https://github.com/x-tech-laboratories", "X-Tech Laboratories on GitHub"), "");
store.add_item([launch], "trilium", note("launchNotes", "Launch checklist", "Icon, README, release notes, the add-on listing. Code at https://github.com/x-tech-laboratories"), "");

database.close();
console.log(`Seeded ${database_path} and ${files_folder}`);
