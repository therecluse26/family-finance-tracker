import { expect } from "vitest";
import { fakeTxn } from "../../bank/fake.ts";
import { syncConnection } from "../../bank/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { type AmazonRow, amazonRow, amazonZip } from "../../line-items/testing.ts";
import type { AmazonShipmentView } from "../../server/amazon-links-views.ts";
import type { AmazonStatusView } from "../../server/amazon-views.ts";
import type { TransactionRowView } from "../../server/money-movement-views.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// Linking Amazon shipments on the full history (spec 14, Linking Line items to Transactions):
// 1,500 made-up Amazon charges on a card over five years, then an order file of 3,000 rows in
// 1,800 shipments. 1,500 shipments fit one charge each, 100 fit two charges each, and 200 fit
// none. Then the follow-up job of a later sync, a hand link and its Undo, and the pages that read
// the links, with more than 500 Transactions holding Line items.

const LINKED = 1_500;
const ASKED = 100;
const WAITING = 200;
const DAY_MS = 86_400_000;

const dollars = (cents: number) => (cents / 100).toFixed(2);
const stamp = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

timedCase("Amazon linking on the full history", async (history, time) => {
  const bank = history.generated.banks.find((each) =>
    each.accounts.some((account) => account.type === "credit"),
  );
  const card = bank?.accounts.find((account) => account.type === "credit");
  if (bank === undefined || card === undefined) throw new Error("The history has no card.");
  const connectionId = history.connectionIds.get(bank.bankId) ?? "";
  const start = Date.UTC(2021, 11, 1, 12);

  // Shipment i ships about 0.95 days after shipment i - 1, for 20.00 + i cents. Its charge posts the day
  // after. A shipment from LINKED on fits two charges; one from LINKED + ASKED on fits none.
  const shipments = LINKED + ASKED + WAITING;
  const charges = [];
  const rows: AmazonRow[] = [];
  for (let i = 0; i < shipments; i += 1) {
    const shipped = start + Math.floor(i * 0.95) * DAY_MS;
    const total = 2_000 + i;
    const posted = stamp(shipped + DAY_MS).slice(0, 10);
    const fits = i < LINKED ? 1 : i < LINKED + ASKED ? 2 : 0;
    for (let copy = 0; copy < fits; copy += 1) {
      charges.push(
        fakeTxn({
          id: `lh-amazon-${i}-${copy}`,
          accountId: card.id,
          amount: -total,
          postedDate: posted,
          description: `AMAZON MKTPL*LH${String(i).padStart(5, "0")}`,
          merchantName: "Amazon",
        }),
      );
    }
    // Most shipments hold two items, so the file has more rows than shipments.
    const items = i % 3 === 2 ? 1 : 2;
    for (let item = 0; item < items; item += 1) {
      const cents = items === 1 ? total : item === 0 ? total - 500 : 500;
      rows.push(
        amazonRow({
          ASIN: `B${String(i * 2 + item).padStart(9, "0")}`,
          "Order ID": `112-${String(i).padStart(7, "0")}-0000001`,
          "Order Date": stamp(shipped - DAY_MS),
          "Ship Date": stamp(shipped),
          "Product Name": `Made-up product ${i * 2 + item}`,
          "Payment Method Type": `Visa - ${card.mask}`,
          "Original Quantity": "1",
          "Unit Price": dollars(cents),
          "Unit Price Tax": "0",
          "Shipment Item Subtotal": dollars(cents),
          "Shipment Item Subtotal Tax": "0",
          "Total Amount": dollars(cents),
        }),
      );
    }
  }
  history.fake.addPages(bank.bankId, { added: charges });
  await syncConnection(connectionId, HISTORY_NOW);
  await runFollowUp(HISTORY_NOW);

  const file = amazonZip(rows);
  await time.job(
    `POST /api/amazon/import (${rows.length} rows, ${LINKED} shipments to link)`,
    10_000,
    async () => {
      const res = await history.browser.upload("/api/amazon/import", file, "application/zip");
      expect(res.status).toBe(200);
    },
  );
  const status = (await time.request("GET /api/amazon (with links)", () =>
    history.browser.get("/api/amazon"),
  )) as AmazonStatusView;
  expect(status.shipments).toMatchObject({ linked: LINKED, onReviewList: ASKED });

  // The follow-up job the import asked for: every linked Transaction is decided again.
  await time.job(`Follow-up after linking ${LINKED} Transactions`, 20_000, () =>
    runFollowUp(HISTORY_NOW),
  );
  // A later sync's follow-up, with every shipment's link read, changes no link.
  for (const each of history.generated.banks) history.fake.addPages(each.bankId, each.laterPage);
  for (const id of history.connectionIds.values()) await syncConnection(id, HISTORY_NOW);
  await time.job("Follow-up after one more day, with Amazon links", 20_000, () =>
    runFollowUp(HISTORY_NOW),
  );
  expect(
    ((await (await history.browser.get("/api/amazon")).json()) as AmazonStatusView).shipments
      .linked,
  ).toBe(LINKED);

  // Every Transaction, with the item counts of the 1,500 that hold Line items.
  const { transactions } = (await time.request(
    `GET /api/transactions (all, ${LINKED} with Line items)`,
    () => history.browser.get("/api/transactions"),
  )) as { transactions: TransactionRowView[] };
  expect(transactions.filter((txn) => txn.itemCount > 0).length).toBe(LINKED);

  await time.request("GET /api/review-list (with Amazon shipment items)", () =>
    history.browser.get("/api/review-list"),
  );

  // A hand link of an unlinked shipment to a Spending Transaction with no Line items, and its Undo.
  const free = transactions.find(
    (txn) =>
      txn.amount < 0 &&
      txn.itemCount === 0 &&
      !txn.pending &&
      txn.parts.length > 0 &&
      txn.parts.every((part) => part.type === "Spending"),
  );
  const id = free?.id ?? "";
  const { shipments: offered } = (await time.request(
    "GET /api/transactions/:id/amazon-shipments",
    () => history.browser.get(`/api/transactions/${id}/amazon-shipments`),
  )) as { shipments: AmazonShipmentView[] };
  const all = await history.database.$client.execute(
    `SELECT order_id, ship_time FROM line_items WHERE transaction_id IS NULL AND order_id LIKE '112-%'
     LIMIT 1`,
  );
  const shipment = offered[0] ?? {
    orderId: String(all.rows[0]?.order_id),
    shipTime: String(all.rows[0]?.ship_time),
  };
  await time.request("POST /api/transactions/:id/amazon-link", () =>
    history.browser.send("POST", `/api/transactions/${id}/amazon-link`, {
      orderId: shipment.orderId,
      shipTime: shipment.shipTime,
    }),
  );
  await time.request("DELETE /api/transactions/:id/amazon-link", () =>
    history.browser.send("DELETE", `/api/transactions/${id}/amazon-link`),
  );
});
