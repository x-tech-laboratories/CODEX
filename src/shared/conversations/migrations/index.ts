// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126072655_start",
    "statements": [
      "CREATE TABLE `conversation_messages` (\n\t`id` text PRIMARY KEY,\n\t`conversation_id` text NOT NULL,\n\t`role` text NOT NULL,\n\t`text` text DEFAULT '' NOT NULL,\n\t`engine` text DEFAULT '' NOT NULL,\n\t`model` text DEFAULT '' NOT NULL,\n\t`tool_calls` text DEFAULT '[]' NOT NULL,\n\t`error` text DEFAULT '' NOT NULL,\n\t`input_tokens` integer DEFAULT 0 NOT NULL,\n\t`output_tokens` integer DEFAULT 0 NOT NULL,\n\t`created_at` text NOT NULL\n);",
      "CREATE INDEX `conversation_messages_by_conversation` ON `conversation_messages` (`conversation_id`,`created_at`);"
    ]
  },
  {
    "name": "20261126090940_sources",
    "statements": [
      "ALTER TABLE `conversation_messages` ADD `sources` text DEFAULT '[\"*\"]' NOT NULL;"
    ]
  },
  {
    "name": "20261126092504_conversation_items",
    "statements": [
      "CREATE TABLE `conversations` (\n\t`id` text PRIMARY KEY,\n\t`title` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL\n);"
    ]
  },
  {
    "name": "20261126104542_notices",
    "statements": [
      "ALTER TABLE `conversation_messages` ADD `error_detail` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `conversation_messages` ADD `notices` text DEFAULT '[]' NOT NULL;"
    ]
  },
  {
    "name": "20261127230412_thinking",
    "statements": [
      "ALTER TABLE `conversation_messages` ADD `thinking` text DEFAULT '[]' NOT NULL;"
    ]
  },
  {
    "name": "20261128043838_task_list",
    "statements": [
      "ALTER TABLE `conversations` ADD `task_list` text DEFAULT '[]' NOT NULL;"
    ]
  }
];
