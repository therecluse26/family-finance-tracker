CREATE TABLE `update_check` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`checked_at` text,
	`latest_version` text,
	`latest_tag` text,
	`last_failure` text,
	CONSTRAINT "update_check_one_row" CHECK("update_check"."id" = 1)
);
