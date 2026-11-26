CREATE TABLE `maintenance_checks` (
	`job` text NOT NULL,
	`device` text NOT NULL,
	`checked_at` text NOT NULL,
	`day` text NOT NULL,
	`skips` integer DEFAULT 0 NOT NULL,
	`skip_reason` text DEFAULT '' NOT NULL,
	`skipped_at` text DEFAULT '' NOT NULL,
	`used_up` text DEFAULT '' NOT NULL,
	CONSTRAINT `maintenance_checks_pk` PRIMARY KEY(`job`, `device`)
);
--> statement-breakpoint
CREATE TABLE `maintenance_contexts` (
	`context_id` text PRIMARY KEY,
	`context_mark` text NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`suggested_at` text NOT NULL
);
