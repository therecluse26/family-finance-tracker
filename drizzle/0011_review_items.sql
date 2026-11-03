CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_ids` text NOT NULL,
	`decided` text NOT NULL,
	`best_answer` text NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text,
	`closed_reason` text,
	`answer` text,
	`answered_by` text,
	FOREIGN KEY (`answered_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_items_closed_at_created_at` ON `review_items` (`closed_at`,`created_at`);