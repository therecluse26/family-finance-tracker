CREATE TABLE `recurring_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text,
	`merchant_name` text NOT NULL,
	`category` text,
	`schedule` text NOT NULL,
	`next_expected_date` text NOT NULL,
	`latest_amount` integer NOT NULL,
	`price_history` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`found_at` text NOT NULL,
	`ended_at` text,
	`ended_by` text,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ended_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
