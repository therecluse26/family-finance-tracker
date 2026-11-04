CREATE TABLE `follow_up_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follow_up_changes_transaction_id` ON `follow_up_changes` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `loan_links` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`loan_account_id` text NOT NULL,
	`tier` text NOT NULL,
	`signals` text NOT NULL,
	`ai_answer` text,
	`ai_confidence` text,
	`made_by` text NOT NULL,
	`member_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`loan_account_id`) REFERENCES `household_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loan_links_transaction_id` ON `loan_links` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `loan_links_loan_account_id` ON `loan_links` (`loan_account_id`);--> statement-breakpoint
CREATE TABLE `refused_links` (
	`kind` text NOT NULL,
	`transaction_id` text NOT NULL,
	`other_id` text NOT NULL,
	`refused_by` text NOT NULL,
	`member_id` text,
	`refused_at` text NOT NULL,
	PRIMARY KEY(`kind`, `transaction_id`, `other_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `spending_links` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`transaction_id` text NOT NULL,
	`spending_transaction_id` text NOT NULL,
	`tier` text NOT NULL,
	`signals` text NOT NULL,
	`ai_answer` text,
	`ai_confidence` text,
	`made_by` text NOT NULL,
	`member_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spending_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spending_links_transaction_id` ON `spending_links` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `spending_links_spending_transaction_id` ON `spending_links` (`spending_transaction_id`);