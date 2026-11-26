CREATE TABLE `blueprint_changes` (
	`id` text PRIMARY KEY,
	`blueprint_id` text NOT NULL,
	`title` text NOT NULL,
	`applies_when` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`made_by` text NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blueprint_uses` (
	`id` text PRIMARY KEY,
	`blueprint_id` text NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`used_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blueprints` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`applies_when` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`made_by` text NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blueprint_changes_by_blueprint` ON `blueprint_changes` (`blueprint_id`,`status`);--> statement-breakpoint
CREATE INDEX `blueprint_uses_by_blueprint` ON `blueprint_uses` (`blueprint_id`,`used_at`);--> statement-breakpoint
CREATE INDEX `blueprints_by_status` ON `blueprints` (`status`);