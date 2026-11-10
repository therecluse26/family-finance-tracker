import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addConnection,
  countLineItemsOf,
  deleteRemovedConnection,
  markConnectionRemoved,
  markSetupStep,
  removeMember,
} from "../db/index.ts";
import { followUpAgain, runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import {
  lineItemCategoriesSettled,
  registerLineItemsImported,
  registerLineItemsRemoved,
  startLineItemCategories,
} from "../line-items/index.ts";
import { type AmazonRow, amazonCsv, amazonRow, amazonZip } from "../line-items/testing.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import type { AmazonImportView, AmazonStatusView, LineItemView } from "./amazon-views.ts";
import { createApp } from "./app.ts";
import type { TransactionListView } from "./bank-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, readZip, TestBrowser } from "./testing.ts";

// Settings → Amazon through the app's HTTP interface (spec 14): the upload, the import by key,
// "Delete all Amazon data", the Line items on a Transaction, and the data export. Every row, order
// ID, and card number is made up.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const ZIP = "application/zip";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-amazon-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

type Imported = { import: AmazonImportView; status: AmazonStatusView };

describe("the Amazon routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;
  let lines: string[];
  let stops: (() => void)[];
  let connectionId: string;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await test.database.$client.execute({ sql: text, args })).rows;
  const lineItemRows = () => sql("SELECT * FROM line_items ORDER BY key");
  const amazonTxnId = async () =>
    String((await sql("SELECT id FROM transactions WHERE description LIKE 'AMAZON%'"))[0]?.id);

  const upload = (body: Uint8Array | string, type = ZIP) =>
    browser.upload("/api/amazon/import", body, type);
  async function imported(body: Uint8Array | string, type = ZIP): Promise<Imported> {
    const res = await upload(body, type);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Imported;
  }
  const status = async () => (await (await browser.get("/api/amazon")).json()) as AmazonStatusView;

  beforeEach(async () => {
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
    ];
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const card = fakeAccount({
      id: "acc-card",
      type: "credit",
      subtype: "credit card",
      mask: "0000",
    });
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
        fakeTxn({ id: "t-cafe", accountId: card.id, amount: -450, description: "CORNER CAFE" }),
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
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  it("shows no import and no shipments before the first upload", async () => {
    expect(await status()).toEqual({
      lastImport: null,
      lineItems: 0,
      shipments: { linked: 0, waiting: 0, onReviewList: 0, notMatched: 0, giftCard: 0 },
    });
  });

  it("imports Amazon's ZIP file, with the counts, the last import, and the shipment counts", async () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 19);
    const rows = [
      amazonRow(),
      amazonRow({ "Order ID": "111-0000002-0000002", "Ship Date": `${recent}Z` }),
      amazonRow({
        "Order ID": "111-0000003-0000003",
        "Payment Method Type": "Visa - 0000 and Gift Certificate/Card",
      }),
      amazonRow({ "Order Status": "Cancelled" }),
      amazonRow({ Website: "Audible" }),
    ];
    const { import: result, status: after } = await imported(amazonZip(rows));
    expect(result).toEqual({
      importedAt: expect.any(String),
      memberName: "Alice",
      rowsRead: 5,
      added: 3,
      updated: 0,
      unchanged: 0,
      skipped: [
        { reason: "cancelled", rows: 1, firstRow: 5 },
        { reason: "not an amazon.com order", rows: 1, firstRow: 6 },
      ],
    });
    expect(after.lineItems).toBe(3);
    expect(after.shipments).toEqual({
      linked: 0,
      waiting: 1,
      onReviewList: 0,
      notMatched: 1,
      giftCard: 1,
    });
    expect(await status()).toEqual(after);
    expect(await lineItemRows()).toHaveLength(3);
  });

  it("imports the order file alone as text/csv", async () => {
    const { import: result } = await imported(amazonCsv([amazonRow()]), "text/csv; charset=utf-8");
    expect(result.added).toBe(1);
  });

  it("changes nothing when the same file comes twice", async () => {
    const zip = amazonZip([amazonRow(), amazonRow(), amazonRow({ ASIN: "B000000002" })]);
    await imported(zip);
    const before = await lineItemRows();
    const again = await imported(zip);
    expect(again.import).toMatchObject({ rowsRead: 3, added: 0, updated: 0, unchanged: 3 });
    expect(await lineItemRows()).toEqual(before);
  });

  it("updates a known row's file fields from a newer file, and keeps its Category and link, and a Line item the file lacks", async () => {
    const changed: string[][] = [];
    stops.push(
      registerLineItemsImported("linking", async (_db, ids) => void changed.push([...ids])),
    );
    await imported(amazonZip([amazonRow(), amazonRow({ ASIN: "B000000002" })]));
    const txn = await amazonTxnId();
    await sql(
      "UPDATE line_items SET category = 'Home and garden', category_source = 'hand-set', transaction_id = ?, link_kind = 'hand' WHERE product_id = 'B000000001'",
      [txn],
    );
    const newer = amazonZip([
      amazonRow({ "Unit Price": "7.25", "Total Amount": "15.5", "Product Name": "Paper towels" }),
      amazonRow({ "Order ID": "111-0000009-0000009" }),
    ]);
    const { import: result } = await imported(newer);
    expect(result).toMatchObject({ added: 1, updated: 1, unchanged: 0 });
    const [kept] = await sql(
      "SELECT * FROM line_items WHERE product_id = 'B000000001' AND order_id = '111-0000001-0000001'",
    );
    expect(kept).toMatchObject({
      unit_price: 725,
      total: 1550,
      name: "Paper towels",
      category: "Home and garden",
      category_source: "hand-set",
      transaction_id: txn,
      link_kind: "hand",
    });
    expect(await sql("SELECT id FROM line_items WHERE product_id = 'B000000002'")).toHaveLength(1);
    expect(changed).toEqual([[], [txn]]);
  });

  it("refuses a file whose header lacks a column, naming it, and stores nothing", async () => {
    const header = Object.keys(amazonRow()).filter((column) => column !== "Total Amount");
    const res = await upload(amazonCsv([amazonRow()], header), "text/csv");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The file has no "Total Amount" column.' });
    expect(await lineItemRows()).toEqual([]);
    expect((await status()).lastImport).toBeNull();
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to another type, and changes nothing (K1)", async () => {
    await imported(amazonZip([amazonRow()]));
    const before = await test.database.$client.execute("SELECT * FROM line_items");
    const zip = amazonZip([amazonRow({ "Order ID": "111-0000005-0000005" })]);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.upload("/api/amazon/import", zip, ZIP)).status).toBe(401);
    expect((await signedOut.send("DELETE", "/api/amazon")).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.upload("/api/amazon/import", zip, ZIP, { origin })).status).toBe(403);
      expect((await browser.send("DELETE", "/api/amazon", undefined, { origin })).status).toBe(403);
    }
    for (const type of [
      "application/json",
      "multipart/form-data; boundary=x",
      "text/plain",
      undefined,
    ]) {
      expect((await browser.upload("/api/amazon/import", zip, type)).status, type).toBe(415);
    }

    expect((await test.database.$client.execute("SELECT * FROM line_items")).rows).toEqual(
      before.rows,
    );
    expect((await sql("SELECT count(*) AS n FROM line_item_imports"))[0]?.n).toBe(1);
  });

  it("takes 50 MB on the upload only: a larger body answers 413 by its length or by its bytes, and other routes keep the app's limit", async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    expect((await upload(big)).status).toBe(413);
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 52) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    expect((await browser.upload("/api/amazon/import", stream, ZIP)).status).toBe(413);
    expect(sent).toBeLessThan(53);
    const json = JSON.stringify({ words: "x".repeat(200 * 1024) });
    expect((await browser.upload("/api/goals", json, "application/json")).status).toBe(413);
    expect(await lineItemRows()).toEqual([]);
  });

  // A body that waits until the test lets it end, and says when the route starts reading it.
  function heldBody(bytes: Uint8Array) {
    let release = () => {};
    let reading = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading();
        await released;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { stream, release, started };
  }

  it("runs one import or delete at a time: a second, fired while one runs, answers 409 (K18)", async () => {
    const first = heldBody(amazonZip([amazonRow()]));
    const running = browser.upload("/api/amazon/import", first.stream, ZIP);
    await first.started;
    const second = await upload(amazonZip([amazonRow({ "Order ID": "111-0000002-0000002" })]));
    expect(second.status).toBe(409);
    expect((await browser.send("DELETE", "/api/amazon")).status).toBe(409);
    first.release();
    expect((await running).status).toBe(200);
    expect((await sql("SELECT order_id FROM line_items")).map((row) => row.order_id)).toEqual([
      "111-0000001-0000001",
    ]);
    // The place is given back: the next import runs.
    expect((await upload(amazonZip([amazonRow({ ASIN: "B000000002" })]))).status).toBe(200);
  });

  it("lets exactly one of three uploads fired in parallel run, and gives the place back after a refusal (K18)", async () => {
    const bodies = [0, 1, 2].map((i) =>
      heldBody(amazonZip([amazonRow({ "Order ID": `111-000000${i}-0000001` })])),
    );
    const answers = bodies.map((body) => browser.upload("/api/amazon/import", body.stream, ZIP));
    let settled = 0;
    await new Promise<void>((resolve) => {
      for (const answer of answers) {
        void answer.then(() => {
          settled += 1;
          if (settled === 2) resolve();
        });
      }
    });
    for (const body of bodies) body.release();
    const statuses = (await Promise.all(answers)).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await lineItemRows()).toHaveLength(1);

    expect((await upload("not a zip")).status).toBe(400);
    expect((await upload(amazonZip([amazonRow({ ASIN: "B000000003" })]))).status).toBe(200);
  });

  it("deletes every Line item, refused link, Item rule, and import, and sends the linked Transactions back, touching nothing else (K2)", async () => {
    const removed: string[][] = [];
    stops.push(
      registerLineItemsRemoved("Categories", async (_db, ids) => void removed.push([...ids])),
    );
    await imported(amazonZip([amazonRow(), amazonRow({ "Order ID": "111-0000002-0000002" })]));
    const txn = await amazonTxnId();
    await sql(
      "UPDATE line_items SET transaction_id = ?, link_kind = 'app' WHERE order_id = '111-0000001-0000001'",
      [txn],
    );
    await sql(
      "INSERT INTO refused_line_item_links (order_id, ship_time, transaction_id, refused_at) VALUES ('111-0000002-0000002', '2026-05-02T09:15:00Z', ?, '2026-05-04T00:00:00.000Z')",
      [txn],
    );
    await sql(
      "INSERT INTO item_rules (id, product_key, product_id, clean_name, name, category, made_at, made_by) VALUES ('r1', '[\"id\",\"B000000001\"]', 'B000000001', 'paper towels', 'Paper towels', 'Home and garden', '2026-05-04T00:00:00.000Z', ?)",
      [member.id],
    );
    // Data that is not Amazon's stays: another source's Line item, a Category rule, and a refused
    // Refund link.
    await sql(
      "INSERT INTO line_items (id, source, key, order_id, order_date, ship_date, ship_time, name, clean_name, quantity, unit_price, unit_tax, shipping_charge, discounts, total, place, added_at, updated_at) VALUES ('other', 'receipt', 'k', 'r-1', '2026-05-01', '2026-05-01', '2026-05-01T00:00:00Z', 'Receipt line', 'receipt line', 1, 100, 0, 0, 0, 100, 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')",
    );
    await sql(
      "INSERT INTO category_rules (id, merchant_name, merchant_key, category, made_at) VALUES ('c1', 'Corner Cafe', 'cornercafe', 'Restaurants', '2026-05-04T00:00:00.000Z')",
    );
    await sql(
      "INSERT INTO refused_links (kind, transaction_id, other_id, refused_by, refused_at) VALUES ('Refund', ?, 'x', 'Member', '2026-05-04T00:00:00.000Z')",
      [txn],
    );
    const transactionsBefore = await sql("SELECT * FROM transactions ORDER BY id");
    const partsBefore = await sql("SELECT * FROM transaction_parts ORDER BY transaction_id, part");

    const res = await browser.send("DELETE", "/api/amazon");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: AmazonStatusView }).status).toEqual({
      lastImport: null,
      lineItems: 0,
      shipments: { linked: 0, waiting: 0, onReviewList: 0, notMatched: 0, giftCard: 0 },
    });
    expect((await sql("SELECT id FROM line_items")).map((row) => row.id)).toEqual(["other"]);
    expect(await sql("SELECT * FROM refused_line_item_links")).toEqual([]);
    expect(await sql("SELECT * FROM item_rules")).toEqual([]);
    expect(await sql("SELECT * FROM line_item_imports")).toEqual([]);
    expect(await sql("SELECT id FROM category_rules")).toHaveLength(1);
    expect(await sql("SELECT kind FROM refused_links")).toHaveLength(1);
    expect(await sql("SELECT * FROM transactions ORDER BY id")).toEqual(transactionsBefore);
    expect(await sql("SELECT * FROM transaction_parts ORDER BY transaction_id, part")).toEqual(
      partsBefore,
    );
    expect(removed).toEqual([[txn]]);
  });

  it("sends a Transaction split from its Line items back to one part after Delete all (K5)", async () => {
    stops.push(
      startCategorization({ database: test.database }).stop,
      startLineItemCategories({ database: test.database }).stop,
    );
    await imported(
      amazonZip([
        amazonRow(),
        amazonRow({ ASIN: "B000000002", "Product Name": "Dog leash, 6 feet" }),
      ]),
    );
    const txn = await amazonTxnId();
    await sql(
      "UPDATE line_items SET transaction_id = ?, link_kind = 'app', category = CASE WHEN product_id = 'B000000002' THEN 'Pets' ELSE 'Home and garden' END, category_source = 'hand-set'",
      [txn],
    );
    await followUpAgain(test.database, [txn]);
    await runFollowUp();
    const partsOf = () =>
      sql(
        "SELECT amount, category_source AS source FROM transaction_parts WHERE transaction_id = ? ORDER BY part",
        [txn],
      );
    expect((await partsOf()).map((part) => part.source)).toEqual(["Line items", "Line items"]);

    expect((await browser.send("DELETE", "/api/amazon")).status).toBe(200);
    await runFollowUp();
    await lineItemCategoriesSettled();
    const parts = await partsOf();
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ amount: -1350 });
    expect(parts[0]?.source).not.toBe("Line items");
  });

  it("unlinks Line items and drops refused links when the Connection's history is deleted, and keeps imports when their Member is removed (K6)", async () => {
    await imported(amazonZip([amazonRow()]));
    const txn = await amazonTxnId();
    await sql("UPDATE line_items SET transaction_id = ?, link_kind = 'app'", [txn]);
    await sql(
      "INSERT INTO refused_line_item_links (order_id, ship_time, transaction_id, member_id, refused_at) VALUES ('111-0000001-0000001', '2026-05-02T09:15:00Z', ?, ?, '2026-05-04T00:00:00.000Z')",
      [txn, member.id],
    );
    await sql(
      "INSERT INTO item_rules (id, product_key, product_id, clean_name, name, category, made_at, made_by) VALUES ('r1', 'k', 'B000000001', 'paper towels', 'Paper towels', 'Home and garden', '2026-05-04T00:00:00.000Z', ?)",
      [member.id],
    );

    await markConnectionRemoved(test.database, connectionId);
    expect(await deleteRemovedConnection(test.database, connectionId)).toBeDefined();
    expect(await sql("SELECT id FROM transactions")).toEqual([]);
    const [item] = await sql("SELECT transaction_id FROM line_items");
    expect(item?.transaction_id).toBeNull();
    expect(await sql("SELECT * FROM refused_line_item_links")).toEqual([]);

    const other = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    const second = new TestBrowser(app, APP_URL, "192.168.1.22");
    await second.signIn(other);
    expect(await removeMember(test.database, member.id, new Date())).toBe("removed");
    expect(await sql("SELECT made_by FROM item_rules")).toEqual([
      expect.objectContaining({ made_by: null }),
    ]);
    const after = (await (await second.get("/api/amazon")).json()) as AmazonStatusView;
    expect(after.lastImport?.memberName).toBeNull();
  });

  it("puts no row's content in a log line, an error, or an answer, even when storing fails (K8)", async () => {
    const marker = "MARKER-amazon-5c1e";
    const rows: AmazonRow[] = [
      amazonRow({ "Product Name": marker }),
      amazonRow({ "Product Name": marker, "Unit Price": marker }),
      amazonRow({ "Product Name": marker, "Order ID": `${marker}-1` }),
    ];
    const skipped = await upload(amazonCsv(rows), "text/csv");
    expect(await skipped.text()).not.toContain(marker);
    const header = await upload(amazonCsv(rows, [marker]), "text/csv");
    expect(header.status).toBe(400);
    expect(await header.text()).not.toContain(marker);

    await sql(
      "CREATE TRIGGER line_items_refuse BEFORE INSERT ON line_items BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const failed = await upload(
      amazonCsv([amazonRow({ "Product Name": marker, ASIN: "B000000009" })]),
      "text/csv",
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(marker);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(marker);
    expect(lines.join("\n")).toContain("The Amazon import could not store its Line items");
  });

  it("shows each Transaction's Line item count on its row, and its Line items on its detail view, in one query per page", async () => {
    await imported(
      amazonZip([
        amazonRow(),
        amazonRow(),
        amazonRow({ ASIN: "B000000002", "Product Name": "Hand soap" }),
      ]),
    );
    const txn = await amazonTxnId();
    await sql(
      "UPDATE line_items SET transaction_id = ?, link_kind = 'app', category = 'Home and garden'",
      [txn],
    );
    const list = (await (
      await browser.get("/api/transactions?limit=50")
    ).json()) as TransactionListView;
    expect(
      Object.fromEntries(list.transactions.map((row) => [row.description, row.itemCount])),
    ).toEqual({
      "AMAZON MKTPL*EXAMPLE": 3,
      "CORNER CAFE": 0,
    });
    const detail = (await (await browser.get(`/api/transactions/${txn}`)).json()) as {
      transaction: { itemCount: number };
    };
    expect(detail.transaction.itemCount).toBe(3);
    const { lineItems } = (await (
      await browser.get(`/api/transactions/${txn}/line-items`)
    ).json()) as {
      lineItems: LineItemView[];
    };
    expect(lineItems.map(({ id: _id, ...item }) => item)).toEqual(
      [
        {
          name: "Paper towels, 12 rolls",
          quantity: 2,
          total: 1350,
          category: "Home and garden",
          orderId: "111-0000001-0000001",
          orderDate: "2026-05-01",
          linkKind: "app",
          aiUnsure: false,
        },
        {
          name: "Paper towels, 12 rolls",
          quantity: 2,
          total: 1350,
          category: "Home and garden",
          orderId: "111-0000001-0000001",
          orderDate: "2026-05-01",
          linkKind: "app",
          aiUnsure: false,
        },
        {
          name: "Hand soap",
          quantity: 2,
          total: 1350,
          category: "Home and garden",
          orderId: "111-0000001-0000001",
          orderDate: "2026-05-01",
          linkKind: "app",
          aiUnsure: false,
        },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it("counts Line items the same way for a page of Transactions and for a list of every one", async () => {
    await imported(
      amazonZip([amazonRow(), amazonRow({ ASIN: "B000000002", "Product Name": "Hand soap" })]),
    );
    const txn = await amazonTxnId();
    await sql("UPDATE line_items SET transaction_id = ?, link_kind = 'app'", [txn]);
    const others = Array.from({ length: 600 }, (_, index) => `not-a-transaction-${index}`);

    const short = await countLineItemsOf(test.database, [txn, "not-a-transaction"]);
    const long = await countLineItemsOf(test.database, [txn, ...others]);

    expect([...short]).toEqual([[txn, 2]]);
    expect([...long]).toEqual([[txn, 2]]);
    expect([...(await countLineItemsOf(test.database, others))]).toEqual([]);
  });

  it("exports line-items.csv and item-rules.csv once there are Line items, with the card's last 4 digits and CSV escaping", async () => {
    const before = readZip(
      new Uint8Array(await (await browser.post("/api/export", {})).arrayBuffer()),
    );
    expect([...before.keys()]).not.toContain("line-items.csv");

    await imported(amazonZip([amazonRow({ "Product Name": '=HYPERLINK("x"), big' })]));
    await sql(
      "INSERT INTO item_rules (id, product_key, product_id, clean_name, name, category, made_at, made_by) VALUES ('r1', 'k', 'B000000001', 'paper towels', 'Paper towels', 'Home and garden', '2026-05-04T00:00:00.000Z', ?)",
      [member.id],
    );
    const files = readZip(
      new Uint8Array(await (await browser.post("/api/export", {})).arrayBuffer()),
    );
    expect([...files.keys()]).toEqual([
      "transactions.csv",
      "accounts.csv",
      "budgets.csv",
      "goals.csv",
      "category-rules.csv",
      "line-items.csv",
      "item-rules.csv",
      "data.json",
    ]);
    const text = (name: string) => new TextDecoder().decode(files.get(name));
    const [itemHeader, itemLine] = text("line-items.csv").split("\r\n");
    expect(itemHeader).toBe(
      "id,source,order_id,order_date,ship_date,product_id,name,quantity,unit_price,unit_tax,shipping,discounts,total,last_4,category,category_group,transaction_id,link_kind",
    );
    expect(itemLine).toMatch(
      /^[0-9a-f-]{36},amazon,111-0000001-0000001,2026-05-01,2026-05-02,B000000001,"'=HYPERLINK\(""x""\), big",2,6\.25,0\.50,0\.00,0\.00,13\.50,0000,,,,$/,
    );
    expect(text("item-rules.csv").split("\r\n").slice(0, 2)).toEqual([
      "id,product_id,name,category,category_group,made_on,made_by",
      "r1,B000000001,Paper towels,Home and garden,Shopping,2026-05-04,Alice",
    ]);
    const data = JSON.parse(text("data.json")) as {
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(data.tables.line_items?.[0]).toMatchObject({ card_last4: "0000", total: 1350 });
    expect(data.tables.line_items?.[0]).not.toHaveProperty("key");
    expect(data.tables.item_rules).toHaveLength(1);
    expect(data.tables.line_item_imports).toHaveLength(1);
  });
});
