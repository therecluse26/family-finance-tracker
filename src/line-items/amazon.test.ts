import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  badValue,
  cardLast4Of,
  centsOf,
  cleanItemName,
  ORDER_FILE_LIMITS,
  type OrderFile,
  type OrderFileLimits,
  readOrderFile,
  SKIP_REASONS,
  utcTimeOf,
} from "./amazon.ts";
import { readCsv } from "./csv.ts";
import {
  AMAZON_HEADER,
  type AmazonRow,
  amazonCsv,
  amazonRow,
  amazonZip,
  zipOf,
} from "./testing.ts";
import { entryNameProblem, readZipEntry } from "./zip.ts";

// Reading Amazon's order file (spec 14, Reading the file; The order file), on made-up rows and
// ZIP files in the export's form.

const NOW = new Date("2026-11-09T12:00:00Z");
const ZONE = "America/New_York";
const encode = (text: string) => new TextEncoder().encode(text);

function read(bytes: Uint8Array, kind: "zip" | "csv" = "zip", limits?: OrderFileLimits): OrderFile {
  const file = readOrderFile(bytes, kind, {
    timeZone: ZONE,
    now: NOW,
    ...(limits === undefined ? {} : { limits }),
  });
  if ("refused" in file) throw new Error(`Refused: ${file.refused}`);
  return file;
}

function refusal(bytes: Uint8Array, kind: "zip" | "csv" = "zip", limits?: OrderFileLimits) {
  const file = readOrderFile(bytes, kind, {
    timeZone: ZONE,
    now: NOW,
    ...(limits === undefined ? {} : { limits }),
  });
  if (!("refused" in file)) throw new Error("The file was read.");
  return file.refused;
}

const readRows = (rows: AmazonRow[]) => read(encode(amazonCsv(rows)), "csv");

