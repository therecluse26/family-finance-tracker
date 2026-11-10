import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import {
  addConnection,
  listUnhandledTransactions,
  markSetupStep,
  markTransactionsHandled,
} from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { startLineItemLinks } from "../line-items/index.ts";
import { amazonRow, amazonZip } from "../line-items/testing.ts";
import { createLogger } from "../log.ts";
import { setTransactionType, startMoneyMovement } from "../money-movement/index.ts";
import type { AmazonShipmentView } from "./amazon-links-views.ts";
import { createApp } from "./app.ts";
import type { ReviewItemView } from "./review-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// A Transaction's Amazon links through the app's HTTP interface (spec 14, Hand links; Review list
// items): the shipments to link by hand, the hand link, Undo, and the Review list item. Every row,
// order ID, and card number is made up.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const ZIP = "application/zip";
const NOW = new Date("2026-05-12T14:00:00.000Z");

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-amazon-links-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// One made-up row of one item, for `cents` in all.
const row = (order: string, cents: number, ship = "2026-05-02T09:15:00Z") => {
  const dollars = String(cents / 100);
  return amazonRow({
    "Order ID": order,
    "Ship Date": ship,
    "Original Quantity": "1",
    "Unit Price": dollars,
    "Unit Price Tax": "0",
    "Shipment Item Subtotal": dollars,
    "Shipment Item Subtotal Tax": "0",
    "Total Amount": dollars,
  });
};

