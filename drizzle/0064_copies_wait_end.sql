ALTER TABLE `connection_carry_overs` ADD `copies_wait_end_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connection_carry_overs` ADD `copies_wait_ended_at` text;