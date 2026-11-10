CREATE TABLE `item_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`product_key` text NOT NULL,
	`product_id` text,
	`clean_name` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`made_at` text NOT NULL,
	`made_by` text,
	FOREIGN KEY (`made_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_rules_product_key` ON `item_rules` (`product_key`);--> statement-breakpoint
CREATE INDEX `item_rules_product_id` ON `item_rules` (`product_id`);--> statement-breakpoint
CREATE INDEX `item_rules_clean_name` ON `item_rules` (`clean_name`);--> statement-breakpoint
CREATE TABLE `line_item_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`imported_at` text NOT NULL,
	`member_id` text,
	`rows_read` integer NOT NULL,
	`added` integer NOT NULL,
	`updated` integer NOT NULL,
	`unchanged` integer NOT NULL,
	`skipped` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `line_item_imports_imported_at` ON `line_item_imports` (`imported_at`);--> statement-breakpoint
CREATE TABLE `line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`key` text NOT NULL,
	`order_id` text NOT NULL,
	`order_date` text NOT NULL,
	`ship_date` text NOT NULL,
	`ship_time` text NOT NULL,
	`product_id` text,
	`name` text NOT NULL,
	`clean_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`unit_tax` integer NOT NULL,
	`shipping_charge` integer NOT NULL,
	`discounts` integer NOT NULL,
	`total` integer NOT NULL,
	`card_last4` text,
	`gift_card` integer DEFAULT false NOT NULL,
	`place` integer NOT NULL,
	`category` text,
	`category_source` text,
	`category_confidence` text,
	`category_needs_ai` integer DEFAULT false NOT NULL,
	`transaction_id` text,
	`link_kind` text,
	`added_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `line_items_key` ON `line_items` (`key`);--> statement-breakpoint
CREATE INDEX `line_items_transaction_id` ON `line_items` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `line_items_shipment` ON `line_items` (`order_id`,`ship_time`);--> statement-breakpoint
CREATE INDEX `line_items_ship_date` ON `line_items` (`ship_date`);--> statement-breakpoint
CREATE INDEX `line_items_product_id` ON `line_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `line_items_clean_name` ON `line_items` (`clean_name`);--> statement-breakpoint
CREATE TABLE `refused_line_item_links` (
	`order_id` text NOT NULL,
	`ship_time` text NOT NULL,
	`transaction_id` text NOT NULL,
	`member_id` text,
	`refused_at` text NOT NULL,
	PRIMARY KEY(`order_id`, `ship_time`, `transaction_id`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `refused_line_item_links_transaction_id` ON `refused_line_item_links` (`transaction_id`);