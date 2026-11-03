CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`bank_id` text NOT NULL,
	`bank_name` text NOT NULL,
	`health` text DEFAULT 'healthy' NOT NULL,
	`history_loaded` integer DEFAULT false NOT NULL,
	`sync_cursor` text,
	`sync_minute` integer NOT NULL,
	`credential` text,
	`origin` text NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connections_bank_id` ON `connections` (`bank_id`);--> statement-breakpoint
CREATE TABLE `household_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`provider_account_id` text,
	`name` text NOT NULL,
	`member_name` text,
	`kind` text NOT NULL,
	`subtype` text,
	`institution_id` text,
	`institution_name` text,
	`mask` text,
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
	`loan_type` text,
	`member_apr` real,
	`excluded` integer DEFAULT false NOT NULL,
	`closed_at` text,
	`raw` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_accounts_connection_provider_id` ON `household_accounts` (`connection_id`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`amount` integer NOT NULL,
	`posted_date` text NOT NULL,
	`authorized_date` text,
	`pending` integer NOT NULL,
	`pending_transaction_id` text,
	`description` text NOT NULL,
	`merchant_name` text,
	`merchant_id` text,
	`counterparties` text NOT NULL,
	`provider_category` text,
	`provider_category_confidence` text,
	`provider_category_version` text,
	`mcc` text,
	`raw` text NOT NULL,
	`hand_set` text NOT NULL,
	`hidden_reason` text,
	`hidden_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_connection_provider_id` ON `transactions` (`connection_id`,`provider_transaction_id`);--> statement-breakpoint
CREATE INDEX `transactions_account_posted_date` ON `transactions` (`account_id`,`posted_date`);