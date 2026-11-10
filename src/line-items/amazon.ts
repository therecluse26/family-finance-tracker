import { calendarDateIn } from "../format.ts";
import { type CsvFile, type CsvRefusal, MAX_CSV_ROWS, readCsv } from "./csv.ts";
import { baseName, readZipEntry, ZIP_LIMITS, type ZipLimits } from "./zip.ts";

// Amazon's retail order history file (spec 14, The order file): the file's rows, read into Line
// items. Columns are read by header name, never by place. A refused file or a skipped row is named
// by its row number and column only: no row's content goes into a refusal, a skip reason, or a log
// line.

export const ORDER_FILE_NAME = "Order History.csv";

// The columns the app reads. Every other column, such as the addresses, gift messages, carrier and
// tracking number, and serial number, is never read.
const COLUMNS = {
  website: "Website",
  orderId: "Order ID",
  orderDate: "Order Date",
  shipDate: "Ship Date",
  orderStatus: "Order Status",
  currency: "Currency",
  productId: "ASIN",
  name: "Product Name",
  quantity: "Original Quantity",
  unitPrice: "Unit Price",
  unitTax: "Unit Price Tax",
  shippingCharge: "Shipping Charge",
  discounts: "Total Discounts",
  total: "Total Amount",
  paymentMethod: "Payment Method Type",
} as const;

type Column = keyof typeof COLUMNS;

// `Not Available` stands for an empty value in every column.
const NOT_AVAILABLE = "Not Available";

// One Line item as the file gives it, before it is stored.
export type OrderFileItem = {
  key: string;
  orderId: string;
  orderDate: string;
  shipDate: string;
  shipTime: string;
  productId: string | null;
  name: string;
  cleanName: string;
  quantity: number;
  unitPrice: number;
  unitTax: number;
  shippingCharge: number;
  discounts: number;
  total: number;
  cardLast4: string | null;
  giftCard: boolean;
  place: number;
};

// How many rows were skipped for one reason, and the first one's row number.
export type SkipCount = { reason: string; rows: number; firstRow: number };

export type OrderFile = {
  // The file's data rows, skipped ones included.
  rowsRead: number;
  items: OrderFileItem[];
  skipped: SkipCount[];
};

export type OrderFileRefusal = { refused: string };

export type OrderFileLimits = { zip: ZipLimits; rows: number };

export const ORDER_FILE_LIMITS: OrderFileLimits = { zip: ZIP_LIMITS, rows: MAX_CSV_ROWS };

// The skip reasons that name no column.
export const SKIP_REASONS = {
  website: "not an amazon.com order",
  currency: "not in US dollars",
  cancelled: "cancelled",
  notShipped: "not shipped yet",
  total: "amounts do not add up",
  broken: "the row could not be read",
  fieldCount: "wrong number of fields",
} as const;

// The skip reason for a value the parser cannot read, which names its column.
export const badValue = (column: string) => `bad ${column}`;

const ORDER_ID = /^[A-Z0-9]{3}-\d{7}-\d{7}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const QUANTITY = /^[1-9]\d{0,5}$/;
const MAX_NAME_LENGTH = 2000;
// An amount in dollars: digits with optional thousands commas, and at most 2 decimals.
const AMOUNT = /^(-?)(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/;
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
// A time this far after the upload is not a real ship or order time.
const FUTURE_MS = 86_400_000;

// The digits of a string as a whole number, read digit by digit, never through floating point.
function digitsValue(digits: string): number {
  let value = 0;
  for (let i = 0; i < digits.length; i++) value = value * 10 + (digits.charCodeAt(i) - 48);
  return value;
}

// An amount in whole cents, from "12.5", "7", "1,234.56", or "'-3.20'". Undefined for any other
// form.
export function centsOf(text: string): number | undefined {
  const value =
    text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
  const match = AMOUNT.exec(value);
  if (match === null) return undefined;
  const [, minus = "", whole = "", fraction = ""] = match;
  const cents = digitsValue(whole.replaceAll(",", "")) * 100 + digitsValue(fraction.padEnd(2, "0"));
  return minus === "-" && cents !== 0 ? -cents : cents;
}

// The moment and its UTC time to the second, from an ISO 8601 time in UTC. Undefined for any other
// form, an impossible date such as February 30, or a time in the future.
export function utcTimeOf(text: string, now: Date): { moment: Date; shipTime: string } | undefined {
  const match = UTC_TIME.exec(text);
  if (match === null) return undefined;
  const [, year = "", month = "", day = "", hour = "", minute = "", second = ""] = match;
  const parts = [year, month, day, hour, minute, second].map(digitsValue);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = parts;
  const moment = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    moment.getUTCFullYear() !== y ||
    moment.getUTCMonth() !== mo - 1 ||
    moment.getUTCDate() !== d ||
    moment.getUTCHours() !== h ||
    moment.getUTCMinutes() !== mi ||
    moment.getUTCSeconds() !== s
  ) {
    return undefined;
  }
  if (moment.getTime() > now.getTime() + FUTURE_MS) return undefined;
  return { moment, shipTime: `${year}-${month}-${day}T${hour}:${minute}:${second}Z` };
}

