CREATE TABLE `job_checks` (
	`job_id` text PRIMARY KEY NOT NULL,
	`checked_at` text NOT NULL,
	`context_mark` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_device` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text DEFAULT '' NOT NULL,
	`device` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`rounds` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`applied` text DEFAULT '[]' NOT NULL,
	`proposed` text DEFAULT '[]' NOT NULL,
	`outcome` text DEFAULT 'running' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`run_id` text DEFAULT '' NOT NULL,
	`context_mark` text DEFAULT '' NOT NULL,
	`dismissed_at` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`instruction` text NOT NULL,
	`context_id` text DEFAULT '' NOT NULL,
	`schedule` text NOT NULL,
	`only_when_changed` integer DEFAULT 0 NOT NULL,
	`max_rounds` integer NOT NULL,
	`max_tokens` integer NOT NULL,
	`max_runs_per_day` integer NOT NULL,
	`is_on` integer DEFAULT 1 NOT NULL,
	`made_by` text NOT NULL,
	`conversation_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_by_job` ON `job_runs` (`job_id`,`started_at`);