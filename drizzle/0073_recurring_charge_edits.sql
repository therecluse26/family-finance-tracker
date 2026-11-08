CREATE TABLE `recurring_charge_price_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`charge_id` text NOT NULL,
	`from_date` text NOT NULL,
	`amount` integer NOT NULL,
	`by_hand` integer NOT NULL,
	FOREIGN KEY (`charge_id`) REFERENCES `recurring_charges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_charge_price_changes_one_a_day` ON `recurring_charge_price_changes` (`charge_id`,`by_hand`,`from_date`);--> statement-breakpoint
CREATE TABLE `recurring_charge_transactions` (
	`charge_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`by_hand` text,
	PRIMARY KEY(`charge_id`, `transaction_id`),
	FOREIGN KEY (`charge_id`) REFERENCES `recurring_charges`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recurring_charge_transactions_transaction_id` ON `recurring_charge_transactions` (`transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_charge_transactions_in_one` ON `recurring_charge_transactions` (`transaction_id`) WHERE "recurring_charge_transactions"."by_hand" IS NOT 'removed';--> statement-breakpoint
ALTER TABLE `recurring_charges` ADD `name` text;--> statement-breakpoint
ALTER TABLE `recurring_charges` ADD `hand_set_category` text;--> statement-breakpoint
ALTER TABLE `recurring_charges` ADD `price_band` integer;