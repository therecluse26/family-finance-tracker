CREATE TABLE `cpi_fetch` (
	`id` integer PRIMARY KEY NOT NULL,
	`fetched_at` text,
	`fetched_round` text,
	`failed_round` text,
	`failed_tries` integer DEFAULT 0 NOT NULL,
	`last_failure` text,
	CONSTRAINT "cpi_fetch_one_row" CHECK("cpi_fetch"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `cpi_values` (
	`series` text NOT NULL,
	`month` text NOT NULL,
	`value` real NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`series`, `month`)
);
