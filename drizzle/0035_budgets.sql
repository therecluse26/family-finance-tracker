CREATE TABLE `budget_inputs` (
	`id` integer PRIMARY KEY NOT NULL,
	`steady_income` integer NOT NULL,
	`ce_data_year` integer NOT NULL,
	`sample_benchmarks` integer NOT NULL,
	`first_draft_month` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "budget_inputs_one_row" CHECK("budget_inputs"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`period` text NOT NULL,
	`takes_effect` text NOT NULL,
	`source` text NOT NULL,
	`set_by` text,
	`pinned` integer,
	`set_at` text NOT NULL,
	FOREIGN KEY (`set_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `budgets_takes_effect` ON `budgets` (`takes_effect`);