import {
  type Database,
  LINE_ITEM_FILE_FIELDS,
  type NewLineItem,
  readLineItemsByKey,
  storeLineItemImport,
  upsertLineItems,
} from "../db/index.ts";
import { householdTimeZone } from "../household/index.ts";
import type { Logger } from "../log.ts";
import {
  type OrderFileItem,
  type OrderFileLimits,
  readOrderFile,
  type SkipCount,
  type UploadKind,
} from "./amazon.ts";
import { lineItemsImported } from "./seams.ts";

// Importing an Amazon order file (spec 14, Importing the same orders again): every row is read and
// checked before any is stored, then the Line items are stored by import key in one transaction. A
// row with a stored key updates that Line item's file fields; its Category and link stay. A stored
// Line item the file lacks stays. The app keeps no copy of the file.

export type ImportCounts = {
  rowsRead: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: SkipCount[];
};

export type ImportOutcome =
  | { outcome: "imported"; counts: ImportCounts }
  | { outcome: "refused"; reason: string };

// Thrown when storing failed. It names no row: a database error can quote the values it was given.
export class LineItemStoreError extends Error {
  override name = "LineItemStoreError";
}

const sameFileFields = (stored: Record<string, unknown>, row: OrderFileItem) =>
  LINE_ITEM_FILE_FIELDS.every((field) => stored[field] === row[field]);

export async function importOrderFile(
  database: Database,
  upload: { bytes: Uint8Array; kind: UploadKind },
  options: { memberId: string; at: Date; logger: Logger; limits?: OrderFileLimits },
): Promise<ImportOutcome> {
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const file = readOrderFile(upload.bytes, upload.kind, {
    timeZone,
    now: options.at,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  if ("refused" in file) return { outcome: "refused", reason: file.refused };

  let stored: { counts: ImportCounts; changedTransactionIds: string[] };
  try {
    stored = await database.transaction(async (tx) => {
      const known = await readLineItemsByKey(
        tx,
        file.items.map((item) => item.key),
      );
      const writes: NewLineItem[] = [];
      const changedTransactionIds = new Set<string>();
      let added = 0;
      let updated = 0;
      for (const item of file.items) {
        const before = known.get(item.key);
        if (before !== undefined && sameFileFields(before, item)) continue;
        if (before === undefined) added += 1;
        else {
          updated += 1;
          if (before.transactionId !== null) changedTransactionIds.add(before.transactionId);
        }
        writes.push({ ...item, source: "amazon" });
      }
      await upsertLineItems(tx, writes, options.at);
      const counts: ImportCounts = {
        rowsRead: file.rowsRead,
        added,
        updated,
        unchanged: file.items.length - added - updated,
        skipped: file.skipped,
      };
      await storeLineItemImport(tx, {
        source: "amazon",
        importedAt: options.at,
        memberId: options.memberId,
        ...counts,
      });
      return { counts, changedTransactionIds: [...changedTransactionIds] };
    });
  } catch (error) {
    options.logger.error("The Amazon import could not store its Line items", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw new LineItemStoreError("The Amazon import could not store its Line items.");
  }
  await lineItemsImported(database, stored.changedTransactionIds, options.logger);
  return { outcome: "imported", counts: stored.counts };
}
