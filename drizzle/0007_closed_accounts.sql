ALTER TABLE `household_accounts` ADD `closed_reason` text;--> statement-breakpoint
ALTER TABLE `household_accounts` ADD `provider_missing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `household_accounts` ADD `history_split_date` text;