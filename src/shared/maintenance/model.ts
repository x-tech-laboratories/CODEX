// The shapes the maintenance jobs hand the page and other programs: CODEX's own upkeep, built in beside the assistant's
// jobs, each with its switch, its budget, today's use and what it last did or why it last did nothing. The page
// imports only these.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JobRun } from "../jobs/model.ts";

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type MaintenanceKey = "index" | "embed" | "rules" | "similarity" | "tidy" | "suggest" | "research" | "digest";

// In the order a tick looks at them, so each works from what the one before it did.
export const maintenance_keys: MaintenanceKey[] = ["index", "embed", "rules", "similarity", "tidy", "suggest", "research", "digest"];

export function is_maintenance_key(value: unknown): value is MaintenanceKey {
  return typeof value === "string" && (maintenance_keys as string[]).includes(value);
}

// What one job may use: runs a day, things handled in one run and seconds one run may take; a job calling a model
// also model calls and tokens a day, and one reading the web the web requests in one run.
export interface MaintenanceBudget {
  runs_per_day: number;
  items_per_run: number;
  seconds_per_run: number;
  model_calls_per_day: number;
  tokens_per_day: number;
  web_requests_per_run: number;
}

export type BudgetName = keyof MaintenanceBudget;

// The least and most each part of a budget may be set to.
export const budget_bounds: Record<BudgetName, [number, number]> = {
  runs_per_day: [0, 288],
  items_per_run: [1, 10_000],
  seconds_per_run: [5, 3600],
  model_calls_per_day: [1, 500],
  tokens_per_day: [1000, 2_000_000],
  web_requests_per_run: [1, 50],
};

export interface MaintenanceJobInfo {
  key: MaintenanceKey;
  title: string;
  // What it does, in plain words.
  about: string;
  // What one item is, for its budget, such as "documents".
  items: string;
  // "every": each device keeps its own index, so every device runs it; "chosen": only the device that runs background work.
  where: "every" | "chosen";
  uses_model: boolean;
  // It reads the web, so its budget holds web requests in one run.
  uses_web: boolean;
  default_on: boolean;
  default_budget: MaintenanceBudget;
}

const no_model = { model_calls_per_day: 0, tokens_per_day: 0, web_requests_per_run: 0 };

export const maintenance_jobs: Record<MaintenanceKey, MaintenanceJobInfo> = {
  index: {
    key: "index",
    title: "Refresh the index",
    about: "Brings this device's search index in step with what changed, reading the full text of changed items from apps that offer it.",
    items: "documents",
    where: "every",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 48, items_per_run: 200, seconds_per_run: 120, ...no_model },
  },
  embed: {
    key: "embed",
    title: "Embed documents",
    about: "Gives the embedder's vectors to documents that have none, or one from an embedder or model no longer in use, so search finds by meaning.",
    items: "pieces",
    where: "every",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 48, items_per_run: 256, seconds_per_run: 300, ...no_model },
  },
  rules: {
    key: "rules",
    title: "Links from rules",
    about: "Runs the rules on exact keys again for changed items: an address or app link in one item's text, and a task's parent.",
    items: "documents",
    where: "chosen",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 48, items_per_run: 500, seconds_per_run: 60, ...no_model },
  },
  similarity: {
    key: "similarity",
    title: "Similar items",
    about: "Proposes links between changed items and the items nearest them in meaning, for you to accept or reject.",
    items: "items",
    where: "chosen",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 48, items_per_run: 100, seconds_per_run: 60, ...no_model },
  },
  tidy: {
    key: "tidy",
    title: "Tidy the graph",
    about: "Ends links to items gone from their apps, keeping them as what was once so, and proposes joining entities that look like one.",
    items: "links and entities",
    where: "chosen",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 4, items_per_run: 200, seconds_per_run: 60, ...no_model },
  },
  suggest: {
    key: "suggest",
    title: "Suggest links",
    about: "Asks the assistant to propose entities and links for contexts whose items changed, as Suggest links does. The only maintenance job that calls a model.",
    items: "contexts",
    where: "chosen",
    uses_model: true,
    uses_web: false,
    default_on: false,
    default_budget: { runs_per_day: 4, items_per_run: 1, seconds_per_run: 600, model_calls_per_day: 24, tokens_per_day: 60_000, web_requests_per_run: 0 },
  },
  research: {
    key: "research",
    title: "Research interests",
    about:
      "Has the assistant read about one of its interests you accepted on the public web, through the Web plugin, and save what it learns as findings in a context of its own. Its run is given only the interest's topic and the titles of what it found before, never your data. Off until you turn it on.",
    items: "interests",
    where: "chosen",
    uses_model: true,
    uses_web: true,
    default_on: false,
    default_budget: { runs_per_day: 2, items_per_run: 1, seconds_per_run: 600, model_calls_per_day: 16, tokens_per_day: 60_000, web_requests_per_run: 6 },
  },
  digest: {
    key: "digest",
    title: "Daily digest",
    about: "Once a day, puts one entry in the Inbox saying what background work did and what waits for you, written without a model.",
    items: "entries",
    where: "chosen",
    uses_model: false,
    uses_web: false,
    default_on: true,
    default_budget: { runs_per_day: 1, items_per_run: 1, seconds_per_run: 30, ...no_model },
  },
};

// The synced setting holding each job's switch and budget, where the user changed them; only the user may.
export const maintenance_setting = "maintenance.jobs";

export interface MaintenanceJobSetting {
  on?: boolean;
  budget?: Partial<MaintenanceBudget>;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface MaintenanceUse {
  runs: number;
  items: number;
  model_calls: number;
  tokens: number;
}

export interface MaintenanceJobEntry extends MaintenanceJobInfo {
  on: boolean;
  budget: MaintenanceBudget;
  // The device whose runs and checks these are: this one for a job every device runs, else the chosen one; empty
  // when no device has looked yet.
  device: string;
  today: MaintenanceUse;
  // When it last looked for work, and why it last did nothing, in plain words; empty when it has not.
  checked_at: string;
  skip_reason: string;
  skipped_at: string;
  // How many times today it looked and found nothing to do.
  skips_today: number;
  // A part of its budget is used up for today, in plain words; empty while it may run.
  used_up: string;
  last_run: JobRun | null;
}
