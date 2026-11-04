ALTER TABLE `transaction_parts` ADD `keeps_category` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transaction_parts` ADD `category_source` text;--> statement-breakpoint
ALTER TABLE `transaction_parts` ADD `category_confidence` text;--> statement-breakpoint
ALTER TABLE `transaction_parts` ADD `category_needs_ai` integer DEFAULT false NOT NULL;