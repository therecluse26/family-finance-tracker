CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text,
	`merchant_name` text NOT NULL,
	`merchant_key` text NOT NULL,
	`category` text NOT NULL,
	`made_at` text NOT NULL,
	`made_by` text,
	FOREIGN KEY (`made_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `category_rules_merchant_id` ON `category_rules` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `category_rules_merchant_key` ON `category_rules` (`merchant_key`);