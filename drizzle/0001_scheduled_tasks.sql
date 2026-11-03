CREATE TABLE `scheduled_tasks` (
	`name` text PRIMARY KEY NOT NULL,
	`last_run_at` text,
	`next_run_at` text NOT NULL,
	`time_zone` text NOT NULL
);