describe("the ZIP reader", () => {
  it("finds Order History.csv by its last path part among the export's other entries, stored or deflated", () => {
    const stored = read(amazonZip([amazonRow()]));
    expect(stored.items).toHaveLength(1);

    const deflated = zipOf([
      { name: "Retail/Order History.csv", content: amazonCsv([amazonRow()]), method: "deflate" },
    ]);
    expect(read(deflated).items).toHaveLength(1);
  });

  it("opens no other entry: a damaged photo beside the order file does not matter", () => {
    const zip = amazonZip(
      [amazonRow()],
      [{ name: "Photos/broken.jpeg", content: new Uint8Array(10), crc: 1, method: "deflate" }],
    );
    expect(read(zip).items).toHaveLength(1);
  });

  it("refuses an entry that lies about its size and unpacks past the limit, while it inflates (a ZIP bomb)", () => {
    const limits: OrderFileLimits = {
      ...ORDER_FILE_LIMITS,
      zip: { entries: 500, unpackedBytes: 1024 * 1024 },
    };
    const bomb = zipOf([
      {
        name: "Your Amazon Orders/Order History.csv",
        content: new Uint8Array(5_000_000),
        method: "deflate",
        size: 100,
      },
    ]);
    expect(bomb.byteLength).toBeLessThan(10_000);
    expect(refusal(bomb, "zip", limits)).toBe("Order History.csv unpacks to more than 1 MB.");
  });

  it("refuses an archive whose headers add up to more than 200 MB", () => {
    const zip = amazonZip(
      [amazonRow()],
      [{ name: "big.bin", content: "x", size: 210 * 1024 * 1024 }],
    );
    expect(refusal(zip)).toBe("The ZIP file unpacks to more than 200 MB.");
  });

  it("refuses an entry whose real size or CRC-32 differs from its header", () => {
    const csv = amazonCsv([amazonRow()]);
    const wrongSize = zipOf([{ name: "Order History.csv", content: csv, size: 3 }]);
    expect(refusal(wrongSize)).toBe("Order History.csv is damaged in the ZIP file.");
    const wrongCrc = zipOf([
      { name: "Order History.csv", content: csv, crc: 7, method: "deflate" },
    ]);
    expect(refusal(wrongCrc)).toBe("Order History.csv is damaged in the ZIP file.");
  });

  it("refuses 501 entries, and reads 500", () => {
    const others = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `Photos/${i}.jpeg`, content: "x" }));
    expect(
      read(
        zipOf([{ name: "Order History.csv", content: amazonCsv([amazonRow()]) }, ...others(499)]),
      ).items,
    ).toHaveLength(1);
    expect(
      refusal(
        zipOf([{ name: "Order History.csv", content: amazonCsv([amazonRow()]) }, ...others(500)]),
      ),
    ).toBe("The ZIP file holds more than 500 files.");
  });

  it("refuses an encrypted order file, another packing method, ZIP64, two order files, none, and bytes that are no ZIP file", () => {
    const csv = amazonCsv([amazonRow()]);
    expect(refusal(zipOf([{ name: "Order History.csv", content: csv, flags: 0x0801 }]))).toMatch(
      /encrypted/,
    );
    const bzip = zipOf([{ name: "Order History.csv", content: csv }]);
    // Method 12 (bzip2) in both headers.
    const view = new DataView(bzip.buffer);
    view.setUint16(8, 12, true);
    const central = bzip.byteLength - 22 - (46 + "Order History.csv".length);
    view.setUint16(central + 10, 12, true);
    expect(refusal(bzip)).toMatch(/packed in a way the app does not read/);

    const zip64 = zipOf([{ name: "Order History.csv", content: csv, size: 0xffff_ffff }]);
    expect(refusal(zip64)).toMatch(/ZIP64/);
    expect(
      refusal(
        zipOf([
          { name: "a/Order History.csv", content: csv },
          { name: "b/Order History.csv", content: csv },
        ]),
      ),
    ).toBe("The ZIP file holds more than one Order History.csv.");
    expect(refusal(zipOf([{ name: "Orders.csv", content: csv }]))).toMatch(
      /holds no Order History\.csv/,
    );
    expect(refusal(encode("not a zip file at all, just text"))).toBe(
      "The file is not a ZIP file, or it is damaged.",
    );
    expect(refusal(bzip.subarray(0, bzip.byteLength - 30))).toBe(
      "The file is not a ZIP file, or it is damaged.",
    );
  });

  it("refuses a local header that names another entry than the directory", () => {
    const zip = zipOf([{ name: "Order History.csv", content: amazonCsv([amazonRow()]) }]);
    // The local header's name becomes "Order Historx.csv".
    zip[30 + "Order Histor".length] = "x".charCodeAt(0);
    expect(refusal(zip)).toBe("The file is not a ZIP file, or it is damaged.");
  });

  it.each([
    ["../Order History.csv"],
    ["a/../Order History.csv"],
    ["/Order History.csv"],
    ["\\Order History.csv"],
    ["C:\\Order History.csv"],
    ["C:Order History.csv"],
    ["Orders\tx/Order History.csv"],
    ["Orders\u0001/Order History.csv"],
    ["Orders\u007f/Order History.csv"],
    ["\uff0e\uff0e/Order History.csv"],
    ["Order History\uff0ecsv"],
  ])("skips the entry named %j, as stored", (name) => {
    expect(entryNameProblem(name)).toBeDefined();
    const zip = zipOf([{ name, content: amazonCsv([amazonRow()]) }]);
    expect(refusal(zip)).toMatch(/holds no Order History\.csv/);
  });

  it("skips a name that is not UTF-8, or has high bytes without the UTF-8 flag", () => {
    const bytes = new Uint8Array([...encode("Order History.csv")]);
    const latin = new Uint8Array([0xe9, 0x2f, ...bytes]);
    const notFlagged = zipOf([{ name: latin, content: amazonCsv([amazonRow()]), flags: 0 }]);
    expect(refusal(notFlagged)).toMatch(/holds no/);
    const broken = zipOf([{ name: latin, content: amazonCsv([amazonRow()]) }]);
    expect(refusal(broken)).toMatch(/holds no/);
  });

  it("returns the entry with its name and content", () => {
    const zip = zipOf([{ name: "x/Order History.csv", content: "hello", method: "deflate" }]);
    const entry = readZipEntry(zip, (name) => name.endsWith(".csv"), "none");
    expect(entry).toEqual({ name: "x/Order History.csv", content: encode("hello") });
  });
});

