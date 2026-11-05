CREATE TABLE `alert_presses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_id` text NOT NULL,
	`member_id` text,
	`pressed_at` text NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alert_presses_alert_id` ON `alert_presses` (`alert_id`);--> statement-breakpoint
CREATE TABLE `alert_transactions` (
	`transaction_id` text NOT NULL,
	`alert_id` text NOT NULL,
	PRIMARY KEY(`transaction_id`, `alert_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_transactions_alert_id` ON `alert_transactions` (`alert_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`facts` text NOT NULL,
	`text` text NOT NULL,
	`category` text,
	`advice` text,
	`state` text
);
--> statement-breakpoint
CREATE INDEX `alerts_created_at` ON `alerts` (`created_at`);--> statement-breakpoint
CREATE TABLE `anomaly_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`failed_tries` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "anomaly_checks_one_row" CHECK("anomaly_checks"."id" = 1)
);
