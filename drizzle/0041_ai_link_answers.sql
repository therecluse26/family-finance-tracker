CREATE TABLE `ai_link_answers` (
	`kind` text NOT NULL,
	`transaction_id` text NOT NULL,
	`other_id` text NOT NULL,
	`answer` text NOT NULL,
	`confidence` text NOT NULL,
	`spending_transaction_id` text,
	`asked_at` text NOT NULL,
	PRIMARY KEY(`kind`, `transaction_id`, `other_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spending_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_link_answers_transaction_id` ON `ai_link_answers` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `ai_link_answers_spending_transaction_id` ON `ai_link_answers` (`spending_transaction_id`);