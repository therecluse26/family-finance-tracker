CREATE TABLE `shopping_plan_deals` (
	`plan_id` text NOT NULL,
	`place` integer NOT NULL,
	`store_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`packages` integer NOT NULL,
	`price` integer NOT NULL,
	`total` integer NOT NULL,
	`ends_on` text,
	`price_read_at` text NOT NULL,
	`used_at` text NOT NULL,
	`used_by` text,
	PRIMARY KEY(`plan_id`, `place`),
	FOREIGN KEY (`plan_id`) REFERENCES `shopping_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `deal_finder_stores`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `deal_finder_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "shopping_plan_deals_amounts" CHECK("shopping_plan_deals"."packages" >= 1 AND "shopping_plan_deals"."price" >= 1)
);
--> statement-breakpoint
CREATE INDEX `shopping_plan_deals_store` ON `shopping_plan_deals` (`store_id`);--> statement-breakpoint
CREATE INDEX `shopping_plan_deals_product` ON `shopping_plan_deals` (`product_id`);--> statement-breakpoint
CREATE INDEX `shopping_plan_deals_used_by` ON `shopping_plan_deals` (`used_by`);