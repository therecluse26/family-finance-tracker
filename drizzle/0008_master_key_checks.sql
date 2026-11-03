CREATE TABLE `master_key_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`member_id` text,
	`at` text NOT NULL,
	`matched` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null
);
