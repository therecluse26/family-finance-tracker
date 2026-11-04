CREATE TABLE `ai_retries` (
	`use` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`retry_at` text NOT NULL,
	`asked_at` text
);
