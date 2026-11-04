CREATE TABLE `history_wait` (
	`id` integer PRIMARY KEY NOT NULL,
	`ended_at` text,
	`first_run_started_at` text,
	`first_run_restarts` integer DEFAULT 0 NOT NULL,
	`first_run_done_at` text,
	CONSTRAINT "history_wait_one_row" CHECK("history_wait"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `connections` ADD `history_wait_released_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `later_hooks_started_at` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `later_hooks_restarts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `history_load` integer DEFAULT false NOT NULL;