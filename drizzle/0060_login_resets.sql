CREATE TABLE `login_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_resets_member_id_unique` ON `login_resets` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `login_resets_token_hash_unique` ON `login_resets` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_resets_expires_at` ON `login_resets` (`expires_at`);