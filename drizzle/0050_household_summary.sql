CREATE TABLE `household_summary` (
	`id` integer PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`text` text NOT NULL,
	`built_at` text NOT NULL,
	CONSTRAINT "household_summary_one_row" CHECK("household_summary"."id" = 1)
);
