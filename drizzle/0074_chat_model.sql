PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text,
	`api_key` text,
	`base_url` text,
	`gateway_token` text,
	`quick_model` text,
	`writer_model` text,
	`chat_model` text,
	`key_rejected_at` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`web_lookup` integer DEFAULT true NOT NULL,
	`web_search_refused` text,
	CONSTRAINT "ai_settings_one_row" CHECK("__new_ai_settings"."id" = 1),
	CONSTRAINT "ai_settings_whole" CHECK(("__new_ai_settings"."provider" IS NULL) = ("__new_ai_settings"."quick_model" IS NULL) AND ("__new_ai_settings"."provider" IS NULL) = ("__new_ai_settings"."writer_model" IS NULL) AND ("__new_ai_settings"."provider" IS NULL) = ("__new_ai_settings"."chat_model" IS NULL))
);
--> statement-breakpoint
-- Edited by hand after drizzle-kit generate: chat_model starts as each row's writer_model.
INSERT INTO `__new_ai_settings`("id", "provider", "api_key", "base_url", "gateway_token", "quick_model", "writer_model", "chat_model", "key_rejected_at", "generation", "web_lookup", "web_search_refused") SELECT "id", "provider", "api_key", "base_url", "gateway_token", "quick_model", "writer_model", "writer_model", "key_rejected_at", "generation", "web_lookup", "web_search_refused" FROM `ai_settings`;--> statement-breakpoint
DROP TABLE `ai_settings`;--> statement-breakpoint
ALTER TABLE `__new_ai_settings` RENAME TO `ai_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;