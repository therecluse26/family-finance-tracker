CREATE TABLE `typed_balances` (
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`balance` integer NOT NULL,
	`typed_at` text NOT NULL,
	`typed_by` text,
	PRIMARY KEY(`account_id`, `date`),
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`typed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `unconnected_assignments` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `unconnected_assignments_account_id` ON `unconnected_assignments` (`account_id`);