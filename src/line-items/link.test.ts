import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  countShipments,
  listOpenReviewItemsOfKind,
  listUnhandledTransactions,
  markTransactionsHandled,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { setTransactionType, startMoneyMovement } from "../money-movement/index.ts";
import { answerReviewItem } from "../review/index.ts";
import { importOrderFile } from "./import.ts";
import {
  AMAZON_SHIPMENT_KIND,
  DAYS_AFTER_SHIP,
  isAmazonCharge,
  linkShipmentByHand,
  runLinking,
  shipmentsToLink,
  startLineItemLinks,
  undoShipmentLinks,
  waitingFrom,
} from "./link.ts";
import { type AmazonRow, amazonCsv, amazonRow } from "./testing.ts";

// Linking Amazon shipments to the card Transactions that paid for them (spec 14, Linking Line items
// to Transactions), through the fake adapter's syncs, the follow-up job, and made-up order files.
// Every order ID, card number, and name is invented.

const MEMBER = "member-1";
const BANK = "birch";
// The card the made-up rows name ("Visa - 0000"), and another card at the same bank.
const CARD = fakeAccount({
  id: "birch-card",
  type: "credit",
  subtype: "credit card",
  mask: "0000",
});
const OTHER_CARD = fakeAccount({
  id: "birch-card-2",
  type: "credit",
  subtype: "credit card",
  mask: "9999",
});
const quiet = createLogger(() => {}, { throwOnSecretField: true });

// One made-up row of one item, for `cents` in all, shipped at `ship`.
function row(
  order: string,
  cents: number,
  fields: { ship?: string; asin?: string; name?: string; payment?: string } = {},
): AmazonRow {
  const dollars = String(cents / 100);
  return amazonRow({
    "Order ID": order,
    ASIN: fields.asin ?? `B${order.replaceAll("-", "").slice(-9)}`,
    "Product Name": fields.name ?? `Made-up item of ${order}`,
    "Ship Date": fields.ship ?? "2026-05-02T09:15:00Z",
    "Original Quantity": "1",
    "Unit Price": dollars,
    "Unit Price Tax": "0",
    "Shipment Item Subtotal": dollars,
    "Shipment Item Subtotal Tax": "0",
    "Total Amount": dollars,
    ...(fields.payment === undefined ? {} : { "Payment Method Type": fields.payment }),
  });
}

// An Amazon charge on the card, posted on `postedDate`.
const charge = (
  id: string,
  amount: number,
  postedDate = "2026-05-03",
  fields: Partial<TxnRecord> = {},
): TxnRecord =>
  fakeTxn({
    id,
    accountId: CARD.id,
    amount,
    postedDate,
    description: "AMAZON MKTPL*EXAMPLE",
    merchantName: "Amazon",
    ...fields,
  });

