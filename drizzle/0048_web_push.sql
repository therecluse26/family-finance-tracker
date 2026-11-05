CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_endpoint_unique` ON `push_devices` (`endpoint`);--> statement-breakpoint
CREATE TABLE `push_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer NOT NULL,
	`alert_id` text,
	`notice_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `push_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notice_id`) REFERENCES `system_notices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_sends_device` ON `push_sends` (`device_id`);--> statement-breakpoint
CREATE INDEX `push_sends_alert` ON `push_sends` (`alert_id`);--> statement-breakpoint
CREATE INDEX `push_sends_notice` ON `push_sends` (`notice_id`);--> statement-breakpoint
CREATE TABLE `vapid_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	CONSTRAINT "vapid_keys_one_row" CHECK("vapid_keys"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `alert_deliveries` ADD `push_done_at` text;--> statement-breakpoint
ALTER TABLE `notice_deliveries` ADD `push_done_at` text;