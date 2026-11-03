CREATE TABLE `follow_up_marks` (
	`step` text NOT NULL,
	`transaction_id` text NOT NULL,
	`handled_at` text NOT NULL,
	PRIMARY KEY(`step`, `transaction_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follow_up_marks_transaction_id` ON `follow_up_marks` (`transaction_id`);