// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126185905_start",
    "statements": [
      "CREATE TABLE `job_checks` (\n\t`job_id` text PRIMARY KEY NOT NULL,\n\t`checked_at` text NOT NULL,\n\t`context_mark` text NOT NULL\n);",
      "CREATE TABLE `job_device` (\n\t`key` text PRIMARY KEY,\n\t`value` text NOT NULL\n);",
      "CREATE TABLE `job_runs` (\n\t`id` text PRIMARY KEY,\n\t`job_id` text NOT NULL,\n\t`title` text DEFAULT '' NOT NULL,\n\t`started_at` text NOT NULL,\n\t`ended_at` text DEFAULT '' NOT NULL,\n\t`device` text DEFAULT '' NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`rounds` integer DEFAULT 0 NOT NULL,\n\t`input_tokens` integer DEFAULT 0 NOT NULL,\n\t`output_tokens` integer DEFAULT 0 NOT NULL,\n\t`applied` text DEFAULT '[]' NOT NULL,\n\t`proposed` text DEFAULT '[]' NOT NULL,\n\t`outcome` text DEFAULT 'running' NOT NULL,\n\t`note` text DEFAULT '' NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`run_id` text DEFAULT '' NOT NULL,\n\t`context_mark` text DEFAULT '' NOT NULL,\n\t`dismissed_at` text DEFAULT '' NOT NULL\n);",
      "CREATE TABLE `jobs` (\n\t`id` text PRIMARY KEY,\n\t`title` text NOT NULL,\n\t`instruction` text NOT NULL,\n\t`context_id` text DEFAULT '' NOT NULL,\n\t`schedule` text NOT NULL,\n\t`only_when_changed` integer DEFAULT 0 NOT NULL,\n\t`max_rounds` integer NOT NULL,\n\t`max_tokens` integer NOT NULL,\n\t`max_runs_per_day` integer NOT NULL,\n\t`is_on` integer DEFAULT 1 NOT NULL,\n\t`made_by` text NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
      "CREATE INDEX `job_runs_by_job` ON `job_runs` (`job_id`,`started_at`);"
    ]
  }
];
