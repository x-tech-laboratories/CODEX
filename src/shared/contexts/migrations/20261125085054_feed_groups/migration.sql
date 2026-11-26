CREATE TABLE `context_seeds` (
	`context_id` text PRIMARY KEY,
	`collector` text NOT NULL,
	`group_id` text NOT NULL,
	`label` text NOT NULL,
	`added_at` text NOT NULL,
	CONSTRAINT `fk_context_seeds_context_id_contexts_id_fk` FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON DELETE CASCADE
);
