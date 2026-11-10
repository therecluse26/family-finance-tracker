import {
  countLineItems,
  countOpenReviewItemsOfKind,
  countShipments,
  type Database,
  deleteLineItemData,
  listLineItemsOf,
  readLastLineItemImport,
} from "../db/index.ts";
import { followUpAgain } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import {
  AMAZON_SHIPMENT_KIND,
  importOrderFile,
  lineItemsRemoved,
  type OrderFileLimits,
} from "../line-items/index.ts";
import type { Logger } from "../log.ts";
import {
  AMAZON_UPLOAD_TYPES,
  type AmazonRoutes,
  type AmazonStatusView,
  type AmazonUploadKind,
  MAX_AMAZON_UPLOAD_BYTES,
} from "./amazon-views.ts";

// Settings → Amazon (spec 14, The Amazon page in Settings): the last import and the link counts,
// the upload, and "Delete all Amazon data". One import or delete runs at a time.

// An unlinked shipment waits for a charge until this many days after its ship date.
const WAITING_DAYS = 60;
const DAY_MS = 86_400_000;

const daysBefore = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

// What an upload holds, by its Content-Type, or undefined for any other type.
export function amazonUploadKind(contentType: string | undefined): AmazonUploadKind | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return Object.hasOwn(AMAZON_UPLOAD_TYPES, type)
    ? AMAZON_UPLOAD_TYPES[type as keyof typeof AMAZON_UPLOAD_TYPES]
    : undefined;
}

// The request's body, or undefined once it is larger than the upload limit: by its Content-Length
// first, then by the bytes that really come. It stops reading at the limit.
export async function readAmazonUpload(
  request: Request,
  limit: number = MAX_AMAZON_UPLOAD_BYTES,
): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return undefined;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    pieces.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) {
    body.set(piece, at);
    at += piece.byteLength;
  }
  return body;
}

export function amazonRoutes(
  database: Database,
  logger: Logger,
  options: { limits?: OrderFileLimits } = {},
): AmazonRoutes {
  // True while an import or a delete runs. It is set in the same synchronous step as its check.
  let busy = false;

  async function status(): Promise<AmazonStatusView> {
    const zone = (await householdTimeZone(database)) ?? "UTC";
    const today = calendarDateIn(new Date(), zone);
    const [last, shipments, onReviewList, items] = await Promise.all([
      readLastLineItemImport(database, "amazon"),
      countShipments(database, "amazon", daysBefore(today, WAITING_DAYS - 1)),
      countOpenReviewItemsOfKind(database, AMAZON_SHIPMENT_KIND),
      countLineItems(database, "amazon"),
    ]);
    return {
      lastImport:
        last === undefined
          ? null
          : {
              importedAt: last.importedAt.toISOString(),
              memberName: last.memberName,
              rowsRead: last.rowsRead,
              added: last.added,
              updated: last.updated,
              unchanged: last.unchanged,
              skipped: last.skipped,
            },
      lineItems: items,
      shipments: { ...shipments, onReviewList },
    };
  }

  return {
    status,

    async importFile(kind, body, memberId) {
      if (busy) return { outcome: "busy" };
      busy = true;
      try {
        const bytes = await body();
        if (bytes === undefined) return { outcome: "too large" };
        const imported = await importOrderFile(
          database,
          { bytes, kind },
          {
            memberId,
            at: new Date(),
            logger,
            ...(options.limits === undefined ? {} : { limits: options.limits }),
          },
        );
        if (imported.outcome === "refused") return imported;
        const now = await status();
        if (now.lastImport === null) throw new Error("The import stored no record.");
        return { outcome: "imported", import: now.lastImport, status: now };
      } finally {
        busy = false;
      }
    },

    async deleteAll() {
      if (busy) return { outcome: "busy" };
      busy = true;
      try {
        // Each Transaction that had Line items goes back to the cascade: Matching makes its one
        // part again, and Categorization chooses its Category. Hand settings stay.
        const deleted = await deleteLineItemData(database, "amazon", (tx, ids) =>
          followUpAgain(tx, ids),
        );
        await lineItemsRemoved(database, deleted.transactionIds, logger);
        return { outcome: "deleted", status: await status() };
      } finally {
        busy = false;
      }
    },

    async lineItemsOf(transactionId) {
      return (await listLineItemsOf(database, transactionId)).map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        total: item.total,
        category: item.category,
        aiUnsure:
          item.categorySource === "AI" &&
          (item.categoryConfidence === "medium" || item.categoryConfidence === "low"),
        orderId: item.orderId,
        orderDate: item.orderDate,
        linkKind: item.linkKind,
      }));
    },
  };
}
