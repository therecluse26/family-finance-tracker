CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`month` text NOT NULL,
	`use` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`no_cache_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_nanos` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_calls_month` ON `ai_calls` (`month`);--> statement-breakpoint
CREATE TABLE `ai_cost_cap` (
	`id` integer PRIMARY KEY NOT NULL,
	`cap_cents` integer,
	`warned_month` text,
	`reached_month` text,
	CONSTRAINT "ai_cost_cap_one_row" CHECK("ai_cost_cap"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `ai_model_prices` (
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	PRIMARY KEY(`provider`, `model`)
);
