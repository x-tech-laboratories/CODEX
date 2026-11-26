// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126072656_start",
    "statements": [
      "CREATE TABLE `proposals` (\n\t`id` text PRIMARY KEY,\n\t`conversation_id` text NOT NULL,\n\t`method` text NOT NULL,\n\t`arguments` text DEFAULT '{}' NOT NULL,\n\t`summary` text NOT NULL,\n\t`reason` text DEFAULT 'level' NOT NULL,\n\t`status` text DEFAULT 'waiting' NOT NULL,\n\t`result` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`resolved_at` text DEFAULT '' NOT NULL\n);",
      "CREATE INDEX `proposals_by_conversation` ON `proposals` (`conversation_id`,`status`);"
    ]
  },
  {
    "name": "20261126090942_sources",
    "statements": [
      "ALTER TABLE `proposals` ADD `sources` text DEFAULT '[\"*\"]' NOT NULL;"
    ]
  },
  {
    "name": "20261126114227_evidence",
    "statements": [
      "ALTER TABLE `proposals` ADD `evidence` text DEFAULT '{}' NOT NULL;"
    ]
  }
];
