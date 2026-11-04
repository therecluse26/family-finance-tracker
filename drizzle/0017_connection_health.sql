ALTER TABLE `connections` ADD `last_sync_attempt_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `next_sync_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `retrying_since` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `failed_syncs` integer DEFAULT 0 NOT NULL;