CREATE TABLE `alert_channels` (
	`member_id` text PRIMARY KEY NOT NULL,
	`push` integer NOT NULL,
	`email` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alert_deliveries` (
	`alert_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`advice` text,
	`created_at` text NOT NULL,
	`email_tries` integer DEFAULT 0 NOT NULL,
	`email_done_at` text,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `smtp_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`sender` text NOT NULL,
	CONSTRAINT "smtp_settings_one_row" CHECK("smtp_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `notice_deliveries` ADD `email_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notice_deliveries` ADD `email_done_at` text;