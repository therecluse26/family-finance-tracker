CREATE TABLE `redraft_proposals` (
	`proposal_id` text PRIMARY KEY NOT NULL,
	`steady_income` integer NOT NULL,
	`ce_data_year` integer NOT NULL,
	`sample_benchmarks` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `budget_inputs` ADD `redrafted_at` text;--> statement-breakpoint
ALTER TABLE `budget_inputs` ADD `benchmark_redraft_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `budget_tailoring_runs_one_redraft` ON `budget_tailoring_runs` (`kind`) WHERE "budget_tailoring_runs"."kind" = 'Redraft';