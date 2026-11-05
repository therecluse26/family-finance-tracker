CREATE TABLE `ai_redo` (
	`id` integer PRIMARY KEY NOT NULL,
	`away_at` text,
	`away_reason` text,
	`due_at` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`first_run_done_at` text,
	CONSTRAINT "ai_redo_one_row" CHECK("ai_redo"."id" = 1)
);
