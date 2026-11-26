ALTER TABLE `conversation_messages` ADD `error_detail` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `notices` text DEFAULT '[]' NOT NULL;