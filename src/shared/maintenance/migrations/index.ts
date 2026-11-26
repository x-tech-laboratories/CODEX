// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126212018_start",
    "statements": [
      "CREATE TABLE `maintenance_checks` (\n\t`job` text NOT NULL,\n\t`device` text NOT NULL,\n\t`checked_at` text NOT NULL,\n\t`day` text NOT NULL,\n\t`skips` integer DEFAULT 0 NOT NULL,\n\t`skip_reason` text DEFAULT '' NOT NULL,\n\t`skipped_at` text DEFAULT '' NOT NULL,\n\t`used_up` text DEFAULT '' NOT NULL,\n\tCONSTRAINT `maintenance_checks_pk` PRIMARY KEY(`job`, `device`)\n);",
      "CREATE TABLE `maintenance_contexts` (\n\t`context_id` text PRIMARY KEY,\n\t`context_mark` text NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`suggested_at` text NOT NULL\n);"
    ]
  }
];
