// Written by x-libs-bundle-migrations from the migration folders beside it; run it again after drizzle-kit generate.

import type { DrizzleMigration } from "@x-tech-laboratories/x-libs/drizzle";

export const migrations: DrizzleMigration[] = [
  {
    "name": "20261125061610_start",
    "statements": [
      "CREATE TABLE `context_items` (\n\t`context_id` text NOT NULL,\n\t`item_id` text NOT NULL,\n\t`note` text DEFAULT '' NOT NULL,\n\t`position` real DEFAULT 0 NOT NULL,\n\t`added_at` text NOT NULL,\n\tCONSTRAINT `context_items_pk` PRIMARY KEY(`context_id`, `item_id`),\n\tCONSTRAINT `fk_context_items_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_context_items_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE\n);",
      "CREATE TABLE `contexts` (\n\t`id` text PRIMARY KEY,\n\t`parent_id` text,\n\t`name` text NOT NULL,\n\t`notes` text DEFAULT '' NOT NULL,\n\t`position` real DEFAULT 0 NOT NULL,\n\t`is_archived` integer DEFAULT 0 NOT NULL,\n\t`created_at` text NOT NULL\n);",
      "CREATE TABLE `items` (\n\t`id` text PRIMARY KEY,\n\t`collector` text NOT NULL,\n\t`source_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`title` text NOT NULL,\n\t`snippet` text DEFAULT '' NOT NULL,\n\t`uri` text DEFAULT '' NOT NULL,\n\t`status` text DEFAULT '' NOT NULL,\n\t`detail` text DEFAULT '{}' NOT NULL,\n\t`seen_at` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL\n);",
      "CREATE INDEX `context_items_by_item` ON `context_items` (`item_id`);",
      "CREATE INDEX `contexts_by_parent` ON `contexts` (`parent_id`);",
      "CREATE INDEX `items_by_collector` ON `items` (`collector`);"
    ]
  },
  {
    "name": "20261125063525_feeds",
    "statements": [
      "CREATE TABLE `context_feeds` (\n\t`context_id` text NOT NULL,\n\t`collector` text NOT NULL,\n\t`feed_id` text NOT NULL,\n\t`label` text NOT NULL,\n\t`added_at` text NOT NULL,\n\tCONSTRAINT `context_feeds_pk` PRIMARY KEY(`context_id`, `collector`, `feed_id`),\n\tCONSTRAINT `fk_context_feeds_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE\n);",
      "ALTER TABLE `context_items` ADD `via` text DEFAULT '' NOT NULL;"
    ]
  },
  {
    "name": "20261125071226_card_views",
    "statements": [
      "CREATE TABLE `context_views` (\n\t`context_id` text PRIMARY KEY,\n\t`view` text DEFAULT 'list' NOT NULL,\n\t`card_places` text DEFAULT '[]' NOT NULL,\n\tCONSTRAINT `fk_context_views_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE\n);"
    ]
  },
  {
    "name": "20261125085054_feed_groups",
    "statements": [
      "CREATE TABLE `context_seeds` (\n\t`context_id` text PRIMARY KEY,\n\t`collector` text NOT NULL,\n\t`group_id` text NOT NULL,\n\t`label` text NOT NULL,\n\t`added_at` text NOT NULL,\n\tCONSTRAINT `fk_context_seeds_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE\n);"
    ]
  }
];
