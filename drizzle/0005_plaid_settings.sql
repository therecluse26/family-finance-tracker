CREATE TABLE `plaid_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`client_id` text,
	`secret` text,
	`app_items` integer DEFAULT 0 NOT NULL,
	`outside_items` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "plaid_settings_one_row" CHECK("plaid_settings"."id" = 1)
);
