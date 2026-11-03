ALTER TABLE `transactions` ADD `merchant_clean_name` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_needs_ai` integer DEFAULT false NOT NULL;