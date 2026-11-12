CREATE TABLE `deal_finder_price_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` text NOT NULL,
	`read_at` text NOT NULL,
	`regular_price` integer,
	`deal_price` integer,
	`deal_ends_on` text,
	`online_price` integer,
	FOREIGN KEY (`product_id`) REFERENCES `deal_finder_products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deal_finder_price_reads_prices" CHECK(coalesce("deal_finder_price_reads"."regular_price", "deal_finder_price_reads"."deal_price", "deal_finder_price_reads"."online_price") IS NOT NULL AND coalesce("deal_finder_price_reads"."regular_price", 1) BETWEEN 1 AND 999999 AND coalesce("deal_finder_price_reads"."deal_price", 1) BETWEEN 1 AND 999999 AND coalesce("deal_finder_price_reads"."online_price", 1) BETWEEN 1 AND 999999)
);
--> statement-breakpoint
CREATE INDEX `deal_finder_price_reads_product` ON `deal_finder_price_reads` (`product_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `deal_finder_price_reads_read_at` ON `deal_finder_price_reads` (`read_at`);--> statement-breakpoint
CREATE TABLE `deal_finder_products` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`read_key` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`size` text,
	`upc` text,
	`link` text,
	`added_at` text NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `deal_finder_stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_finder_products_store_read_key` ON `deal_finder_products` (`store_id`,`read_key`);--> statement-breakpoint
CREATE TABLE `deal_finder_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`apify_token` text,
	`apify_token_last4` text,
	`apify_check` text,
	`apify_checked_at` text,
	`kroger_client_id` text,
	`kroger_client_id_last4` text,
	`kroger_client_secret` text,
	`kroger_client_secret_last4` text,
	`kroger_check` text,
	`kroger_checked_at` text,
	`open_food_facts` integer DEFAULT false NOT NULL,
	`use_zip` integer DEFAULT false NOT NULL,
	`find_distance_miles` integer DEFAULT 25 NOT NULL,
	`stores_found_zip` text,
	`stores_found_at` text,
	`cost_cap` integer DEFAULT 500 NOT NULL,
	`trip_saving` integer DEFAULT 1000 NOT NULL,
	`dietary_needs` text DEFAULT '' NOT NULL,
	CONSTRAINT "deal_finder_settings_one_row" CHECK("deal_finder_settings"."id" = 1),
	CONSTRAINT "deal_finder_settings_distance" CHECK("deal_finder_settings"."find_distance_miles" IN (10, 25, 50)),
	CONSTRAINT "deal_finder_settings_cost_cap" CHECK("deal_finder_settings"."cost_cap" >= 0),
	CONSTRAINT "deal_finder_settings_trip_saving" CHECK("deal_finder_settings"."trip_saving" >= 0)
);
--> statement-breakpoint
CREATE TABLE `deal_finder_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`reader` text NOT NULL,
	`on` integer DEFAULT false NOT NULL,
	`nearby` integer DEFAULT true NOT NULL,
	`locations` text NOT NULL,
	`home_store_id` text,
	`home_store_name` text,
	`distance_miles` real,
	`delivery_fee` integer,
	`free_delivery_from` integer,
	`last_good_read_at` text,
	`found_at` text NOT NULL,
	CONSTRAINT "deal_finder_stores_delivery_fee" CHECK("deal_finder_stores"."delivery_fee" >= 0),
	CONSTRAINT "deal_finder_stores_free_delivery_from" CHECK("deal_finder_stores"."free_delivery_from" >= 0)
);
--> statement-breakpoint
CREATE TABLE `member_match_choices` (
	`words` text NOT NULL,
	`product_id` text NOT NULL,
	`choice` text NOT NULL,
	`member_id` text,
	`at` text NOT NULL,
	PRIMARY KEY(`words`, `product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `deal_finder_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `member_match_choices_product` ON `member_match_choices` (`product_id`);--> statement-breakpoint
CREATE INDEX `member_match_choices_member` ON `member_match_choices` (`member_id`);--> statement-breakpoint
CREATE TABLE `price_source_costs` (
	`month` text PRIMARY KEY NOT NULL,
	`cost_nanos` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_matches` (
	`list_item_id` text NOT NULL,
	`product_id` text NOT NULL,
	`store_id` text NOT NULL,
	`answer` text NOT NULL,
	`reason` text,
	`read_key` text NOT NULL,
	`last_full_search_at` text NOT NULL,
	`matched_at` text NOT NULL,
	PRIMARY KEY(`list_item_id`, `product_id`),
	FOREIGN KEY (`list_item_id`) REFERENCES `shopping_list_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `deal_finder_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `deal_finder_stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_matches_product` ON `product_matches` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_matches_store` ON `product_matches` (`store_id`,`list_item_id`);--> statement-breakpoint
CREATE TABLE `shopping_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`words` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`brand_lock` text,
	`note` text,
	`search_words` text,
	`ticked` integer DEFAULT false NOT NULL,
	`place` integer NOT NULL,
	`added_at` text NOT NULL,
	`added_by` text,
	FOREIGN KEY (`added_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "shopping_list_items_quantity" CHECK("shopping_list_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `shopping_list_items_added_by` ON `shopping_list_items` (`added_by`);--> statement-breakpoint
CREATE TABLE `shopping_plan_lines` (
	`plan_id` text NOT NULL,
	`place` integer NOT NULL,
	`list_item_id` text,
	`words` text NOT NULL,
	`store_id` text,
	`product_id` text,
	`product_name` text,
	`packages` integer,
	`price` integer,
	`total` integer,
	`price_kind` text,
	`price_read_at` text,
	PRIMARY KEY(`plan_id`, `place`),
	FOREIGN KEY (`plan_id`) REFERENCES `shopping_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_item_id`) REFERENCES `shopping_list_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`store_id`) REFERENCES `deal_finder_stores`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `deal_finder_products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_plan_lines_list_item` ON `shopping_plan_lines` (`list_item_id`);--> statement-breakpoint
CREATE INDEX `shopping_plan_lines_store` ON `shopping_plan_lines` (`store_id`);--> statement-breakpoint
CREATE INDEX `shopping_plan_lines_product` ON `shopping_plan_lines` (`product_id`);--> statement-breakpoint
CREATE TABLE `shopping_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`started_by` text,
	`state` text NOT NULL,
	`finished_at` text,
	`trip_saving` integer NOT NULL,
	`total` integer,
	`trips` integer,
	`saving` integer,
	`store_failures` text NOT NULL,
	FOREIGN KEY (`started_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_plans_started_at` ON `shopping_plans` (`started_at`);--> statement-breakpoint
CREATE INDEX `shopping_plans_started_by` ON `shopping_plans` (`started_by`);