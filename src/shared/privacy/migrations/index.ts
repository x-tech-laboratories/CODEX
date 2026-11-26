// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261126083834_start",
    "statements": [
      "CREATE TABLE `hosted_sends` (\n\t`id` text PRIMARY KEY,\n\t`run_id` text NOT NULL,\n\t`conversation_id` text NOT NULL,\n\t`engine` text NOT NULL,\n\t`model` text NOT NULL,\n\t`included` text DEFAULT '[]' NOT NULL,\n\t`withheld` text DEFAULT '[]' NOT NULL,\n\t`item_count` integer DEFAULT 0 NOT NULL,\n\t`sent_at` text NOT NULL\n);",
      "CREATE INDEX `hosted_sends_by_time` ON `hosted_sends` (`sent_at`);"
    ]
  },
  {
    "name": "20261126202710_tool_sends",
    "statements": [
      "ALTER TABLE `hosted_sends` ADD `kind` text DEFAULT 'reply' NOT NULL;",
      "ALTER TABLE `hosted_sends` ADD `tool` text DEFAULT '' NOT NULL;",
      "ALTER TABLE `hosted_sends` ADD `argument_count` integer DEFAULT 0 NOT NULL;",
      "ALTER TABLE `hosted_sends` ADD `argument_chars` integer DEFAULT 0 NOT NULL;"
    ]
  }
];