// The name as Item rules match it with no product ID (spec 14, Item rules): lower case, with
// punctuation removed and runs of spaces joined into one.
export function cleanItemName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// The card's last 4 digits, when the payment method names a card, such as "Visa - 1234". Only the
// digits are kept; the card's name never is.
export function cardLast4Of(paymentMethod: string): string | null {
  const match = / - (\d{4})(?!\d)/.exec(paymentMethod);
  return match?.[1] ?? null;
}

export const paidByGiftCard = (paymentMethod: string) =>
  paymentMethod.toLowerCase().includes("gift certificate/card");

// The data rows of the order file, read into Line items in the Household time zone, with each skip
// count. Refused when the header lacks a needed column, which the refusal names.
export function readOrderRows(
  file: CsvFile,
  options: { timeZone: string; now: Date },
): OrderFile | OrderFileRefusal {
  const at = {} as Record<Column, number>;
  for (const [field, column] of Object.entries(COLUMNS) as [Column, string][]) {
    const index = file.header.indexOf(column);
    if (index === -1) return { refused: `The file has no "${column}" column.` };
    at[field] = index;
  }
  const skipped = new Map<string, SkipCount>();
  const skip = (reason: string, row: number) => {
    const count = skipped.get(reason);
    if (count === undefined) skipped.set(reason, { reason, rows: 1, firstRow: row });
    else count.rows += 1;
  };
  for (const row of file.brokenRows) skip(SKIP_REASONS.broken, row);
  for (const row of file.wrongFieldCounts) skip(SKIP_REASONS.fieldCount, row);

  const items: OrderFileItem[] = [];
  const places = new Map<string, number>();
  for (const { row, fields } of file.records) {
    const value = (column: Column) => fields[at[column]] ?? "";
    if (value("website") !== "Amazon.com") {
      skip(SKIP_REASONS.website, row);
      continue;
    }
    if (value("currency") !== "USD") {
      skip(SKIP_REASONS.currency, row);
      continue;
    }
    if (value("orderStatus") === "Cancelled") {
      skip(SKIP_REASONS.cancelled, row);
      continue;
    }
    if (value("shipDate") === NOT_AVAILABLE) {
      skip(SKIP_REASONS.notShipped, row);
      continue;
    }
    const item = readItem(value, options);
    if (typeof item === "string") {
      skip(item, row);
      continue;
    }
    // The row's place among identical rows of its order: same product, same ship time.
    const identical = JSON.stringify([item.orderId, item.productId ?? item.name, item.shipTime]);
    const place = places.get(identical) ?? 0;
    places.set(identical, place + 1);
    items.push({
      ...item,
      place,
      key: JSON.stringify([
        item.orderId,
        item.productId ?? `name:${item.name}`,
        item.shipTime,
        place,
      ]),
    });
  }
  return {
    rowsRead: file.records.length + file.brokenRows.length + file.wrongFieldCounts.length,
    items,
    skipped: [...skipped.values()].sort((a, b) => a.firstRow - b.firstRow),
  };
}

