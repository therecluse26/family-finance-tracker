ALTER TABLE `ai_redo` ADD `last_run_at` text;--> statement-breakpoint
ALTER TABLE `ai_redo` ADD `last_run_items` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_redo` ADD `last_run_outcome` text;