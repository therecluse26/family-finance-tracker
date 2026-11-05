CREATE TABLE `monthly_review_runs` (
	`month` text PRIMARY KEY NOT NULL,
	`due_at` text NOT NULL,
	`retry_at` text,
	`reply` text,
	`proposed_at` text,
	`ended_at` text,
	`outcome` text
);
