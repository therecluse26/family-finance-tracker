CREATE TABLE `shopping_list_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`answer_id` text NOT NULL,
	`items` text NOT NULL,
	`made_at` text NOT NULL,
	`made_by` text,
	`undone_at` text,
	`undone_by` text,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`made_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`undone_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shopping_list_changes_thread` ON `shopping_list_changes` (`thread_id`);--> statement-breakpoint
CREATE INDEX `shopping_list_changes_made_by` ON `shopping_list_changes` (`made_by`);--> statement-breakpoint
CREATE INDEX `shopping_list_changes_undone_by` ON `shopping_list_changes` (`undone_by`);