CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`engine` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`tool_calls` text DEFAULT '[]' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_by_conversation` ON `conversation_messages` (`conversation_id`,`created_at`);