describe("the CSV reader", () => {
  it("drops the byte order mark, and reads quotes, doubled quotes, commas, and line breaks inside quotes", () => {
    const text = '\uFEFFa,b,c\n"x, y","say ""hi""","line one\nline two"\r\nplain,,last\n';
    const csv = readCsv(text);
    if ("refused" in csv) throw new Error(csv.refused);
    expect(csv.header).toEqual(["a", "b", "c"]);
    expect(csv.records).toEqual([
      { row: 2, fields: ["x, y", 'say "hi"', "line one\nline two"] },
      { row: 3, fields: ["plain", "", "last"] },
    ]);
  });

  it("skips and counts a row with the wrong field count or broken quotes, by row number", () => {
    const csv = readCsv('a,b\n1,2\n1,2,3\n"open,2\n');
    if ("refused" in csv) throw new Error(csv.refused);
    expect(csv.records).toEqual([{ row: 2, fields: ["1", "2"] }]);
    expect(csv.wrongFieldCounts).toEqual([3]);
    expect(csv.brokenRows).toEqual([4]);
    const quoteInside = readCsv('a,b\nx"y,2\n"x"y,2\n');
    if ("refused" in quoteInside) throw new Error(quoteInside.refused);
    expect(quoteInside.brokenRows).toEqual([2, 3]);
  });

  it("refuses a file with more rows than the limit before using any", () => {
    const text = `a\n${"1\n".repeat(11)}`;
    expect(readCsv(text, 10)).toEqual({ refused: "The file has more than 10 rows." });
    const ten = readCsv(`a\n${"1\n".repeat(10)}`, 10);
    expect("records" in ten && ten.records).toHaveLength(10);
  });

  it("refuses 200,001 rows at the real limit, as the order file", () => {
    const limits = { ...ORDER_FILE_LIMITS, rows: 3 };
    const rows = Array.from({ length: 4 }, () => amazonRow());
    expect(refusal(encode(amazonCsv(rows)), "csv", limits)).toBe("The file has more than 3 rows.");
    expect(ORDER_FILE_LIMITS.rows).toBe(200_000);
  });
});

