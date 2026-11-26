CREATE TABLE `proposals` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`method` text NOT NULL,
	`arguments` text DEFAULT '{}' NOT NULL,
	`summary` text NOT NULL,
	`reason` text DEFAULT 'level' NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposals_by_conversation` ON `proposals` (`conversation_id`,`status`);