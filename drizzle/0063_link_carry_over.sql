CREATE TABLE `connection_carry_overs` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`old_connection_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`old_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
