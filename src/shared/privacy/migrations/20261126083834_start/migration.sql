CREATE TABLE `hosted_sends` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`engine` text NOT NULL,
	`model` text NOT NULL,
	`included` text DEFAULT '[]' NOT NULL,
	`withheld` text DEFAULT '[]' NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`sent_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosted_sends_by_time` ON `hosted_sends` (`sent_at`);