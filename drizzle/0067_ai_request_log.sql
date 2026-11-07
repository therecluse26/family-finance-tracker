CREATE TABLE `ai_request_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`ai_call_id` integer,
	`chat_thread_id` text,
	`use` text NOT NULL,
	`model` text NOT NULL,
	`request` text NOT NULL,
	`request_cut` integer NOT NULL,
	`response` text NOT NULL,
	`response_cut` integer NOT NULL,
	`failure` text,
	`failure_status` integer,
	FOREIGN KEY (`ai_call_id`) REFERENCES `ai_calls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_request_log_at` ON `ai_request_log` (`at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_request_log_ai_call_id` ON `ai_request_log` (`ai_call_id`);--> statement-breakpoint
CREATE INDEX `ai_request_log_chat_thread_id` ON `ai_request_log` (`chat_thread_id`);--> statement-breakpoint
CREATE TABLE `ai_request_log_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`on` integer NOT NULL,
	`keep_days` integer NOT NULL,
	`cleanup_failures` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_request_log_settings_one_row" CHECK("ai_request_log_settings"."id" = 1),
	CONSTRAINT "ai_request_log_settings_keep_days" CHECK("ai_request_log_settings"."keep_days" IN (7, 30, 90))
);