describe("Linking Amazon shipments", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connection: string;
  let now: Date;

  beforeEach(async () => {
    now = new Date("2026-05-12T14:00:00.000Z");
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startLineItemLinks({ database: bank.database, now: () => now }).stop,
    ];
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-05-01T00:00:00.000Z',
         '2026-05-01T00:00:00.000Z')`,
    );
    connection = await bank.connect(BANK, "Birch Bank");
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  const rows = async (sql: string, args: string[] = []) =>
    (await bank.database.$client.execute({ sql, args })).rows.map((one) => ({ ...one }));
  const idOf = async (providerId: string) =>
    String(
      (await rows("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId]))[0]
        ?.id,
    );

  // One sync of the card's bank, then the follow-up job.
  async function sync(page: FakePage) {
    bank.fake.addPages(connection, { accounts: [CARD, OTHER_CARD], ...page });
    await syncConnection(connection, () => now);
    await runFollowUp(() => now);
  }
  // An import, whose own run links, with no follow-up job after it.
  async function importOnly(...lines: AmazonRow[]) {
    const imported = await importOrderFile(
      bank.database,
      { bytes: new TextEncoder().encode(amazonCsv(lines)), kind: "csv" },
      { memberId: MEMBER, at: now, logger: quiet },
    );
    expect(imported.outcome).toBe("imported");
  }
  async function upload(...lines: AmazonRow[]) {
    await importOnly(...lines);
    await runFollowUp(() => now);
  }
  // Each order's links, as "order → provider ID (kind)", or "order → none".
  const links = async () =>
    (
      await rows(
        `SELECT DISTINCT l.order_id AS orderId, t.provider_transaction_id AS txn, l.link_kind AS kind
         FROM line_items l LEFT JOIN transactions t ON t.id = l.transaction_id
         ORDER BY l.order_id, l.ship_time`,
      )
    ).map((one) =>
      one.txn === null ? `${one.orderId} → none` : `${one.orderId} → ${one.txn} (${one.kind})`,
    );
  const openItems = () => listOpenReviewItemsOfKind(bank.database, AMAZON_SHIPMENT_KIND);
  const counts = (today = "2026-05-12") =>
    countShipments(
      bank.database,
      "amazon",
      waitingFrom(today),
      AMAZON_SHIPMENT_KIND,
      DAYS_AFTER_SHIP,
    );

  it("links a shipment to the one charge that fits it, after the import", async () => {
    await sync({
      added: [
        charge("t-amzn", -1350),
        charge("t-cafe", -1350, "2026-05-03", {
          description: "CORNER CAFE",
          merchantName: null,
        }),
      ],
    });
    const asked = bank.followUpsAsked();
    await upload(row("111-0000001-0000001", 1350));

    expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);
    // The import asked for a follow-up job, which remakes the Transaction's parts.
    expect(bank.followUpsAsked()).toBe(asked + 1);
    expect(await counts()).toEqual({
      linked: 1,
      waiting: 0,
      onReviewList: 0,
      notMatched: 0,
      beforeBankHistory: 0,
      giftCard: 0,
    });
  });

  it("links a waiting shipment when its charge comes in a later sync", async () => {
    await upload(row("111-0000001-0000001", 1350));
    expect(await links()).toEqual(["111-0000001-0000001 → none"]);
    expect((await counts()).waiting).toBe(1);

    await sync({ added: [charge("t-amzn", -1350)] });

    expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);
  });

  it("finds Amazon by its Merchant identity, or by AMAZON or AMZN in the bank line", () => {
    const of = (description: string, merchantCleanName: string | null) =>
      isAmazonCharge({ description, merchantCleanName });
    expect(of("MKTPL ORDER 1234", "Amazon")).toBe(true);
    expect(of("MKTPL ORDER 1234", "Amazon.com")).toBe(true);
    expect(of("MKTPL ORDER 1234", "amzn mktp us")).toBe(true);
    expect(of("AMZN Mktp US*2K4", null)).toBe(true);
    expect(of("Amazon.com*AB12", "Some Other Shop")).toBe(true);
    expect(of("MKTPL ORDER 1234", "Amazon Prime Video Club")).toBe(false);
    expect(of("CORNER CAFE", null)).toBe(false);
  });

  // Each charge differs from one that fits in one way only, so each filter is needed.
  describe("leaves a charge that fails one filter unlinked (K2)", () => {
    const cases: [string, TxnRecord][] = [
      ["pending", charge("t-x", -1350, "2026-05-03", { pending: true })],
      [
        "not Amazon",
        charge("t-x", -1350, "2026-05-03", { description: "CORNER CAFE", merchantName: null }),
      ],
      ["1 cent more", charge("t-x", -1351)],
      ["1 cent less", charge("t-x", -1349)],
      ["2 days before the ship date", charge("t-x", -1350, "2026-04-30")],
      ["8 days after the ship date", charge("t-x", -1350, "2026-05-10")],
      ["on the other card", charge("t-x", -1350, "2026-05-03", { accountId: OTHER_CARD.id })],
      ["money in", charge("t-x", 1350)],
      [
        "a Merchant whose name only starts with Amazon",
        charge("t-x", -1350, "2026-05-03", {
          description: "MKTPL ORDER 1234",
          merchantName: "Amazon Prime Video Club",
        }),
      ],
    ];
    for (const [name, txn] of cases) {
      it(name, async () => {
        await sync({ added: [txn] });
        await upload(row("111-0000001-0000001", 1350));
        expect(await links()).toEqual(["111-0000001-0000001 → none"]);
        expect(await openItems()).toEqual([]);
      });
    }

    it("removed by the bank", async () => {
      await sync({ added: [charge("t-x", -1350)] });
      // The import comes before the follow-up job, while the hidden charge still has its parts.
      bank.fake.addPages(connection, { accounts: [CARD], removed: [{ id: "t-x" }] });
      await syncConnection(connection, () => now);
      await importOnly(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
    });

    it("hidden as posted: the pending charge's posted copy is the one that links", async () => {
      await sync({ added: [charge("t-pending", -1350, "2026-05-03", { pending: true })] });
      await sync({
        added: [charge("t-posted", -1350, "2026-05-04", { pendingTransactionId: "t-pending" })],
        removed: [{ id: "t-pending", reason: "posted" }],
      });
      await upload(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → t-posted (app)"]);
    });

    it("not Spending: a Member made it a Transfer", async () => {
      await sync({ added: [charge("t-x", -1350)] });
      await setTransactionType(bank.database, await idOf("t-x"), "Transfer");
      await runFollowUp(() => now);
      await upload(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
    });

    it("holding another order's Line items", async () => {
      await sync({ added: [charge("t-x", -1350)] });
      await upload(row("111-0000009-0000009", 999, { ship: "2026-04-01T10:00:00Z" }));
      expect(
        await linkShipmentByHand(bank.database, await idOf("t-x"), {
          orderId: "111-0000009-0000009",
          shipTime: "2026-04-01T10:00:00Z",
        }),
      ).toBe("linked");
      await upload(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual([
        "111-0000001-0000001 → none",
        "111-0000009-0000009 → t-x (hand)",
      ]);
      // The one other charge that fits links: the held one is not a second fit.
      await sync({ added: [charge("t-y", -1350, "2026-05-04")] });
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-y (app)",
        "111-0000009-0000009 → t-x (hand)",
      ]);
      expect(await openItems()).toEqual([]);
    });

    it("in another shipment's window, read in the same run", async () => {
      // One run reads charges from 2026-04-01 to 2026-05-09 for both shipments.
      await sync({
        added: [charge("t-early", -1350, "2026-04-20"), charge("t-late", -999, "2026-04-25")],
      });
      await upload(
        row("111-0000001-0000001", 1350),
        row("111-0000002-0000002", 999, { ship: "2026-04-02T10:00:00Z" }),
      );
      expect(await links()).toEqual(["111-0000001-0000001 → none", "111-0000002-0000002 → none"]);
    });

    it("a link a Member undid", async () => {
      await sync({ added: [charge("t-x", -1350)] });
      await upload(row("111-0000001-0000001", 1350));
      expect(await undoShipmentLinks(bank.database, await idOf("t-x"), MEMBER)).toBe(true);
      await runFollowUp(() => now);
      await upload(row("111-0000001-0000001", 1350));
      await sync({ changed: [charge("t-x", -1350, "2026-05-04")] });
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      // Another charge that fits still links.
      await sync({ added: [charge("t-y", -1350, "2026-05-05")] });
      expect(await links()).toEqual(["111-0000001-0000001 → t-y (app)"]);
    });

    it("but the edges of the window, and a card no Account has, still fit", async () => {
      await sync({
        added: [
          charge("t-first", -1350, "2026-05-01"),
          charge("t-last", -2000, "2026-05-09"),
          charge("t-other", -3000, "2026-05-03", { accountId: OTHER_CARD.id }),
        ],
      });
      await upload(
        row("111-0000001-0000001", 1350),
        row("111-0000002-0000002", 2000),
        row("111-0000003-0000003", 3000, { payment: "Visa - 4321" }),
      );
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-first (app)",
        "111-0000002-0000002 → t-last (app)",
        "111-0000003-0000003 → t-other (app)",
      ]);
    });
  });

  it("tries the whole order's total when no shipment of it fits alone", async () => {
    await sync({ added: [charge("t-order", -2025, "2026-05-04")] });
    await upload(
      row("111-0000001-0000001", 1350, { asin: "B000000001" }),
      row("111-0000001-0000001", 675, { asin: "B000000002", ship: "2026-05-03T11:00:00Z" }),
    );
    expect(await links()).toEqual(["111-0000001-0000001 → t-order (app)"]);
    expect((await counts()).linked).toBe(2);
  });

  it("links no whole order when one of its shipments fits alone", async () => {
    await sync({ added: [charge("t-first", -1350), charge("t-order", -2025, "2026-05-04")] });
    await upload(
      row("111-0000001-0000001", 1350, { asin: "B000000001" }),
      row("111-0000001-0000001", 675, { asin: "B000000002", ship: "2026-05-03T11:00:00Z" }),
    );
    expect(
      await rows(
        `SELECT l.ship_time, t.provider_transaction_id AS txn FROM line_items l
         LEFT JOIN transactions t ON t.id = l.transaction_id ORDER BY l.ship_time`,
      ),
    ).toEqual([
      { ship_time: "2026-05-02T09:15:00Z", txn: "t-first" },
      { ship_time: "2026-05-03T11:00:00Z", txn: null },
    ]);
  });

  it("counts each shipment of a whole order on the Review list there", async () => {
    await sync({
      added: [charge("t-one", -2025, "2026-05-04"), charge("t-two", -2025, "2026-05-05")],
    });
    await upload(
      row("111-0000001-0000001", 1350, { asin: "B000000001" }),
      row("111-0000001-0000001", 675, { asin: "B000000002", ship: "2026-05-03T11:00:00Z" }),
    );
    const [item] = await openItems();
    expect(item?.bestAnswer.value).toBe("none|111-0000001-0000001|");
    expect(await counts()).toMatchObject({ onReviewList: 2, waiting: 0, linked: 0 });
    // Once answered, the closed item counts no shipment.
    await answerReviewItem(bank.database, item?.id ?? "", item?.bestAnswer.value ?? "", MEMBER);
    expect(await counts()).toMatchObject({ onReviewList: 0, waiting: 2, linked: 0 });
  });

  it("takes a newer file's Line item into a hand link, and ends an app link it no longer matches", async () => {
    await sync({ added: [charge("t-app", -1350), charge("t-hand", -999)] });
    await upload(
      row("111-0000001-0000001", 1350, { asin: "B000000001" }),
      row("111-0000002-0000002", 2000, { asin: "B000000003" }),
    );
    await linkShipmentByHand(bank.database, await idOf("t-hand"), {
      orderId: "111-0000002-0000002",
      shipTime: "2026-05-02T09:15:00Z",
    });
    await upload(
      row("111-0000001-0000001", 1350, { asin: "B000000001" }),
      row("111-0000001-0000001", 650, { asin: "B000000002" }),
      row("111-0000002-0000002", 2000, { asin: "B000000003" }),
      row("111-0000002-0000002", 100, { asin: "B000000004" }),
    );
    expect(
      await rows(
        `SELECT l.order_id, t.provider_transaction_id AS txn, l.link_kind AS kind FROM line_items l
         LEFT JOIN transactions t ON t.id = l.transaction_id ORDER BY l.order_id, l.total`,
      ),
    ).toEqual([
      { order_id: "111-0000001-0000001", txn: null, kind: null },
      { order_id: "111-0000001-0000001", txn: null, kind: null },
      { order_id: "111-0000002-0000002", txn: "t-hand", kind: "hand" },
      { order_id: "111-0000002-0000002", txn: "t-hand", kind: "hand" },
    ]);
    // The shipment's new total fits a later charge.
    await sync({ added: [charge("t-new", -2000, "2026-05-04")] });
    expect(await links()).toEqual([
      "111-0000001-0000001 → t-new (app)",
      "111-0000002-0000002 → t-hand (hand)",
    ]);
  });

  it("does not try a shipment paid in part by gift card", async () => {
    await sync({ added: [charge("t-amzn", -1350)] });
    await upload(
      row("111-0000001-0000001", 1350, { payment: "Gift Certificate/Card and Visa - 0000" }),
    );
    expect(await links()).toEqual(["111-0000001-0000001 → none"]);
    expect(await counts()).toMatchObject({ giftCard: 1, waiting: 0 });
  });

  it("counts an unlinked shipment as not matched 60 days after its ship date", async () => {
    await upload(row("111-0000001-0000001", 1350));
    expect(await counts("2026-06-30")).toMatchObject({ waiting: 1, notMatched: 0 });
    expect(await counts("2026-07-01")).toMatchObject({ waiting: 0, notMatched: 1 });
    // After that, a sync with no charge that fits it does not try it.
    now = new Date("2026-07-02T14:00:00.000Z");
    const run = await runLinking(
      bank.database,
      { after: "sync", unhandled: new Set(["some-other-id"]) },
      now,
    );
    expect(run).toEqual({ linked: 0, ended: 0, transactionIds: [] });
  });

  // A shipment shipped on May 2 has a link window that ends on May 9 (spec 14, The Store orders
  // page in Settings).
  describe("counts a shipment before the bank history (K2)", () => {
    const cafe = (id: string, postedDate: string, fields: Partial<TxnRecord> = {}) =>
      charge(id, -450, postedDate, { description: "CORNER CAFE", merchantName: null, ...fields });

    it("counts one whose window ends the day before the first posted Transaction there only", async () => {
      await sync({ added: [cafe("t-first", "2026-05-10")] });
      await upload(row("111-0000001-0000001", 1350));

      expect(await counts()).toMatchObject({ beforeBankHistory: 1, waiting: 0, notMatched: 0 });
      expect(await counts("2026-07-01")).toMatchObject({
        beforeBankHistory: 1,
        waiting: 0,
        notMatched: 0,
      });
    });

    it("does not count one whose window ends on the first posted Transaction's day", async () => {
      await sync({ added: [cafe("t-first", "2026-05-09")] });
      await upload(row("111-0000001-0000001", 1350));

      expect(await counts()).toMatchObject({ beforeBankHistory: 0, waiting: 1 });
      expect(await counts("2026-07-01")).toMatchObject({ beforeBankHistory: 0, notMatched: 1 });
    });

    it("takes the purchase date before the posted date", async () => {
      await sync({ added: [cafe("t-first", "2026-05-10", { authorizedDate: "2026-05-09" })] });
      await upload(row("111-0000001-0000001", 1350));

      expect(await counts()).toMatchObject({ beforeBankHistory: 0, waiting: 1 });
    });

    it("lets a hidden first Transaction set the date, and not a pending one", async () => {
      await sync({
        added: [
          cafe("t-pending", "2026-05-03", { pending: true }),
          cafe("t-hidden", "2026-05-09"),
          cafe("t-later", "2026-05-10"),
        ],
      });
      await upload(row("111-0000001-0000001", 1350));
      await rows(
        "UPDATE transactions SET hidden_reason = 'posted', hidden_at = '2026-05-12T14:00:00.000Z' WHERE provider_transaction_id = ?",
        ["t-hidden"],
      );
      expect(await counts()).toMatchObject({ beforeBankHistory: 0, waiting: 1 });

      // With the hidden one pending too, the pending ones set no date.
      await rows("UPDATE transactions SET pending = 1 WHERE provider_transaction_id = ?", [
        "t-hidden",
      ]);
      expect(await counts()).toMatchObject({ beforeBankHistory: 1, waiting: 0 });
    });

    it("counts a linked, a gift card, and a Review list shipment where they were", async () => {
      await sync({
        added: [
          charge("t-amzn", -1350),
          charge("t-one", -2025, "2026-05-04"),
          charge("t-two", -2025, "2026-05-05"),
        ],
      });
      await upload(
        row("111-0000001-0000001", 1350),
        row("111-0000002-0000002", 2025),
        row("111-0000003-0000003", 999, { payment: "Gift Certificate/Card and Visa - 0000" }),
      );
      const before = await counts();
      expect(before).toEqual({
        linked: 1,
        waiting: 0,
        onReviewList: 1,
        notMatched: 0,
        beforeBankHistory: 0,
        giftCard: 1,
      });
      // The banks' history now starts after every window ends.
      await rows("UPDATE transactions SET posted_date = '2026-05-20', authorized_date = NULL");

      expect(await counts()).toEqual(before);
    });

    it("counts none with no posted Transaction", async () => {
      await sync({ added: [cafe("t-pending", "2026-05-10", { pending: true })] });
      await upload(row("111-0000001-0000001", 1350));

      expect(await counts()).toMatchObject({ beforeBankHistory: 0, waiting: 1 });
      expect(await counts("2026-07-01")).toMatchObject({ beforeBankHistory: 0, notMatched: 1 });
    });
  });

  describe("which shipments a sync tries (K2)", () => {
    const second = { orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z" };
    const cafe = charge("t-cafe", -450, "2026-05-11", {
      description: "CORNER CAFE",
      merchantName: null,
    });
    // One charge fits two shipments alone, so neither links. Then a Member links the second to
    // another charge by hand, which leaves the charge to the first without changing it.
    async function contested() {
      await sync({ added: [charge("t-x", -1350), charge("t-other", -500)] });
      await upload(row("111-0000001-0000001", 1350), row("111-0000002-0000002", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → none", "111-0000002-0000002 → none"]);
      expect(await linkShipmentByHand(bank.database, await idOf("t-other"), second)).toBe("linked");
    }

    it("tries a waiting shipment on a sync whose new Transactions do not fit it", async () => {
      await contested();
      await sync({ added: [cafe] });
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-x (app)",
        "111-0000002-0000002 → t-other (hand)",
      ]);
    });

    it("tries a shipment past 60 days only when a charge that fits it is new or changed", async () => {
      now = new Date("2026-07-02T14:00:00.000Z");
      await contested();
      await sync({ added: [cafe] });
      expect(await links()).toEqual([
        "111-0000001-0000001 → none",
        "111-0000002-0000002 → t-other (hand)",
      ]);
      await sync({
        changed: [charge("t-x", -1350, "2026-05-03", { description: "AMAZON MKTPL*CHANGED" })],
      });
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-x (app)",
        "111-0000002-0000002 → t-other (hand)",
      ]);
    });
  });

  describe("with two charges that fit", () => {
    beforeEach(async () => {
      await sync({
        added: [charge("t-one", -1350, "2026-05-02"), charge("t-two", -1350, "2026-05-04")],
      });
      await upload(row("111-0000001-0000001", 1350));
    });

    it("links nothing and puts one Review list item up for the shipment", async () => {
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      const [item, ...more] = await openItems();
      expect(more).toEqual([]);
      expect(item?.subjectIds).toEqual([await idOf("t-one"), await idOf("t-two")]);
      expect(item?.bestAnswer).toEqual({
        value: "none|111-0000001-0000001|2026-05-02T09:15:00Z",
        label: "None of these",
      });
      expect(await counts()).toMatchObject({ onReviewList: 1, waiting: 0 });
      // Another import or sync opens no second item.
      await upload(row("111-0000001-0000001", 1350));
      await sync({ changed: [charge("t-one", -1350, "2026-05-02")] });
      expect(await openItems()).toHaveLength(1);
    });

    it("links by hand when a Member picks one", async () => {
      const [item] = await openItems();
      const two = await idOf("t-two");
      expect(await answerReviewItem(bank.database, item?.id ?? "", `link|${two}`, MEMBER)).toBe(
        "answered",
      );
      expect(await links()).toEqual(["111-0000001-0000001 → t-two (hand)"]);
      expect(await openItems()).toEqual([]);
      // A Transaction the item is not about is not a choice.
      expect(await answerReviewItem(bank.database, item?.id ?? "", "link|t-one", MEMBER)).toBe(
        "not open",
      );
    });

    it('refuses every Transaction on "None of these", and never offers them again', async () => {
      const [item] = await openItems();
      expect(
        await answerReviewItem(bank.database, item?.id ?? "", item?.bestAnswer.value ?? "", MEMBER),
      ).toBe("answered");
      await sync({ changed: [charge("t-one", -1350, "2026-05-03")] });
      await upload(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      expect(await openItems()).toEqual([]);
      expect(
        await rows("SELECT order_id, transaction_id FROM refused_line_item_links ORDER BY 2"),
      ).toHaveLength(2);
    });

    it("closes by itself when the shipment is linked by hand from the detail view", async () => {
      expect(
        await linkShipmentByHand(bank.database, await idOf("t-one"), {
          orderId: "111-0000001-0000001",
          shipTime: "2026-05-02T09:15:00Z",
        }),
      ).toBe("linked");
      expect(await openItems()).toEqual([]);
      expect(await links()).toEqual(["111-0000001-0000001 → t-one (hand)"]);
    });

    it("closes by itself and links when only one of its Transactions is left", async () => {
      await sync({ removed: [{ id: "t-one" }] });
      expect(await openItems()).toEqual([]);
      expect(await links()).toEqual(["111-0000001-0000001 → t-two (app)"]);
    });

    it("refuses a choice that no longer applies", async () => {
      const [item] = await openItems();
      const one = await idOf("t-one");
      await linkShipmentByHand(bank.database, await idOf("t-two"), {
        orderId: "111-0000001-0000001",
        shipTime: "2026-05-02T09:15:00Z",
      });
      expect(await answerReviewItem(bank.database, item?.id ?? "", `link|${one}`, MEMBER)).toBe(
        "not open",
      );
    });
  });

  it("leaves a charge that two shipments fit alone for both: neither links", async () => {
    await sync({ added: [charge("t-amzn", -1350)] });
    await upload(row("111-0000001-0000001", 1350), row("111-0000002-0000002", 1350));
    expect(await links()).toEqual(["111-0000001-0000001 → none", "111-0000002-0000002 → none"]);
    // Their own charges come later: each fits two shipments now, so each shipment asks.
    await sync({ added: [charge("t-amzn-2", -1350, "2026-05-04")] });
    expect(await links()).toEqual(["111-0000001-0000001 → none", "111-0000002-0000002 → none"]);
    expect(await openItems()).toHaveLength(2);
  });

  describe("hand links and Undo", () => {
    it("links a shipment with a different amount by hand, and Undo refuses it for good", async () => {
      await sync({ added: [charge("t-amzn", -1500)] });
      await upload(row("111-0000001-0000001", 1350));
      const id = await idOf("t-amzn");
      expect(await shipmentsToLink(bank.database, id)).toMatchObject([
        { orderId: "111-0000001-0000001", total: 1350, items: 1 },
      ]);
      const shipment = { orderId: "111-0000001-0000001", shipTime: "2026-05-02T09:15:00Z" };
      expect(await linkShipmentByHand(bank.database, id, shipment)).toBe("linked");
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (hand)"]);
      expect(await shipmentsToLink(bank.database, id)).toEqual([]);
      // One order at most, and a linked shipment links once.
      expect(await linkShipmentByHand(bank.database, id, shipment)).toBe("already linked");

      expect(await undoShipmentLinks(bank.database, id, MEMBER)).toBe(true);
      expect(await undoShipmentLinks(bank.database, id, MEMBER)).toBe(false);
      await sync({ changed: [charge("t-amzn", -1350)] });
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      // A Member's own hand link ends the refusal.
      expect(await linkShipmentByHand(bank.database, id, shipment)).toBe("linked");
      expect(await rows("SELECT * FROM refused_line_item_links")).toEqual([]);
    });

    it("refuses a pending, a removed, a non-Spending, or another order's Transaction, and changes nothing", async () => {
      await sync({
        added: [
          charge("t-pending", -1350, "2026-05-03", { pending: true }),
          charge("t-in", 1350),
          charge("t-held", -999),
          charge("t-removed", -1350),
          charge("t-transfer", -1350, "2026-05-04"),
        ],
      });
      await sync({ removed: [{ id: "t-removed" }] });
      await setTransactionType(bank.database, await idOf("t-transfer"), "Transfer");
      await runFollowUp(() => now);
      await upload(
        row("111-0000001-0000001", 1350),
        row("111-0000009-0000009", 999, { ship: "2026-05-03T10:00:00Z" }),
      );
      const before = await links();
      expect(before).toEqual(["111-0000001-0000001 → none", "111-0000009-0000009 → t-held (app)"]);
      const shipment = { orderId: "111-0000001-0000001", shipTime: "2026-05-02T09:15:00Z" };
      expect(await linkShipmentByHand(bank.database, await idOf("t-pending"), shipment)).toBe(
        "pending",
      );
      expect(await linkShipmentByHand(bank.database, await idOf("t-removed"), shipment)).toBe(
        "no Transaction",
      );
      expect(await linkShipmentByHand(bank.database, await idOf("t-transfer"), shipment)).toBe(
        "not Spending",
      );
      expect(await linkShipmentByHand(bank.database, await idOf("t-in"), shipment)).toBe(
        "not Spending",
      );
      expect(await linkShipmentByHand(bank.database, await idOf("t-held"), shipment)).toBe(
        "another order",
      );
      expect(await linkShipmentByHand(bank.database, "no-such-id", shipment)).toBe(
        "no Transaction",
      );
      expect(
        await linkShipmentByHand(bank.database, await idOf("t-held"), {
          orderId: "111-0000001-0000001",
          shipTime: "2026-01-01T00:00:00Z",
        }),
      ).toBe("no shipment");
      expect(await links()).toEqual(before);
      expect(await rows("SELECT * FROM refused_line_item_links")).toEqual([]);
    });

    it("refuses a Review list pick of a charge the bank removed or a Member made a Transfer, and changes nothing (K2)", async () => {
      await sync({
        added: [
          charge("t-one", -1350, "2026-05-02"),
          charge("t-two", -1350, "2026-05-03"),
          charge("t-three", -1350, "2026-05-04"),
        ],
      });
      await upload(row("111-0000001-0000001", 1350));
      const [item] = await openItems();
      const [two, three] = [await idOf("t-two"), await idOf("t-three")];
      // The follow-up job makes t-two a Transfer, and the item stays up for the other two.
      await setTransactionType(bank.database, two, "Transfer");
      await runFollowUp(() => now);
      expect((await openItems()).map((open) => open.id)).toEqual([item?.id]);
      // The bank removes t-three before the next follow-up job settles the item.
      bank.fake.addPages(connection, { accounts: [CARD], removed: [{ id: "t-three" }] });
      await syncConnection(connection, () => now);
      for (const [id, why] of [
        [two, "a Transfer"],
        [three, "removed"],
      ] as const) {
        expect(
          await answerReviewItem(bank.database, item?.id ?? "", `link|${id}`, MEMBER),
          why,
        ).toBe("not a choice");
      }
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      expect(await rows("SELECT * FROM refused_line_item_links")).toEqual([]);
      expect(await openItems()).toHaveLength(1);
    });

    it("links one shipment once when two hand links race (K18)", async () => {
      await sync({ added: [charge("t-one", -1350), charge("t-two", -1350, "2026-05-04")] });
      await upload(row("111-0000001-0000001", 1350));
      const shipment = { orderId: "111-0000001-0000001", shipTime: "2026-05-02T09:15:00Z" };
      const outcomes = await Promise.all([
        linkShipmentByHand(bank.database, await idOf("t-one"), shipment),
        linkShipmentByHand(bank.database, await idOf("t-two"), shipment),
      ]);
      expect(outcomes.sort()).toEqual(["already linked", "linked"]);
      expect(await links()).toHaveLength(1);
    });
  });

  describe("when the bank changes the Transaction (K12)", () => {
    const shipment = { orderId: "111-0000001-0000001", shipTime: "2026-05-02T09:15:00Z" };

    it("ends an app link when the amount changes, and links again when it changes back", async () => {
      await sync({ added: [charge("t-amzn", -1350)] });
      await upload(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);

      await sync({ changed: [charge("t-amzn", -1400)] });
      expect(await links()).toEqual(["111-0000001-0000001 → none"]);
      await sync({ changed: [charge("t-amzn", -1350)] });
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);
    });

    it("keeps a hand link through an amount change and back", async () => {
      await sync({ added: [charge("t-amzn", -1350)] });
      await upload(row("111-0000001-0000001", 1350, { ship: "2026-04-01T09:15:00Z" }));
      expect(
        await linkShipmentByHand(bank.database, await idOf("t-amzn"), {
          ...shipment,
          shipTime: "2026-04-01T09:15:00Z",
        }),
      ).toBe("linked");
      await sync({ changed: [charge("t-amzn", -1400)] });
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (hand)"]);
      await sync({ changed: [charge("t-amzn", -1350)] });
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (hand)"]);
    });

    it("unlinks an app link and a hand link when the bank removes their Transactions, and tries again", async () => {
      await sync({ added: [charge("t-app", -1350), charge("t-hand", -500)] });
      await upload(row("111-0000001-0000001", 1350), row("111-0000002-0000002", 2000));
      await linkShipmentByHand(bank.database, await idOf("t-hand"), {
        orderId: "111-0000002-0000002",
        shipTime: "2026-05-02T09:15:00Z",
      });
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-app (app)",
        "111-0000002-0000002 → t-hand (hand)",
      ]);
      await sync({
        removed: [{ id: "t-app" }, { id: "t-hand" }],
        added: [charge("t-again", -2000, "2026-05-05")],
      });
      expect(await links()).toEqual([
        "111-0000001-0000001 → none",
        "111-0000002-0000002 → t-again (app)",
      ]);
    });

    it("moves a hand link on a re-linked bank's Transaction to its copy, and links the app's again", async () => {
      // The old Connection's last sync is on day D, 2026-05-05: its Transactions dated D are
      // replaced by their copies.
      now = new Date("2026-05-05T18:00:00.000Z");
      const D = "2026-05-05";
      const ship = "2026-05-04T09:15:00Z";
      await sync({
        added: [charge("t-hand", -1500, D), charge("t-app", -2000, D)],
        historyLoaded: true,
      });
      await upload(
        row("111-0000001-0000001", 1350, { ship }),
        row("111-0000002-0000002", 2000, { ship }),
      );
      await linkShipmentByHand(bank.database, await idOf("t-hand"), {
        ...shipment,
        shipTime: ship,
      });
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-hand (hand)",
        "111-0000002-0000002 → t-app (app)",
      ]);

      expect(await connectionRemoving().remove(connection)).toEqual({ outcome: "removed" });
      now = new Date("2026-05-12T14:00:00.000Z");
      connection = await bank.connect(BANK, "Birch Bank");
      const newCard = { ...CARD, id: "birch-card-new" };
      bank.fake.addPages(connection, { accounts: [newCard], added: [] });
      await syncConnection(connection, () => now);
      await runFollowUp(() => now);
      // The hand link waits for its copy. The app's link ended at once.
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-hand (hand)",
        "111-0000002-0000002 → none",
      ]);

      bank.fake.addPages(connection, {
        accounts: [newCard],
        added: [
          charge("n-hand", -1500, D, { accountId: newCard.id }),
          charge("n-app", -2000, D, { accountId: newCard.id }),
        ],
        historyLoaded: true,
      });
      await syncConnection(connection, () => now);
      await runFollowUp(() => now);
      expect(await links()).toEqual([
        "111-0000001-0000001 → n-hand (hand)",
        "111-0000002-0000002 → n-app (app)",
      ]);
    });
  });

  describe("on a re-linked bank (K12)", () => {
    // The old Connection's last sync is on day D, 2026-05-05: its Transactions dated D are
    // replaced by their copies on the new Connection's card.
    const D = "2026-05-05";
    const ship = "2026-05-04T09:15:00Z";
    const newCard = { ...CARD, id: "birch-card-new" };
    const copy = (id: string, amount: number, fields: Partial<TxnRecord> = {}) =>
      charge(id, amount, D, { accountId: newCard.id, ...fields });
    async function relink() {
      expect(await connectionRemoving().remove(connection)).toEqual({ outcome: "removed" });
      now = new Date("2026-05-12T14:00:00.000Z");
      connection = await bank.connect(BANK, "Birch Bank");
    }
    async function syncNew(page: FakePage) {
      bank.fake.addPages(connection, { accounts: [newCard], ...page });
      await syncConnection(connection, () => now);
      await runFollowUp(() => now);
    }
    beforeEach(() => {
      now = new Date("2026-05-05T18:00:00.000Z");
    });

    it("never links a shipment a Member undid to the old Transaction's copy", async () => {
      await sync({ added: [charge("t-undone", -2000, D)], historyLoaded: true });
      await upload(row("111-0000002-0000002", 2000, { ship }));
      expect(await links()).toEqual(["111-0000002-0000002 → t-undone (app)"]);
      expect(await undoShipmentLinks(bank.database, await idOf("t-undone"), MEMBER)).toBe(true);
      await runFollowUp(() => now);

      await relink();
      await syncNew({ added: [copy("n-undone", -2000)], historyLoaded: true });
      expect(await links()).toEqual(["111-0000002-0000002 → none"]);
      expect(await rows("SELECT order_id, transaction_id FROM refused_line_item_links")).toEqual([
        { order_id: "111-0000002-0000002", transaction_id: await idOf("n-undone") },
      ]);
    });

    it("moves no hand link onto a copy that holds Line items already", async () => {
      const [a, b] = [{ description: "AMAZON MKTPL*AAA" }, { description: "AMAZON MKTPL*BBB" }];
      await sync({
        added: [charge("t-a", -1500, D, a), charge("t-b", -1500, D, b)],
        historyLoaded: true,
      });
      await upload(
        row("111-0000001-0000001", 1350, { ship }),
        row("111-0000002-0000002", 2000, { ship }),
      );
      for (const [id, orderId] of [
        ["t-a", "111-0000001-0000001"],
        ["t-b", "111-0000002-0000002"],
      ] as const) {
        expect(
          await linkShipmentByHand(bank.database, await idOf(id), { orderId, shipTime: ship }),
        ).toBe("linked");
      }

      await relink();
      // The first copy takes t-a's hand link.
      await syncNew({ added: [copy("n-a", -1500, a)] });
      expect(await links()).toEqual([
        "111-0000001-0000001 → n-a (hand)",
        "111-0000002-0000002 → t-b (hand)",
      ]);
      // The bank changes n-a's line to t-b's. Its Line items keep t-b's link off it.
      await syncNew({
        changed: [copy("n-a", -1500, b)],
        added: [copy("n-b", -1500, a)],
        historyLoaded: true,
      });
      expect(await links()).toEqual([
        "111-0000001-0000001 → n-a (hand)",
        "111-0000002-0000002 → n-b (hand)",
      ]);
    });
  });

  // The follow-up contract with Line item Categories (X43): every link change marks its
  // Transaction unhandled in the same write, so the cascade remakes its parts. No Categorization
  // step runs here, so each test marks every Transaction handled for it first.
  describe("marks each Transaction a link change touches unhandled", () => {
    const decided = async () => {
      const all = await rows("SELECT id FROM transactions");
      await markTransactionsHandled(
        bank.database,
        "categorization",
        all.map((one) => String(one.id)),
        now,
      );
    };
    const toDecide = async () => {
      const ids = new Set(await listUnhandledTransactions(bank.database, "categorization"));
      return (await rows("SELECT id, provider_transaction_id AS txn FROM transactions"))
        .filter((one) => ids.has(String(one.id)))
        .map((one) => one.txn)
        .sort();
    };

    it("for an app link", async () => {
      await sync({ added: [charge("t-amzn", -1350)] });
      await decided();
      await importOnly(row("111-0000001-0000001", 1350));
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);
      expect(await toDecide()).toEqual(["t-amzn"]);
    });

    it("for an app link that ends, and a hand link a newer file's Line item joins", async () => {
      await sync({ added: [charge("t-app", -1350), charge("t-hand", -999)] });
      await upload(row("111-0000001-0000001", 1350), row("111-0000002-0000002", 2000));
      await linkShipmentByHand(bank.database, await idOf("t-hand"), {
        orderId: "111-0000002-0000002",
        shipTime: "2026-05-02T09:15:00Z",
      });
      await runFollowUp(() => now);
      await decided();
      await importOnly(
        row("111-0000001-0000001", 1350),
        row("111-0000001-0000001", 650, { asin: "B000000002" }),
        row("111-0000002-0000002", 2000),
        row("111-0000002-0000002", 100, { asin: "B000000004" }),
      );
      expect(await links()).toEqual([
        "111-0000001-0000001 → none",
        "111-0000002-0000002 → t-hand (hand)",
      ]);
      expect(await toDecide()).toEqual(["t-app", "t-hand"]);
    });

    it("for a hand link and its Undo, and asks for the follow-up job", async () => {
      await sync({ added: [charge("t-amzn", -1500)] });
      await upload(row("111-0000001-0000001", 1350));
      const id = await idOf("t-amzn");
      const asked = bank.followUpsAsked();
      await decided();
      expect(
        await linkShipmentByHand(bank.database, id, {
          orderId: "111-0000001-0000001",
          shipTime: "2026-05-02T09:15:00Z",
        }),
      ).toBe("linked");
      expect(await toDecide()).toEqual(["t-amzn"]);
      expect(bank.followUpsAsked()).toBe(asked + 1);
      await decided();
      expect(await undoShipmentLinks(bank.database, id, MEMBER)).toBe(true);
      expect(await toDecide()).toEqual(["t-amzn"]);
      expect(bank.followUpsAsked()).toBe(asked + 2);
    });
  });

  describe("in the follow-up job", () => {
    it("ends: a run that changes nothing marks no Transaction unhandled (K4)", async () => {
      await sync({ added: [charge("t-amzn", -1350)] });
      await upload(row("111-0000001-0000001", 1350));
      await runFollowUp(() => now);
      expect(await listUnhandledTransactions(bank.database, "Amazon linking")).toEqual([]);
      const asked = bank.followUpsAsked();
      expect(
        await runLinking(
          bank.database,
          { after: "sync", unhandled: new Set([await idOf("t-amzn")]) },
          now,
        ),
      ).toEqual({ linked: 0, ended: 0, transactionIds: [] });
      await runFollowUp(() => now);
      expect(await listUnhandledTransactions(bank.database, "matching")).toEqual([]);
      expect(bank.followUpsAsked()).toBe(asked);
    });

    it("links a charge from a sync that stored a page and then failed, and again after the retry (K5)", async () => {
      await upload(row("111-0000001-0000001", 1350), row("111-0000002-0000002", 2000));
      bank.fake.addPages(
        connection,
        { accounts: [CARD], added: [charge("t-one", -1350)] },
        { accounts: [CARD], added: [charge("t-two", -2000)], historyLoaded: true },
      );
      bank.fake.failAt(connection, 1, "temporary");
      await expect(syncConnection(connection, () => now)).rejects.toThrow("failed page 1");
      await runFollowUp(() => now);
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-one (app)",
        "111-0000002-0000002 → none",
      ]);
      await syncConnection(connection, () => now);
      await runFollowUp(() => now);
      expect(await links()).toEqual([
        "111-0000001-0000001 → t-one (app)",
        "111-0000002-0000002 → t-two (app)",
      ]);
    });

    it("keeps its Transactions unhandled when a run fails partway, and links on the retry (K5)", async () => {
      await upload(row("111-0000001-0000001", 1350));
      await bank.database.$client.execute(
        `CREATE TRIGGER fail_link BEFORE UPDATE OF transaction_id ON line_items
         BEGIN SELECT RAISE(ABORT, 'made-up failure'); END`,
      );
      bank.fake.addPages(connection, { accounts: [CARD], added: [charge("t-amzn", -1350)] });
      await syncConnection(connection, () => now);
      await expect(runFollowUp(() => now)).rejects.toThrow();
      expect(await listUnhandledTransactions(bank.database, "Amazon linking")).toEqual([
        await idOf("t-amzn"),
      ]);
      await bank.database.$client.execute("DROP TRIGGER fail_link");
      await runFollowUp(() => now);
      expect(await links()).toEqual(["111-0000001-0000001 → t-amzn (app)"]);
    });
  });
});

describe("Linking at scale (K3)", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2021-01-01T00:00:00.000Z',
         '2021-01-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  // Copies of one decided Spending charge, as `count` Amazon charges of 10.00 + i cents, ten a day
  // from 2021-06-01: the same columns, with their own IDs, amounts, and dates.
  async function copies(templateId: string, count: number) {
    const client = bank.database.$client;
    const columns = async (table: string) =>
      (await client.execute(`SELECT name FROM pragma_table_info('${table}')`)).rows.map((one) =>
        String(one.name),
      );
    const numbers = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count - 1})`;
    const day = "date('2021-06-01', '+' || (i / 10) || ' days')";
    const copy = async (table: string, idColumn: string, set: Record<string, string>) => {
      const names = await columns(table);
      const values = names.map((name) => set[name] ?? `t.${name}`);
      await client.execute({
        sql: `INSERT INTO ${table} (${names.join(", ")}) ${numbers}
          SELECT ${values.join(", ")} FROM n, ${table} t WHERE t.${idColumn} = ?`,
        args: [templateId],
      });
    };
    await copy("transactions", "id", {
      id: "'copy-' || i",
      provider_transaction_id: "'copy-' || i",
      amount: "-(1000 + i)",
      posted_date: day,
      authorized_date: "NULL",
    });
    await copy("transaction_decisions", "transaction_id", { transaction_id: "'copy-' || i" });
    await copy("transaction_parts", "transaction_id", {
      transaction_id: "'copy-' || i",
      amount: "CASE WHEN t.amount < 0 THEN -(1000 + i) ELSE 1000 + i END",
    });
  }

  it("links 2,500 shipments against 20,000 Transactions in a few seconds", async () => {
    const connection = await bank.connect(BANK, "Birch Bank");
    bank.fake.addPages(connection, {
      accounts: [CARD],
      added: [charge("template", -1000, "2021-05-01")],
      historyLoaded: true,
    });
    // After the last ship date, so no row is in the future.
    const now = new Date("2026-12-31T14:00:00.000Z");
    await syncConnection(connection, () => now);
    await runFollowUp(() => now);
    const [template] = (
      await bank.database.$client.execute("SELECT id FROM transactions")
    ).rows.map((one) => String(one.id));
    await copies(template ?? "", 20_000);

    // Shipment i fits copy 8i alone: its amount and its day.
    const lines: AmazonRow[] = [];
    for (let i = 0; i < 2_500; i += 1) {
      const j = i * 8;
      const day = new Date(Date.parse("2021-06-01T12:00:00Z") + Math.floor(j / 10) * 86_400_000);
      lines.push(
        row(`113-${String(i).padStart(7, "0")}-0000001`, 1000 + j, {
          ship: day.toISOString().replace(/\.\d+Z$/, "Z"),
        }),
      );
    }
    const imported = await importOrderFile(
      bank.database,
      { bytes: new TextEncoder().encode(amazonCsv(lines)), kind: "csv" },
      { memberId: MEMBER, at: now, logger: quiet },
    );
    expect(imported.outcome).toBe("imported");

    const started = performance.now();
    const run = await runLinking(bank.database, { after: "import" }, now);
    const linking = performance.now() - started;
    expect(run.linked).toBe(2_500);

    // A follow-up run over every Transaction changes nothing.
    const ids = (await bank.database.$client.execute("SELECT id FROM transactions")).rows.map(
      (one) => String(one.id),
    );
    const again = performance.now();
    expect(
      await runLinking(bank.database, { after: "sync", unhandled: new Set(ids) }, now),
    ).toEqual({ linked: 0, ended: 0, transactionIds: [] });
    const followUp = performance.now() - again;
    expect(linking).toBeLessThan(5_000);
    expect(followUp).toBeLessThan(3_000);
  }, 60_000);
});
