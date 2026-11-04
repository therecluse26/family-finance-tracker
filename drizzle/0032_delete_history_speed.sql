PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_follow_up_marks` (
	`step` text NOT NULL,
	`transaction_id` text NOT NULL,
	`handled_at` text NOT NULL,
	PRIMARY KEY(`transaction_id`, `step`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_follow_up_marks`("step", "transaction_id", "handled_at") SELECT "step", "transaction_id", "handled_at" FROM `follow_up_marks`;--> statement-breakpoint
DROP TABLE `follow_up_marks`;--> statement-breakpoint
ALTER TABLE `__new_follow_up_marks` RENAME TO `follow_up_marks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refused_links_transaction_id` ON `refused_links` (`transaction_id`);