CREATE TABLE `weekly_summary_sends` (
	`member_id` text NOT NULL,
	`week_start` text NOT NULL,
	`state` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `week_start`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `alert_channels` ADD `weekly_summary` integer DEFAULT false NOT NULL;