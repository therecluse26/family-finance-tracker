import { crc32, deflateRawSync } from "node:zlib";
import type { Database } from "../db/index.ts";
import { lineItems } from "../db/schema.ts";
import { cleanItemName } from "./amazon.ts";

// Test support: made-up Amazon order files in the form of Amazon's own export (spec 14, The order
// file), and ZIP files to hold them. Every name, order ID, and card number here is invented.

// The export's 29 columns, in its order. The parser reads them by name, never by place.
export const AMAZON_HEADER = [
  "ASIN",
  "Billing Address",
  "Carrier Name & Tracking Number",
  "Currency",
  "Department",
  "Gift Message",
  "Gift Recipient Contact",
  "Gift Sender Name",
  "Item Serial Number",
  "Order Date",
  "Order ID",
  "Order Status",
  "Original Quantity",
  "Payment Method Type",
  "Product Condition",
  "Product Name",
  "Purchase Order Number",
  "Ship Date",
  "Shipment Item Subtotal",
  "Shipment Item Subtotal Tax",
  "Shipment Status",
  "Shipping Address",
  "Shipping Charge",
  "Shipping Option",
  "Total Amount",
  "Total Discounts",
  "Unit Price",
  "Unit Price Tax",
  "Website",
] as const;

export type AmazonColumn = (typeof AMAZON_HEADER)[number];
export type AmazonRow = Record<AmazonColumn, string>;

// One shipped amazon.com row in US dollars: 2 × ($6.25 + $0.50 tax) = $13.50, on a made-up card.
export function amazonRow(fields: Partial<AmazonRow> = {}): AmazonRow {
  return {
    ASIN: "B000000001",
    "Billing Address": "1 Example Street, Exampletown",
    "Carrier Name & Tracking Number": "EXAMPLE(0000000000)",
    Currency: "USD",
    Department: "Not Available",
    "Gift Message": "Not Available",
    "Gift Recipient Contact": "Not Available",
    "Gift Sender Name": "Not Available",
    "Item Serial Number": "Not Available",
    "Order Date": "2026-05-01T14:03:22Z",
    "Order ID": "111-0000001-0000001",
    "Order Status": "Closed",
    "Original Quantity": "2",
    "Payment Method Type": "Visa - 0000",
    "Product Condition": "New",
    "Product Name": "Paper towels, 12 rolls",
    "Purchase Order Number": "Not Available",
    "Ship Date": "2026-05-02T09:15:00Z",
    "Shipment Item Subtotal": "12.5",
    "Shipment Item Subtotal Tax": "1",
    "Shipment Status": "Shipped",
    "Shipping Address": "1 Example Street, Exampletown",
    "Shipping Charge": "0",
    "Shipping Option": "standard",
    "Total Amount": "13.5",
    "Total Discounts": "0",
    "Unit Price": "6.25",
    "Unit Price Tax": "0.5",
    Website: "Amazon.com",
    ...fields,
  };
}

const csvCell = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

// The order file's text, as Amazon writes it: a byte order mark, the header, LF line ends, and
// quotes only where a cell needs them.
export function amazonCsv(rows: readonly AmazonRow[], header: readonly string[] = AMAZON_HEADER) {
  const lines = [
    header,
    ...rows.map((row) => header.map((column) => row[column as AmazonColumn] ?? "")),
  ];
  return `﻿${lines.map((cells) => cells.map(csvCell).join(",")).join("\n")}\n`;
}

export type ZipEntryFixture = {
  name: string | Uint8Array;
  content: string | Uint8Array;
  method?: "stored" | "deflate";
  // Header values that lie, for the refusal tests.
  size?: number;
  crc?: number;
  flags?: number;
};

const ORDER_FILE = "Your Amazon Orders/Order History.csv";

// A ZIP file as Amazon's export holds it: the order file, stored, among other entries.
export function amazonZip(rows: readonly AmazonRow[], others: readonly ZipEntryFixture[] = []) {
  return zipOf([
    { name: "Your Amazon Orders/Digital Content Orders.csv", content: "ASIN,Title\n" },
    { name: ORDER_FILE, content: amazonCsv(rows) },
    { name: "Your Amazon Orders/Delivery Photos/0001.jpeg", content: new Uint8Array(64) },
    ...others,
  ]);
}

// A ZIP file of these entries (PKWARE APPNOTE 6.3.10): each local header, its data, then the
// central directory and its end. Names are UTF-8.
export function zipOf(entries: readonly ZipEntryFixture[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? encoder.encode(entry.name) : entry.name;
    const content =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const deflate = entry.method === "deflate";
    const data = deflate ? new Uint8Array(deflateRawSync(content)) : content;
    const crc = entry.crc ?? crc32(content);
    const size = entry.size ?? content.byteLength;
    const flags = entry.flags ?? 0x0800;
    const method = deflate ? 8 : 0;
    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.byteLength + data.byteLength;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// One made-up Line item as app.db stores it, for tests that start after an import. `total` is in
// whole cents; the price fields follow from it.
export type TestLineItem = {
  id: string;
  name?: string;
  productId?: string | null;
  quantity?: number;
  total: number;
  orderId?: string;
  orderDate?: string;
  transactionId?: string | null;
  category?: string | null;
  categorySource?: "hand-set" | "Item rule" | "AI" | "Transaction" | null;
  categoryConfidence?: "certain" | "high" | "medium" | "low" | null;
  categoryNeedsAi?: boolean;
};

// Stores the Line items, 500 a statement. The clean name follows the name as the import makes it.
export async function addTestLineItems(
  database: Database,
  items: readonly TestLineItem[],
): Promise<void> {
  const at = new Date("2026-05-04T00:00:00.000Z");
  const rows = items.map((item) => {
    const name = item.name ?? `Test item ${item.id}`;
    const quantity = item.quantity ?? 1;
    const orderId = item.orderId ?? "111-0000001-0000001";
    return {
      id: item.id,
      source: "amazon" as const,
      key: JSON.stringify([orderId, item.productId ?? name, item.id]),
      orderId,
      orderDate: item.orderDate ?? "2026-05-01",
      shipDate: item.orderDate ?? "2026-05-02",
      shipTime: "2026-05-02T09:15:00Z",
      productId: item.productId === undefined ? `B${item.id.padStart(9, "0")}` : item.productId,
      name,
      cleanName: cleanItemName(name),
      quantity,
      unitPrice: Math.round(item.total / quantity),
      unitTax: 0,
      shippingCharge: 0,
      discounts: 0,
      total: item.total,
      cardLast4: null,
      place: 0,
      category: item.category ?? null,
      categorySource: item.categorySource ?? null,
      categoryConfidence: item.categoryConfidence ?? null,
      categoryNeedsAi: item.categoryNeedsAi ?? false,
      transactionId: item.transactionId ?? null,
      linkKind: item.transactionId == null ? null : ("app" as const),
      addedAt: at,
      updatedAt: at,
    };
  });
  for (let start = 0; start < rows.length; start += 500) {
    await database.insert(lineItems).values(rows.slice(start, start + 500));
  }
}
