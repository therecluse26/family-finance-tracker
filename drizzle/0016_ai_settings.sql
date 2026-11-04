CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text,
	`api_key` text,
	`base_url` text,
	`gateway_token` text,
	`quick_model` text,
	`writer_model` text,
	`key_rejected_at` text,
	`generation` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_settings_one_row" CHECK("ai_settings"."id" = 1),
	CONSTRAINT "ai_settings_whole" CHECK(("ai_settings"."provider" IS NULL) = ("ai_settings"."quick_model" IS NULL) AND ("ai_settings"."provider" IS NULL) = ("ai_settings"."writer_model" IS NULL))
);
