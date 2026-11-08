-- Merchant search (spec 07, Transactions page): an FTS5 index of the Merchant name each row
-- shows, the clean name, else the provider's name, else the bank's line. Hand-written: drizzle-kit
-- cannot describe an FTS5 table (owner decision, 2026-11-07). transactions has a text key, and
-- VACUUM INTO may renumber its rowids, so each Transaction gets a fixed key here, and the index's
-- rowid is that key. Triggers keep both in step. A migration that rebuilds transactions drops its
-- triggers, and must create them again.
CREATE TABLE `transaction_search_keys` (
	`key` integer PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `transaction_search` USING fts5(
	name,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `transaction_search_keys` (`transaction_id`) SELECT `id` FROM `transactions`;
--> statement-breakpoint
INSERT INTO `transaction_search` (`rowid`, `name`)
	SELECT k.`key`, coalesce(t.`merchant_clean_name`, t.`merchant_name`, t.`description`)
	FROM `transactions` t JOIN `transaction_search_keys` k ON k.`transaction_id` = t.`id`;
--> statement-breakpoint
CREATE TRIGGER `transaction_search_insert` AFTER INSERT ON `transactions` BEGIN
	INSERT INTO `transaction_search_keys` (`transaction_id`) VALUES (new.`id`);
	INSERT INTO `transaction_search` (`rowid`, `name`) VALUES (
		(SELECT `key` FROM `transaction_search_keys` WHERE `transaction_id` = new.`id`),
		coalesce(new.`merchant_clean_name`, new.`merchant_name`, new.`description`)
	);
END;
--> statement-breakpoint
CREATE TRIGGER `transaction_search_update` AFTER UPDATE OF `merchant_clean_name`, `merchant_name`, `description` ON `transactions`
WHEN coalesce(old.`merchant_clean_name`, old.`merchant_name`, old.`description`)
	IS NOT coalesce(new.`merchant_clean_name`, new.`merchant_name`, new.`description`)
BEGIN
	UPDATE `transaction_search`
		SET `name` = coalesce(new.`merchant_clean_name`, new.`merchant_name`, new.`description`)
		WHERE `rowid` = (SELECT `key` FROM `transaction_search_keys` WHERE `transaction_id` = new.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `transaction_search_delete` AFTER DELETE ON `transactions` BEGIN
	DELETE FROM `transaction_search`
		WHERE `rowid` = (SELECT `key` FROM `transaction_search_keys` WHERE `transaction_id` = old.`id`);
	DELETE FROM `transaction_search_keys` WHERE `transaction_id` = old.`id`;
END;
