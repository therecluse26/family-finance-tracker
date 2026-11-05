CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`words` text NOT NULL,
	`author_id` text,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`ended_on` text,
	`ended_by` text,
	`target` text,
	`change` text,
	`deadline` text,
	`goal_amount` integer,
	`starts_on` text,
	`start_balance` integer,
	`baseline` integer,
	FOREIGN KEY (`author_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `goals_status` ON `goals` (`status`);