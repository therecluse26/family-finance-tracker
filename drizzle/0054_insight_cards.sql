CREATE TABLE `insight_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`written_at` text NOT NULL,
	`month` text NOT NULL,
	`card_group` text NOT NULL,
	`about` text NOT NULL,
	`figure` real,
	`figure_kind` text NOT NULL,
	`figure_label` text NOT NULL,
	`title` text NOT NULL,
	`why` text NOT NULL,
	`next_step` text NOT NULL,
	`picture` text,
	`done_at` text,
	`done_by` text,
	FOREIGN KEY (`done_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_cards_position` ON `insight_cards` (`position`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `posted_seen_at` text;