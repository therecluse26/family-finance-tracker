CREATE TABLE `household_facts` (
	`id` integer PRIMARY KEY NOT NULL,
	`zip_code` text NOT NULL,
	`state` text NOT NULL,
	`time_zone` text NOT NULL,
	`ages` text NOT NULL,
	`rent_or_own` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "household_facts_one_row" CHECK("household_facts"."id" = 1)
);
