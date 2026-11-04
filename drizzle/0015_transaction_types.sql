CREATE TABLE `transaction_decisions` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`provisional_until` text,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transaction_decisions_provisional_until` ON `transaction_decisions` (`provisional_until`);--> statement-breakpoint
CREATE TABLE `transaction_parts` (
	`transaction_id` text NOT NULL,
	`part` integer NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`category` text,
	PRIMARY KEY(`transaction_id`, `part`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transaction_decisions`(`transaction_id`) ON UPDATE no action ON DELETE cascade
);
