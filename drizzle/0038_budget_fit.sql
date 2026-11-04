CREATE TABLE `budget_draft_acceptance` (
	`id` integer PRIMARY KEY NOT NULL,
	`accepted_at` text NOT NULL,
	`accepted_by` text,
	FOREIGN KEY (`accepted_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "budget_draft_acceptance_one_row" CHECK("budget_draft_acceptance"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `budget_month_starts` (
	`month` text PRIMARY KEY NOT NULL,
	`done_at` text,
	`failed_tries` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `budget_inputs` ADD `fixed_costs_pass_income` integer DEFAULT false NOT NULL;