CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`made_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`made_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_expires_at` ON `invites` (`expires_at`);--> statement-breakpoint
CREATE TABLE `removed_members` (
	`label_number` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`removed_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `goals` ADD `author_name` text;