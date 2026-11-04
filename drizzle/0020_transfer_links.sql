CREATE TABLE `refused_transfer_links` (
	`out_transaction_id` text NOT NULL,
	`in_transaction_id` text NOT NULL,
	`refused_by` text NOT NULL,
	`member_id` text,
	`refused_at` text NOT NULL,
	PRIMARY KEY(`out_transaction_id`, `in_transaction_id`),
	FOREIGN KEY (`out_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`in_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `refused_transfer_links_in_transaction_id` ON `refused_transfer_links` (`in_transaction_id`);--> statement-breakpoint
CREATE TABLE `transfer_links` (
	`id` text PRIMARY KEY NOT NULL,
	`out_transaction_id` text NOT NULL,
	`in_transaction_id` text NOT NULL,
	`tier` text NOT NULL,
	`signals` text NOT NULL,
	`ai_answer` text,
	`ai_confidence` text,
	`made_by` text NOT NULL,
	`member_id` text,
	`uncertain` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`out_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`in_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_links_out_transaction_id` ON `transfer_links` (`out_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_links_in_transaction_id` ON `transfer_links` (`in_transaction_id`);--> statement-breakpoint
CREATE INDEX `transactions_amount_posted_date` ON `transactions` (`amount`,`posted_date`);