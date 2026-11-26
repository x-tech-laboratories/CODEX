// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126101342_start",
    "statements": [
      "CREATE TABLE `graph_decisions` (\n\t`id` text PRIMARY KEY,\n\t`target` text NOT NULL,\n\t`target_id` text NOT NULL,\n\t`made_by` text NOT NULL,\n\t`rule` text DEFAULT '' NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`decision` text NOT NULL,\n\t`decided_at` text NOT NULL\n);",
      "CREATE TABLE `graph_entities` (\n\t`id` text PRIMARY KEY,\n\t`kind` text NOT NULL,\n\t`name` text NOT NULL,\n\t`alt_names` text DEFAULT '[]' NOT NULL,\n\t`status` text NOT NULL,\n\t`made_by` text NOT NULL,\n\t`rule` text DEFAULT '' NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`evidence_ref` text DEFAULT '' NOT NULL,\n\t`evidence_excerpt` text DEFAULT '' NOT NULL,\n\t`sources` text DEFAULT '[]' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`decided_at` text DEFAULT '' NOT NULL\n);",
      "CREATE TABLE `graph_links` (\n\t`id` text PRIMARY KEY,\n\t`from_kind` text NOT NULL,\n\t`from_id` text NOT NULL,\n\t`to_kind` text NOT NULL,\n\t`to_id` text NOT NULL,\n\t`type` text NOT NULL,\n\t`label` text DEFAULT '' NOT NULL,\n\t`status` text NOT NULL,\n\t`made_by` text NOT NULL,\n\t`rule` text DEFAULT '' NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`evidence_ref` text DEFAULT '' NOT NULL,\n\t`evidence_excerpt` text DEFAULT '' NOT NULL,\n\t`valid_from` text DEFAULT '' NOT NULL,\n\t`valid_until` text DEFAULT '' NOT NULL,\n\t`recorded_at` text NOT NULL,\n\t`decided_at` text DEFAULT '' NOT NULL,\n\t`sources` text DEFAULT '[]' NOT NULL\n);",
      "CREATE INDEX `graph_entities_by_status` ON `graph_entities` (`status`);",
      "CREATE INDEX `graph_links_by_from` ON `graph_links` (`from_kind`,`from_id`);",
      "CREATE INDEX `graph_links_by_to` ON `graph_links` (`to_kind`,`to_id`);",
      "CREATE INDEX `graph_links_by_status` ON `graph_links` (`status`);"
    ]
  }
];
