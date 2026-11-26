// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126115914_start",
    "statements": [
      "CREATE TABLE `blueprint_changes` (\n\t`id` text PRIMARY KEY,\n\t`blueprint_id` text NOT NULL,\n\t`title` text NOT NULL,\n\t`applies_when` text DEFAULT '' NOT NULL,\n\t`body` text DEFAULT '' NOT NULL,\n\t`reason` text DEFAULT '' NOT NULL,\n\t`status` text DEFAULT 'waiting' NOT NULL,\n\t`made_by` text NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`sources` text DEFAULT '[]' NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`decided_at` text DEFAULT '' NOT NULL\n);",
      "CREATE TABLE `blueprint_uses` (\n\t`id` text PRIMARY KEY,\n\t`blueprint_id` text NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`run_id` text DEFAULT '' NOT NULL,\n\t`used_at` text NOT NULL\n);",
      "CREATE TABLE `blueprints` (\n\t`id` text PRIMARY KEY,\n\t`title` text NOT NULL,\n\t`applies_when` text DEFAULT '' NOT NULL,\n\t`body` text DEFAULT '' NOT NULL,\n\t`status` text NOT NULL,\n\t`made_by` text NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`sources` text DEFAULT '[]' NOT NULL,\n\t`conversation_id` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);",
      "CREATE INDEX `blueprint_changes_by_blueprint` ON `blueprint_changes` (`blueprint_id`,`status`);",
      "CREATE INDEX `blueprint_uses_by_blueprint` ON `blueprint_uses` (`blueprint_id`,`used_at`);",
      "CREATE INDEX `blueprints_by_status` ON `blueprints` (`status`);"
    ]
  }
];
