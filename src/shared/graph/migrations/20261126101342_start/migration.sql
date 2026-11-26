CREATE TABLE `graph_decisions` (
	`id` text PRIMARY KEY,
	`target` text NOT NULL,
	`target_id` text NOT NULL,
	`made_by` text NOT NULL,
	`rule` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`decision` text NOT NULL,
	`decided_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_entities` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`alt_names` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`made_by` text NOT NULL,
	`rule` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`evidence_ref` text DEFAULT '' NOT NULL,
	`evidence_excerpt` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_links` (
	`id` text PRIMARY KEY,
	`from_kind` text NOT NULL,
	`from_id` text NOT NULL,
	`to_kind` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`made_by` text NOT NULL,
	`rule` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`evidence_ref` text DEFAULT '' NOT NULL,
	`evidence_excerpt` text DEFAULT '' NOT NULL,
	`valid_from` text DEFAULT '' NOT NULL,
	`valid_until` text DEFAULT '' NOT NULL,
	`recorded_at` text NOT NULL,
	`decided_at` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_entities_by_status` ON `graph_entities` (`status`);--> statement-breakpoint
CREATE INDEX `graph_links_by_from` ON `graph_links` (`from_kind`,`from_id`);--> statement-breakpoint
CREATE INDEX `graph_links_by_to` ON `graph_links` (`to_kind`,`to_id`);--> statement-breakpoint
CREATE INDEX `graph_links_by_status` ON `graph_links` (`status`);