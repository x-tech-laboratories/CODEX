// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126234008_start",
    "statements": [
      "CREATE TABLE `interests` (\n\t`id` text PRIMARY KEY,\n\t`topic` text NOT NULL,\n\t`reason` text DEFAULT '' NOT NULL,\n\t`state` text NOT NULL,\n\t`made_by` text NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`sources` text DEFAULT '[]' NOT NULL,\n\t`context_id` text DEFAULT '' NOT NULL,\n\t`researched_at` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
      "CREATE INDEX `interests_by_state` ON `interests` (`state`);"
    ]
  }
];
