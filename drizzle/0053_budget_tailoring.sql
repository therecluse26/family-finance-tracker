CREATE TABLE `budget_tailoring_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`goal_id` text,
	`requested_at` text NOT NULL,
	`failed_tries` integer DEFAULT 0 NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `budget_tailoring_runs_goal_id` ON `budget_tailoring_runs` (`goal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_tailoring_runs_one_tailoring` ON `budget_tailoring_runs` (`kind`) WHERE "budget_tailoring_runs"."kind" = 'Tailoring';--> statement-breakpoint
ALTER TABLE `budgets` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `proposal_budgets` ADD `reason` text;