import { expect } from "vitest";
import { amazonRow, amazonZip } from "../../line-items/testing.ts";
import type { AmazonStatusView } from "../../server/amazon-views.ts";
import type { TransactionRowView } from "../../server/money-movement-views.ts";
import { timedCase } from "../index.ts";

// An Amazon order file of 20,000 made-up rows over five years (spec 14, Speed): its import, then
// the Transactions page and the Store orders page with the Line items stored. A second upload of
// the same file changes nothing, and takes the same limit.

const ROWS = 20_000;

function orderFile(): Uint8Array {
  const start = Date.UTC(2021, 10, 1);
  const rows = Array.from({ length: ROWS }, (_, index) => {
    // About three items an order, an order about every 6 hours.
    const order = Math.floor(index / 3);
    const ordered = new Date(start + order * 6 * 3_600_000);
    const shipped = new Date(ordered.getTime() + 26 * 3_600_000);
    const quantity = (index % 3) + 1;
    const unit = 199 + ((index * 37) % 4_800);
    const tax = Math.round(unit * 0.08);
    const dollars = (cents: number) => (cents / 100).toFixed(2);
    return amazonRow({
      ASIN: `B${String(index % 4_000).padStart(9, "0")}`,
      "Order ID": `111-${String(order).padStart(7, "0")}-0000001`,
      "Order Date": ordered.toISOString().replace(/\.\d{3}Z$/, "Z"),
      "Ship Date": shipped.toISOString().replace(/\.\d{3}Z$/, "Z"),
      "Product Name": `Made-up product ${index % 4_000}`,
      "Original Quantity": String(quantity),
      "Unit Price": dollars(unit),
      "Unit Price Tax": dollars(tax),
      "Shipment Item Subtotal": dollars(unit * quantity),
      "Shipment Item Subtotal Tax": dollars(tax * quantity),
      "Total Amount": dollars((unit + tax) * quantity),
    });
  });
  return amazonZip(rows);
}

timedCase("an Amazon order file of 20,000 rows", async (history, time) => {
  const file = orderFile();

  const imported = (await time.job("POST /api/amazon/import (20,000 rows)", 10_000, async () => {
    const res = await history.browser.upload("/api/amazon/import", file, "application/zip");
    expect(res.status).toBe(200);
    return res.json();
  })) as { import: { added: number; skipped: unknown[] } };
  expect(imported.import.added).toBe(ROWS);
  expect(imported.import.skipped).toEqual([]);

  const again = (await time.job(
    "POST /api/amazon/import (the same 20,000 rows again)",
    10_000,
    async () => {
      const res = await history.browser.upload("/api/amazon/import", file, "application/zip");
      expect(res.status).toBe(200);
      return res.json();
    },
  )) as { import: { added: number; unchanged: number } };
  expect(again.import).toMatchObject({ added: 0, unchanged: ROWS });

  const status = (await time.request("GET /api/amazon (20,000 Line items)", () =>
    history.browser.get("/api/amazon"),
  )) as AmazonStatusView;
  expect(status.lineItems).toBe(ROWS);

  // The page the Transactions page reads first. cases/transactions.ts times the list of every one.
  const page = (await time.request("GET /api/transactions?limit=100 (with 20,000 Line items)", () =>
    history.browser.get("/api/transactions?limit=100"),
  )) as { transactions: TransactionRowView[] };
  const first = page.transactions[0]?.id ?? "";
  await time.request("GET /api/transactions/:id/line-items", () =>
    history.browser.get(`/api/transactions/${first}/line-items`),
  );
});
