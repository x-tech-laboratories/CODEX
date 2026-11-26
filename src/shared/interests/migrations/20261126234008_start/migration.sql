CREATE TABLE `interests` (
	`id` text PRIMARY KEY,
	`topic` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`made_by` text NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`context_id` text DEFAULT '' NOT NULL,
	`researched_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interests_by_state` ON `interests` (`state`);