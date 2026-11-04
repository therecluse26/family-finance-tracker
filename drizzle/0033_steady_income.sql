CREATE TABLE `income_series` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text,
	`merchant_name` text NOT NULL,
	`schedule` text NOT NULL,
	`fixed_days` text,
	`next_expected_date` text NOT NULL,
	`latest_amount` integer NOT NULL,
	`history` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `typed_steady_income` (
	`id` integer PRIMARY KEY NOT NULL,
	`amount` integer NOT NULL,
	`typed_at` text NOT NULL,
	`typed_by` text,
	FOREIGN KEY (`typed_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "typed_steady_income_one_row" CHECK("typed_steady_income"."id" = 1)
);
