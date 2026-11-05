CREATE TABLE `overspending_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`failed_tries` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "overspending_checks_one_row" CHECK("overspending_checks"."id" = 1)
);
