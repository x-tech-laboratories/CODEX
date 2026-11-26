CREATE TABLE `context_feeds` (
	`context_id` text NOT NULL,
	`collector` text NOT NULL,
	`feed_id` text NOT NULL,
	`label` text NOT NULL,
	`added_at` text NOT NULL,
	CONSTRAINT `context_feeds_pk` PRIMARY KEY(`context_id`, `collector`, `feed_id`),
	CONSTRAINT `fk_context_feeds_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `context_items` ADD `via` text DEFAULT '' NOT NULL;