describe("the Amazon link routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;
  let stops: (() => void)[];
  let fake: FakeBankAdapter;
  let connectionId: string;
  let jobsStarted: number;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await test.database.$client.execute({ sql: text, args })).rows;
  const idOf = async (providerId: string) =>
    String(
      (await sql("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId]))[0]
        ?.id,
    );
  const links = async () =>
    (
      await sql(
        `SELECT l.order_id, t.provider_transaction_id AS txn, l.link_kind
         FROM line_items l LEFT JOIN transactions t ON t.id = l.transaction_id ORDER BY l.order_id`,
      )
    ).map((one) => `${one.order_id} → ${one.txn ?? "none"}${one.txn ? ` (${one.link_kind})` : ""}`);
  const shipments = async (id: string) => {
    const res = await browser.get(`/api/transactions/${id}/amazon-shipments`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { shipments: AmazonShipmentView[] }).shipments;
  };
  const card = fakeAccount({
    id: "acc-card",
    type: "credit",
    subtype: "credit card",
    mask: "0000",
  });

  beforeEach(async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    fake = new FakeBankAdapter();
    jobsStarted = 0;
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({
        database: test.database,
        startJob: () => {
          jobsStarted += 1;
          return runFollowUp();
        },
      }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startLineItemLinks({ database: test.database, now: () => NOW }).stop,
    ];
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    fake.addPages(BANK, {
      accounts: [card],
      added: [
        fakeTxn({
          id: "t-amazon",
          accountId: card.id,
          amount: -1350,
          postedDate: "2026-05-03",
          description: "AMAZON MKTPL*EXAMPLE",
          merchantName: "Amazon",
        }),
        fakeTxn({
          id: "t-cafe",
          accountId: card.id,
          amount: -450,
          postedDate: "2026-05-04",
          description: "CORNER CAFE",
        }),
      ],
      historyLoaded: true,
    });
    connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId);
    await runFollowUp();
    const res = await browser.upload(
      "/api/amazon/import",
      amazonZip([row("111-0000001-0000001", 1350), row("111-0000002-0000002", 2000)]),
      ZIP,
    );
    expect(res.status).toBe(200);
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  it("links the shipment the import's run fits, and lists the unlinked one to link by hand", async () => {
    expect(await links()).toEqual([
      "111-0000001-0000001 → t-amazon (app)",
      "111-0000002-0000002 → none",
    ]);
    expect(await shipments(await idOf("t-cafe"))).toEqual([
      {
        orderId: "111-0000002-0000002",
        shipTime: "2026-05-02T09:15:00Z",
        orderDate: "2026-05-01",
        shipDate: "2026-05-02",
        total: 2000,
        items: 1,
        names: ["Paper towels, 12 rolls"],
        giftCard: false,
      },
    ]);
    expect((await browser.get("/api/transactions/no-such-id/amazon-shipments")).status).toBe(404);
  });

  it("links by hand, then Undo unlinks and the app never links it back", async () => {
    const cafe = await idOf("t-cafe");
    const shipment = { orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z" };
    const linked = await browser.send("POST", `/api/transactions/${cafe}/amazon-link`, shipment);
    expect(linked.status).toBe(200);
    await runFollowUp();
    expect(await links()).toContain("111-0000002-0000002 → t-cafe (hand)");
    // The Transaction's detail view counts its items.
    const detail = (await (await browser.get(`/api/transactions/${cafe}`)).json()) as {
      transaction: { itemCount: number };
    };
    expect(detail.transaction.itemCount).toBe(1);
    expect(
      (await browser.send("POST", `/api/transactions/${cafe}/amazon-link`, shipment)).status,
    ).toBe(409);

    const amazon = await idOf("t-amazon");
    expect((await browser.send("DELETE", `/api/transactions/${amazon}/amazon-link`)).status).toBe(
      200,
    );
    expect((await browser.send("DELETE", `/api/transactions/${amazon}/amazon-link`)).status).toBe(
      404,
    );
    await runFollowUp();
    await browser.upload("/api/amazon/import", amazonZip([row("111-0000001-0000001", 1350)]), ZIP);
    await runFollowUp();
    expect(await links()).toEqual([
      "111-0000001-0000001 → none",
      "111-0000002-0000002 → t-cafe (hand)",
    ]);
    expect(
      (await sql("SELECT order_id, member_id FROM refused_line_item_links")).map((one) => ({
        ...one,
      })),
    ).toEqual([{ order_id: "111-0000001-0000001", member_id: member.id }]);
  });

  it("refuses a hand link to a charge the bank removed or a Member made a Transfer, and changes nothing", async () => {
    const shipment = { orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z" };
    const [amazon, cafe] = [await idOf("t-amazon"), await idOf("t-cafe")];
    await browser.send("DELETE", `/api/transactions/${amazon}/amazon-link`);
    await runFollowUp();
    fake.addPages(BANK, { accounts: [card], removed: [{ id: "t-cafe" }] });
    await syncConnection(connectionId);
    await runFollowUp();
    await setTransactionType(test.database, amazon, "Transfer");
    await runFollowUp();
    const before = await links();
    const refusals = await sql("SELECT * FROM refused_line_item_links");
    const post = (id: string) =>
      browser.send("POST", `/api/transactions/${id}/amazon-link`, shipment);
    expect((await post(cafe)).status).toBe(404);
    expect((await post(amazon)).status).toBe(400);
    expect(await links()).toEqual(before);
    expect(await sql("SELECT * FROM refused_line_item_links")).toEqual(refusals);
  });

  it("refuses a body that does not name a shipment, and one that is not there", async () => {
    const cafe = await idOf("t-cafe");
    const post = (body: unknown) =>
      browser.send("POST", `/api/transactions/${cafe}/amazon-link`, body);
    expect((await post({ orderId: "111-0000002-0000002" })).status).toBe(400);
    expect((await post({ orderId: "", shipTime: "x" })).status).toBe(400);
    expect(
      (await post({ orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z", more: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await post({ orderId: "111-0000009-0000009", shipTime: "2026-05-02T09:15:00Z" })).status,
    ).toBe(404);
    expect(
      (
        await browser.send("POST", "/api/transactions/no-such-id/amazon-link", {
          orderId: "111-0000002-0000002",
          shipTime: "2026-05-02T09:15:00Z",
        })
      ).status,
    ).toBe(404);
    expect(await links()).toContain("111-0000002-0000002 → none");
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to another type, and changes nothing (K1)", async () => {
    const cafe = await idOf("t-cafe");
    const amazon = await idOf("t-amazon");
    const before = await links();
    const shipment = { orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z" };
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.get(`/api/transactions/${cafe}/amazon-shipments`)).status).toBe(401);
    expect(
      (await signedOut.send("POST", `/api/transactions/${cafe}/amazon-link`, shipment)).status,
    ).toBe(401);
    expect((await signedOut.send("DELETE", `/api/transactions/${amazon}/amazon-link`)).status).toBe(
      401,
    );
    for (const origin of ["http://evil.example", undefined]) {
      expect(
        (await browser.send("POST", `/api/transactions/${cafe}/amazon-link`, shipment, { origin }))
          .status,
      ).toBe(403);
      expect(
        (
          await browser.send("DELETE", `/api/transactions/${amazon}/amazon-link`, undefined, {
            origin,
          })
        ).status,
      ).toBe(403);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      const res = await browser.send("POST", `/api/transactions/${cafe}/amazon-link`, shipment, {
        "content-type": type,
      });
      expect(res.status, type).toBe(415);
    }
    expect(await links()).toEqual(before);
    expect(await sql("SELECT * FROM refused_line_item_links")).toEqual([]);
  });

  it("links one shipment once when two hand links are sent at once (K18)", async () => {
    const shipment = { orderId: "111-0000002-0000002", shipTime: "2026-05-02T09:15:00Z" };
    const [cafe, amazon] = [await idOf("t-cafe"), await idOf("t-amazon")];
    await browser.send("DELETE", `/api/transactions/${amazon}/amazon-link`);
    const statuses = await Promise.all(
      [cafe, amazon].map(
        async (id) =>
          (await browser.send("POST", `/api/transactions/${id}/amazon-link`, shipment)).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 409]);
    expect((await links()).filter((line) => line.startsWith("111-0000002"))).toHaveLength(1);
  });

  // Two charges that fit the unlinked shipment, from a later sync.
  async function twoFits() {
    fake.addPages(BANK, {
      accounts: [card],
      added: [
        fakeTxn({
          id: "t-amazon-2",
          accountId: card.id,
          amount: -2000,
          postedDate: "2026-05-03",
          description: "AMZN Mktp US*EXAMPLE",
        }),
        fakeTxn({
          id: "t-amazon-3",
          accountId: card.id,
          amount: -2000,
          postedDate: "2026-05-04",
          description: "AMZN Mktp US*EXAMPLE",
        }),
      ],
    });
    await syncConnection(connectionId);
    await runFollowUp();
  }
  const openShipmentItems = async () =>
    (
      await sql(
        "SELECT count(*) AS n FROM review_items WHERE kind = 'Amazon shipment' AND closed_at IS NULL",
      )
    )[0]?.n;

  it("puts a shipment two charges fit on the Review list, where picking one links it by hand", async () => {
    await twoFits();
    const { items } = (await (await browser.get("/api/review-list")).json()) as {
      items: ReviewItemView[];
    };
    const item = items.find((one) => one.kind === "Amazon shipment");
    expect(item?.transactions.map((txn) => txn.amount)).toEqual([-2000, -2000]);
    expect(item?.bestAnswer.label).toBe("None of these");
    const status = (await (await browser.get("/api/amazon")).json()) as {
      shipments: { onReviewList: number; waiting: number };
    };
    expect(status.shipments).toMatchObject({ onReviewList: 1, waiting: 0 });

    const three = await idOf("t-amazon-3");
    const answer = (value: string) =>
      browser.send("POST", `/api/review-list/${item?.id}/answer`, { value });
    expect((await answer(`link|${await idOf("t-cafe")}`)).status).toBe(400);
    expect((await answer(`link|${three}`)).status).toBe(200);
    await runFollowUp();
    expect(await links()).toContain("111-0000002-0000002 → t-amazon-3 (hand)");
    const after = (await (await browser.get("/api/review-list")).json()) as {
      items: ReviewItemView[];
    };
    expect(after.items.filter((one) => one.kind === "Amazon shipment")).toEqual([]);
  });

  it("closes the shipment and Line item Category items and unlinks everything on Delete all", async () => {
    await twoFits();
    expect(await openShipmentItems()).toBe(1);
    const amazon = await idOf("t-amazon");
    // As if Categorization had decided every Transaction: no such step runs here.
    const all = (await sql("SELECT id FROM transactions")).map((one) => String(one.id));
    await markTransactionsHandled(test.database, "categorization", all, NOW);
    // An open "AI unsure" Line item Category card, and one of another kind that stays open.
    for (const [id, kind] of [
      ["card-item", "Line item Category"],
      ["card-other", "Merchant Category"],
    ] as const) {
      await sql(
        "INSERT INTO review_items (id, kind, subject_type, subject_ids, decided, best_answer, created_at) VALUES (?, ?, 'line items', '[]', 'x', '{\"value\":\"a\",\"label\":\"a\"}', ?)",
        [id, kind, NOW.toISOString()],
      );
    }
    const jobs = jobsStarted;
    expect((await browser.send("DELETE", "/api/amazon")).status).toBe(200);
    expect(await links()).toEqual([]);
    expect(await openShipmentItems()).toBe(0);
    const open = await sql("SELECT id FROM review_items WHERE closed_at IS NULL ORDER BY id");
    expect(open.map((row) => String(row.id))).toEqual(["card-other"]);
    // The Transaction that had Line items goes back to the follow-up job, and only that one.
    expect(await listUnhandledTransactions(test.database, "categorization")).toEqual([amazon]);
    expect(jobsStarted).toBe(jobs + 1);
  });
});
