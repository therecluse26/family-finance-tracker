CREATE TABLE `list_item_searches` (
	`list_item_id` text NOT NULL,
	`store_id` text NOT NULL,
	`searched_at` text NOT NULL,
	PRIMARY KEY(`list_item_id`, `store_id`),
	FOREIGN KEY (`list_item_id`) REFERENCES `shopping_list_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `deal_finder_stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_item_searches_store` ON `list_item_searches` (`store_id`);