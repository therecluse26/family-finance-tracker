CREATE TABLE `transfer_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_key` text NOT NULL,
	`merchant_name` text NOT NULL,
	`last_fours` text NOT NULL,
	`answer` text NOT NULL,
	`account_id` text,
	`made_at` text NOT NULL,
	`made_by` text,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`made_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_answers_key` ON `transfer_answers` (`merchant_key`,`last_fours`);