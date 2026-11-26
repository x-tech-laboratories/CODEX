ALTER TABLE `hosted_sends` ADD `kind` text DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE `hosted_sends` ADD `tool` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `hosted_sends` ADD `argument_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hosted_sends` ADD `argument_chars` integer DEFAULT 0 NOT NULL;