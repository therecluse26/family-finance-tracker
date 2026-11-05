CREATE TABLE `alert_decisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`failed_tries` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "alert_decisions_one_row" CHECK("alert_decisions"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `alert_parts` (
	`alert_id` text PRIMARY KEY NOT NULL,
	`merged_into` text NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`merged_into`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_parts_merged_into` ON `alert_parts` (`merged_into`);--> statement-breakpoint
CREATE TABLE `alert_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`weekly_cap` integer NOT NULL,
	CONSTRAINT "alert_settings_one_row" CHECK("alert_settings"."id" = 1),
	CONSTRAINT "alert_settings_weekly_cap" CHECK("alert_settings"."weekly_cap" >= 0)
);
