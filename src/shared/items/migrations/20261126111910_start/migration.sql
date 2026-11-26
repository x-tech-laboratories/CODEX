CREATE TABLE `item_marks` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT `item_marks_pk` PRIMARY KEY(`kind`, `id`)
);
