CREATE TABLE `merchant_lookup_months` (
	`month` text PRIMARY KEY NOT NULL,
	`lookups` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `merchant_lookups` (
	`merchant_key` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`category` text,
	`confidence` text,
	`description` text,
	`looked_up_at` text NOT NULL,
	CONSTRAINT "merchant_lookups_found" CHECK(("merchant_lookups"."outcome" = 'found') = ("merchant_lookups"."category" IS NOT NULL AND "merchant_lookups"."confidence" IS NOT NULL AND "merchant_lookups"."description" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `web_lookup` integer DEFAULT true NOT NULL;