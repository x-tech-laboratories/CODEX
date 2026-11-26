CREATE TABLE `context_items` (
	`context_id` text NOT NULL,
	`item_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`added_at` text NOT NULL,
	CONSTRAINT `context_items_pk` PRIMARY KEY(`context_id`, `item_id`),
	CONSTRAINT `fk_context_items_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_context_items_item_id_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `contexts` (
	`id` text PRIMARY KEY,
	`parent_id` text,
	`name` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`is_archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY,
	`collector` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`uri` text DEFAULT '' NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`seen_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_items_by_item` ON `context_items` (`item_id`);--> statement-breakpoint
CREATE INDEX `contexts_by_parent` ON `contexts` (`parent_id`);--> statement-breakpoint
CREATE INDEX `items_by_collector` ON `items` (`collector`);