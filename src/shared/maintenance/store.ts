// The maintenance jobs: CODEX's own upkeep, built in beside the jobs the assistant makes, which the user can turn on
// or off and budget but never remove. Reading their state is open to anyone; changing a switch or a budget is the
// user's alone, at the page.

// ── Imports ──────────────────────────────────────────────────────────────────

import { synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { settings_of } from "@x-tech-laboratories/x-libs/settings";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { define_feature } from "../feature.ts";
import { job_host } from "../jobs/runner.ts";
import { background_setting, device_id_of, list_devices } from "../jobs/records.ts";
import { write_setting } from "../settings.ts";
import { maintenance_host } from "./loop.ts";
import { migrations } from "./migrations/index.ts";
import { is_maintenance_key, maintenance_jobs, maintenance_keys, maintenance_setting, type MaintenanceJobEntry, type MaintenanceJobSetting, type MaintenanceKey } from "./model.ts";
import { budget_of, check_of, checked_budget, day_of, job_on, last_run_of, stored_job_settings, use_today } from "./records.ts";
import { maintenance_tables } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

function now_of(): number {
  const host = maintenance_host();
  if (host) return host.now();
  try {
    return job_host().now();
  } catch {
    return Date.now();
  }
}

// This device's name where the store runs here, or empty, such as in a test's store.
function own_name(): string {
  return maintenance_host()?.device ?? "";
}

// Each maintenance job with its switch, budget, today's use, what it last did and why it last did nothing: as this
// device found for a job every device runs, and as the chosen device found for the rest.
function list_maintenance_jobs(database: SqlDatabase): MaintenanceJobEntry[] {
  const now = now_of();
  const chosen = background_setting(database, "device");
  const chosen_name = list_devices(database).find((device) => device.id === chosen)?.name ?? "";
  const own = own_name() || (chosen === device_id_of(database) ? chosen_name : "");
  return maintenance_keys.map((key) => {
    const info = maintenance_jobs[key];
    const device = info.where === "every" ? own : chosen_name;
    const check = device ? check_of(database, key, device) : null;
    const today = day_of(now);
    return {
      ...info,
      on: job_on(database, key),
      budget: budget_of(database, key),
      device,
      today: use_today(database, key, now, device),
      checked_at: check?.checked_at ?? "",
      skip_reason: check?.skip_reason ?? "",
      skipped_at: check?.skipped_at ?? "",
      skips_today: check && check.day === today ? check.skips : 0,
      used_up: check && check.day === today ? check.used_up : "",
      last_run: device ? last_run_of(database, key, device) : null,
    };
  });
}

// ── Writing ──────────────────────────────────────────────────────────────────

// Turns one job on or off, or changes its budget; what is left out stays.
function set_maintenance_job(database: SqlDatabase, key: MaintenanceKey, changes: MaintenanceJobSetting): void {
  if (!is_maintenance_key(key)) throw new Error(`A maintenance job is one of ${maintenance_keys.join(", ")}.`);
  if (!changes || typeof changes !== "object") throw new Error("Say what changes: on, budget or both.");
  if (changes.on !== undefined && typeof changes.on !== "boolean") throw new Error("Turn a job on with true or off with false.");
  const budget = checked_budget(changes.budget);
  const stored = stored_job_settings(database);
  const was = stored[key] ?? {};
  const next: MaintenanceJobSetting = { ...was, ...(changes.on !== undefined ? { on: changes.on } : {}), budget: { ...was.budget, ...budget } };
  write_setting(database, maintenance_setting, { ...stored, [key]: next });
}

// ── Feature ──────────────────────────────────────────────────────────────────

const budget_schema = {
  type: "object",
  description:
    "Only the parts that change: runs_per_day (0 to 288), items_per_run (1 to 10,000), seconds_per_run (5 to 3,600), for suggest and research model_calls_per_day (1 to 500) and tokens_per_day (1,000 to 2,000,000), and for research web_requests_per_run (1 to 50).",
  properties: {
    runs_per_day: { type: "integer" },
    items_per_run: { type: "integer" },
    seconds_per_run: { type: "integer" },
    model_calls_per_day: { type: "integer" },
    tokens_per_day: { type: "integer" },
    web_requests_per_run: { type: "integer" },
  },
} as const;

export const maintenance_feature = define_feature({
  id: "maintenance",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(maintenance_tables),
  methods: { list_maintenance_jobs, set_maintenance_job },
  api: {
    list_maintenance_jobs: {
      description:
        "Lists CODEX's built-in maintenance jobs, which keep the index, embeddings and graph up to date in the background, research the assistant's accepted interests on the web, and write a daily digest: each with what it does, whether it is on, its budget (runs a day, things handled per run, seconds per run, and for the one that calls a model, model calls and tokens a day), today's use, its last run, and why it last did nothing. They run only on the device chosen for background work, but the index and embeddings, which every device keeps for itself.",
      params: [],
    },
    set_maintenance_job: {
      page_only: true,
      description: "Turns one maintenance job on or off, or changes its budget. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "key", schema: { type: "string", enum: maintenance_keys, description: "The job: index, embed, rules, similarity, tidy, suggest, research or digest." } },
        {
          name: "changes",
          schema: { type: "object", properties: { on: { type: "boolean", description: "true to turn it on." }, budget: budget_schema }, description: "What changes; what is left out stays." },
        },
      ],
    },
  },
  settings: settings_of({ [maintenance_setting]: {} }, { user_only: true }),
});