describe("the order file's rows", () => {
  it("reads a row into a Line item in cents, with its days in the Household time zone", () => {
    const { items, rowsRead, skipped } = readRows([
      amazonRow({
        "Order Date": "2026-05-01T02:03:22.123Z",
        "Ship Date": "2026-05-02T03:15:00Z",
        "Payment Method Type": "MasterCARD - 0000",
      }),
    ]);
    expect(rowsRead).toBe(1);
    expect(skipped).toEqual([]);
    expect(items).toEqual([
      {
        key: JSON.stringify(["111-0000001-0000001", "B000000001", "2026-05-02T03:15:00Z", 0]),
        orderId: "111-0000001-0000001",
        // 02:03 UTC is the evening before in New York.
        orderDate: "2026-04-30",
        shipDate: "2026-05-01",
        shipTime: "2026-05-02T03:15:00Z",
        productId: "B000000001",
        name: "Paper towels, 12 rolls",
        cleanName: "paper towels 12 rolls",
        quantity: 2,
        unitPrice: 625,
        unitTax: 50,
        shippingCharge: 0,
        discounts: 0,
        total: 1350,
        cardLast4: "0000",
        giftCard: false,
        place: 0,
      },
    ]);
  });

  it.each([
    ["12.5", 1250],
    ["7", 700],
    ["1,234.56", 123_456],
    ["'-3.20'", -320],
    ["-3.2", -320],
    ["0.01", 1],
    ["'0'", 0],
  ])("reads the amount %s as %i cents, with no floating point", (text, cents) => {
    expect(centsOf(text)).toBe(cents);
  });

  it.each([
    ["12.345"],
    ["$12"],
    ["1,23.4"],
    ["12,"],
    [""],
    ["1e3"],
    ["'-3.20"],
    ["Not Available"],
    ["0x10"],
  ])("refuses the amount %j", (text) => {
    expect(centsOf(text)).toBeUndefined();
  });

  it("skips a row with a bad amount, naming the column, and counts the first row number", () => {
    const { items, skipped } = readRows([
      amazonRow(),
      amazonRow({ "Unit Price": "6.255" }),
      amazonRow({ "Unit Price": "abc" }),
      amazonRow({ "Total Amount": "Not Available" }),
    ]);
    expect(items).toHaveLength(1);
    expect(skipped).toEqual([
      { reason: badValue("Unit Price"), rows: 2, firstRow: 3 },
      { reason: badValue("Total Amount"), rows: 1, firstRow: 5 },
    ]);
  });

  it("checks the total: quantity × (price + tax) + shipping + discounts, with Not Available as 0", () => {
    const { items, skipped } = readRows([
      amazonRow({
        "Original Quantity": "3",
        "Unit Price": "1,000.10",
        "Unit Price Tax": "80.01",
        "Shipping Charge": "5.99",
        "Total Discounts": "'-10.00'",
        "Total Amount": "3,236.32",
      }),
      amazonRow({
        "Unit Price Tax": "Not Available",
        "Shipping Charge": "Not Available",
        "Total Discounts": "Not Available",
        "Total Amount": "12.50",
      }),
      amazonRow({ "Total Amount": "13.51" }),
    ]);
    expect(items.map((item) => [item.total, item.discounts, item.shippingCharge])).toEqual([
      [323_632, -1000, 599],
      [1250, 0, 0],
    ]);
    expect(skipped).toEqual([{ reason: SKIP_REASONS.total, rows: 1, firstRow: 4 }]);
  });

  it("skips cancelled rows, rows not shipped, Audible and CBA rows, and rows not in US dollars", () => {
    const { items, rowsRead, skipped } = readRows([
      amazonRow({ "Order Status": "Cancelled" }),
      amazonRow({ "Ship Date": "Not Available", "Shipment Status": "Not Available" }),
      amazonRow({ Website: "Audible" }),
      amazonRow({ Website: "CBA" }),
      amazonRow({ Currency: "EUR" }),
      amazonRow(),
    ]);
    expect(rowsRead).toBe(6);
    expect(items).toHaveLength(1);
    expect(skipped).toEqual([
      { reason: SKIP_REASONS.cancelled, rows: 1, firstRow: 2 },
      { reason: SKIP_REASONS.notShipped, rows: 1, firstRow: 3 },
      { reason: SKIP_REASONS.website, rows: 2, firstRow: 4 },
      { reason: SKIP_REASONS.currency, rows: 1, firstRow: 6 },
    ]);
  });

  it("skips impossible and future dates, bad order IDs, ASINs, quantities, and names, naming each column", () => {
    const { items, skipped } = readRows([
      amazonRow({ "Ship Date": "2026-02-30T10:00:00Z" }),
      amazonRow({ "Order Date": "2026-05-01 14:03:22" }),
      amazonRow({ "Ship Date": "2026-11-20T10:00:00Z" }),
      amazonRow({ "Order ID": "D01-0000001-0000001x" }),
      amazonRow({ ASIN: "B0;" }),
      amazonRow({ "Original Quantity": "0" }),
      amazonRow({ "Product Name": "Not Available" }),
    ]);
    expect(items).toEqual([]);
    expect(skipped.map((skip) => skip.reason)).toEqual([
      badValue("Ship Date"),
      badValue("Order Date"),
      badValue("Order ID"),
      badValue("ASIN"),
      badValue("Original Quantity"),
      badValue("Product Name"),
    ]);
    expect(utcTimeOf("2026-11-10T11:00:00Z", NOW)).toBeDefined();
    expect(utcTimeOf("2026-11-10T13:00:00Z", NOW)).toBeUndefined();
  });

  it("keeps only the card's last 4 digits and a gift card flag, never the card's name", () => {
    const methods = [
      ["Visa - 0000", "0000", false],
      ["MasterCard - 0001", "0001", false],
      ["Gift Certificate/Card", null, true],
      ["Visa - 0002 and Gift Certificate/Card", "0002", true],
      ["Gift Certificate/Card and MasterCard - 0003", "0003", true],
      ["Not Available", null, false],
    ] as const;
    const { items } = readRows(
      methods.map(([method]) => amazonRow({ "Payment Method Type": method })),
    );
    expect(items.map((item) => [item.cardLast4, item.giftCard])).toEqual(
      methods.map(([, last4, gift]) => [last4, gift]),
    );
    expect(JSON.stringify(items)).not.toMatch(/visa|mastercard/i);
    expect(cardLast4Of("Visa - 12345")).toBeNull();
  });

  it("numbers identical rows of one shipment, and keys a row with no ASIN by its name", () => {
    const { items } = readRows([
      amazonRow(),
      amazonRow(),
      amazonRow({ "Ship Date": "2026-05-03T09:15:00Z" }),
      amazonRow({ ASIN: "Not Available", "Product Name": "Hand soap" }),
    ]);
    expect(items.map((item) => [item.place, item.productId])).toEqual([
      [0, "B000000001"],
      [1, "B000000001"],
      [0, "B000000001"],
      [0, null],
    ]);
    expect(new Set(items.map((item) => item.key)).size).toBe(4);
    expect(items[3]?.key).toBe(
      JSON.stringify(["111-0000001-0000001", "name:Hand soap", "2026-05-02T09:15:00Z", 0]),
    );
  });

  it("reads columns by name in any order, reads extra columns, and names a missing column", () => {
    const shuffled = [...AMAZON_HEADER].reverse();
    expect(
      read(encode(amazonCsv([amazonRow()], [...shuffled, "New Column"])), "csv").items,
    ).toHaveLength(1);
    const missing = AMAZON_HEADER.filter((column) => column !== "Unit Price Tax");
    expect(refusal(encode(amazonCsv([amazonRow()], missing)), "csv")).toBe(
      'The file has no "Unit Price Tax" column.',
    );
  });

  it("reads gift messages with quoted line breaks, and a product name with any character", () => {
    const name = 'Mug, "large" — 16 oz\u00e9\n2-pack';
    const { items } = readRows([
      amazonRow({ "Gift Message": 'Happy\nbirthday, "friend"', "Product Name": name }),
    ]);
    expect(items[0]?.name).toBe(name);
    expect(items[0]?.cleanName).toBe("mug large 16 oz\u00e9 2pack");
    expect(cleanItemName("  Paper   Towels!! ")).toBe("paper towels");
  });

  it("names a row number and a column in every refusal and skip, never a row's content", () => {
    const marker = "MARKER-7f3a";
    const rows = [
      amazonRow({ "Product Name": marker, "Unit Price": marker }),
      amazonRow({ "Product Name": marker, "Total Amount": "1" }),
      amazonRow({ "Product Name": marker, "Order ID": marker }),
    ];
    const file = read(encode(`${amazonCsv(rows)}${marker},"x\n`), "csv");
    expect(JSON.stringify(file.skipped)).not.toContain(marker);
    expect(file.skipped.every((skip) => Number.isInteger(skip.firstRow))).toBe(true);
    expect(refusal(encode(amazonCsv(rows, [marker])), "csv")).not.toContain(marker);
  });

  it("refuses a file that is not UTF-8", () => {
    const bytes = new Uint8Array([...encode(amazonCsv([amazonRow()])), 0xff, 0xfe]);
    expect(refusal(bytes, "csv")).toBe("The file is not UTF-8 text.");
  });

  it("deflates the real export's form: a stored order file in a ZIP with a deflated photo", () => {
    const zip = amazonZip(
      [amazonRow(), amazonRow({ "Order ID": "111-0000002-0000002" })],
      [{ name: "Photos/x.jpeg", content: deflateRawSync(new Uint8Array(100)), method: "deflate" }],
    );
    expect(read(zip).items.map((item) => item.orderId)).toEqual([
      "111-0000001-0000001",
      "111-0000002-0000002",
    ]);
  });
});
