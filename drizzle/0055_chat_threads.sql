CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author` text NOT NULL,
	`member_id` text,
	`member_name` text,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chat_messages_author" CHECK(("chat_messages"."author" = 'Member' AND "chat_messages"."member_name" IS NOT NULL) OR ("chat_messages"."author" = 'AI' AND "chat_messages"."member_id" IS NULL AND "chat_messages"."member_name" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread_id` ON `chat_messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`last_message_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_threads_last_message_at` ON `chat_threads` (`last_message_at`);