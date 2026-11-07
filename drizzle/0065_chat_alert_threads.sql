CREATE TABLE `chat_alert_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`member_id` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_alert_threads_alert_member` ON `chat_alert_threads` (`alert_id`,`member_id`);