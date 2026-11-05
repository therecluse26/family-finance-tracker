CREATE TABLE `monthly_reviews` (
	`month` text PRIMARY KEY NOT NULL,
	`written_at` text NOT NULL,
	`review` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_links_done` (
	`month` text PRIMARY KEY NOT NULL,
	`member_id` text,
	`done_at` text NOT NULL,
	FOREIGN KEY (`month`) REFERENCES `monthly_reviews`(`month`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `review_plan_ticks` (
	`month` text NOT NULL,
	`item` integer NOT NULL,
	`member_id` text,
	`ticked_at` text NOT NULL,
	PRIMARY KEY(`month`, `item`),
	FOREIGN KEY (`month`) REFERENCES `monthly_reviews`(`month`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "review_plan_ticks_item" CHECK("review_plan_ticks"."item" BETWEEN 0 AND 2)
);
