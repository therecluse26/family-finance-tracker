CREATE TABLE `daily_balances` (
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`current_balance` integer,
	`available_balance` integer,
	`credit_limit` integer,
	`card_aprs` text,
	`statement_balance` integer,
	`minimum_payment` integer,
	`payment_due_date` text,
	`loan_apr` real,
	`loan_principal` integer,
	`interest_paid_this_year` integer,
	`synced_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `date`),
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
