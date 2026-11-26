CREATE TABLE `context_views` (
	`context_id` text PRIMARY KEY,
	`view` text DEFAULT 'list' NOT NULL,
	`card_places` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `fk_context_views_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE
);
