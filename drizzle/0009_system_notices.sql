CREATE TABLE `notice_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notice_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`notice_id`) REFERENCES `system_notices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `system_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`condition` text,
	`raised_at` text NOT NULL,
	`closed_at` text,
	`closed_by` text,
	FOREIGN KEY (`closed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_notices_open_condition` ON `system_notices` (`condition`) WHERE "system_notices"."closed_at" IS NULL;