CREATE TABLE `background_devices` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `job_runs` ADD `items` integer DEFAULT 0 NOT NULL;