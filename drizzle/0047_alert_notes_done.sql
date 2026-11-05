CREATE TABLE `alert_notes_done` (
	`alert_id` text PRIMARY KEY NOT NULL,
	`member_id` text,
	`done_at` text NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
