-- Global, the root context every other sits under, made once with a fixed id so every device makes the same row.
INSERT OR IGNORE INTO `contexts` (`id`, `parent_id`, `name`, `notes`, `position`, `is_archived`, `created_at`) VALUES ('global', NULL, 'Global', '', 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
UPDATE `contexts` SET `parent_id` = NULL, `is_archived` = 0 WHERE `id` = 'global';
--> statement-breakpoint
UPDATE `contexts` SET `parent_id` = 'global' WHERE `parent_id` IS NULL AND `id` <> 'global';
--> statement-breakpoint
INSERT OR IGNORE INTO `context_items` (`context_id`, `item_id`, `note`, `position`, `added_at`, `via`)
  SELECT 'global', `id`, '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '' FROM `items`
  WHERE `collector` IN ('conversation', 'blueprint') AND `status` <> 'missing' AND `id` NOT IN (SELECT `item_id` FROM `context_items`);