// One shipped amazon.com row in US dollars, or the reason it is skipped.
function readItem(
  value: (column: Column) => string,
  options: { timeZone: string; now: Date },
): Omit<OrderFileItem, "key" | "place"> | string {
  const orderId = value("orderId");
  if (!ORDER_ID.test(orderId)) return badValue(COLUMNS.orderId);
  const ordered = utcTimeOf(value("orderDate"), options.now);
  if (ordered === undefined) return badValue(COLUMNS.orderDate);
  const shipped = utcTimeOf(value("shipDate"), options.now);
  if (shipped === undefined) return badValue(COLUMNS.shipDate);
  const asin = value("productId");
  if (asin !== NOT_AVAILABLE && !ASIN.test(asin)) return badValue(COLUMNS.productId);
  const name = value("name");
  if (name.trim() === "" || name === NOT_AVAILABLE || name.length > MAX_NAME_LENGTH) {
    return badValue(COLUMNS.name);
  }
  const cleanName = cleanItemName(name);
  const quantityText = value("quantity");
  if (!QUANTITY.test(quantityText)) return badValue(COLUMNS.quantity);
  const quantity = digitsValue(quantityText);
  const unitPrice = centsOf(value("unitPrice"));
  if (unitPrice === undefined) return badValue(COLUMNS.unitPrice);
  const unitTax = optionalCents(value("unitTax"));
  if (unitTax === undefined) return badValue(COLUMNS.unitTax);
  const shippingCharge = optionalCents(value("shippingCharge"));
  if (shippingCharge === undefined) return badValue(COLUMNS.shippingCharge);
  const discounts = optionalCents(value("discounts"));
  if (discounts === undefined) return badValue(COLUMNS.discounts);
  const total = centsOf(value("total"));
  if (total === undefined) return badValue(COLUMNS.total);
  if (total !== quantity * (unitPrice + unitTax) + shippingCharge + discounts) {
    return SKIP_REASONS.total;
  }
  const paymentMethod = value("paymentMethod");
  return {
    orderId,
    orderDate: calendarDateIn(ordered.moment, options.timeZone),
    shipDate: calendarDateIn(shipped.moment, options.timeZone),
    shipTime: shipped.shipTime,
    productId: asin === NOT_AVAILABLE ? null : asin,
    name,
    cleanName: cleanName === "" ? name : cleanName,
    quantity,
    unitPrice,
    unitTax,
    shippingCharge,
    discounts,
    total,
    cardLast4: cardLast4Of(paymentMethod),
    giftCard: paidByGiftCard(paymentMethod),
  };
}

// Tax, shipping, and discounts: `Not Available` is 0.
const optionalCents = (text: string) => (text === NOT_AVAILABLE ? 0 : centsOf(text));

// What an upload holds: Amazon's ZIP file, or the order file inside it.
export type UploadKind = "zip" | "csv";

// The order file's rows from an upload, or why it was refused. A ZIP file is read entry by entry,
// and only its order file is opened.
export function readOrderFile(
  bytes: Uint8Array,
  kind: UploadKind,
  options: { timeZone: string; now: Date; limits?: OrderFileLimits },
): OrderFile | OrderFileRefusal {
  const limits = options.limits ?? ORDER_FILE_LIMITS;
  let csvBytes = bytes;
  if (kind === "zip") {
    const entry = readZipEntry(
      bytes,
      (name) => baseName(name) === ORDER_FILE_NAME,
      `The ZIP file holds no ${ORDER_FILE_NAME}. Upload the ZIP file from Amazon, as it is.`,
      limits.zip,
    );
    if ("refused" in entry) return entry;
    csvBytes = entry.content;
  } else if (csvBytes.byteLength > limits.zip.unpackedBytes) {
    return { refused: "The file is too large." };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(csvBytes);
  } catch {
    return { refused: "The file is not UTF-8 text." };
  }
  const csv: CsvFile | CsvRefusal = readCsv(text, limits.rows);
  if ("refused" in csv) return csv;
  return readOrderRows(csv, options);
}
