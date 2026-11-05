CREATE TABLE `proposal_budgets` (
	`proposal_id` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`applied_budget_id` integer,
	`replaced_budget_id` integer,
	PRIMARY KEY(`proposal_id`, `category`),
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`applied_budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`replaced_budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `proposal_budgets_category` ON `proposal_budgets` (`category`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`run_id` text NOT NULL,
	`reason` text NOT NULL,
	`goal_id` text,
	`goal_amount` integer,
	`words` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text,
	`closed_by` text,
	`applied` text,
	`undone_at` text,
	`undone_by` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`undone_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `proposals_status` ON `proposals` (`status`);--> statement-breakpoint
CREATE INDEX `proposals_run` ON `proposals` (`source`,`run_id`);--> statement-breakpoint
CREATE INDEX `proposals_goal_id` ON `proposals` (`goal_id`);--> statement-breakpoint
ALTER TABLE `budgets` ADD `no_budget` integer DEFAULT false NOT NULL;