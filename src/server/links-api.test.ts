import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { TransactionDetailView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Hand links and Undo (spec 03, Undo and hand links), through the app's HTTP interface, on
// Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-links-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the link routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];
  // Each Transaction's ID in app.db, by its provider ID.
  let ids: Map<string, string>;
  let fake: FakeBankAdapter;
  let connectionId: string;
  const id = (providerId: string) => ids.get(providerId) ?? "none";

  const checking = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
  const savings = fakeAccount({ id: "acc-savings", subtype: "savings", mask: "2222" });
  const sync = async () => {
    await syncConnection(connectionId, () => new Date("2026-10-20T15:00:00.000Z"));
    await runFollowUp();
  };

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      // The follow-up job runs at once.
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    fake.addPages(BANK, {
      accounts: [checking, savings],
      added: [
        fakeTxn({
          id: "save-out",
          accountId: checking.id,
          amount: -50_000,
          postedDate: "2026-10-03",
          description: "TRANSFER TO SAVINGS 2222",
        }),
        fakeTxn({ id: "save-in", accountId: savings.id, amount: 50_000, postedDate: "2026-10-03" }),
        fakeTxn({ id: "shoes", accountId: checking.id, amount: -8_000, postedDate: "2026-10-04" }),
        fakeTxn({ id: "back", accountId: checking.id, amount: 3_000, postedDate: "2026-10-09" }),
        fakeTxn({
          id: "lender",
          accountId: checking.id,
          amount: -40_000,
          postedDate: "2026-10-10",
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
    await sync();
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const detail = async (providerId: string) =>
    (await (
      await browser.get(`/api/transactions/${id(providerId)}`)
    ).json()) as TransactionDetailView;
  const count = async (table: string) =>
    Number((await test.database.$client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
  const addManualLoan = () =>
    test.database.$client.execute(
      `INSERT INTO household_accounts (id, kind, subtype, name, institution_name)
       VALUES ('manual-loan', 'loan', 'personal', 'Lakeside Credit', 'Lakeside Credit')`,
    );

  it("undoes the app's Transfer pair, and never makes it again", async () => {
    const linkId = (await detail("save-in")).transferLink?.id ?? "";
    expect(linkId).not.toBe("");

    const res = await browser.send("DELETE", `/api/links/${linkId}`);

    expect(res.status).toBe(200);
    const after = await detail("save-in");
    expect(after.transferLink).toBeNull();
    expect(after.decision?.parts.map((part) => part.type)).toEqual(["Income"]);
    fake.addPages(BANK, {
      changed: [
        fakeTxn({ id: "save-in", accountId: savings.id, amount: 50_000, postedDate: "2026-10-03" }),
      ],
    });
    await sync();
    expect((await detail("save-in")).transferLink).toBeNull();
    expect((await browser.send("DELETE", `/api/links/${linkId}`)).status).toBe(404);
  });

  it("makes a Refund link by hand, with its evidence, and undoes it", async () => {
    const res = await browser.send("POST", "/api/links", {
      kind: "Refund",
      transactionId: id("back"),
      spendingTransactionId: id("shoes"),
    });

    expect(res.status).toBe(200);
    const { linkId } = (await res.json()) as { linkId: string };
    const evidence = {
      id: linkId,
      kind: "Refund",
      loanAccountId: null,
      tier: "Unclear",
      signals: [],
      aiAnswer: null,
      aiConfidence: null,
      madeBy: "Member",
    };
    expect((await detail("back")).otherLinks).toEqual([
      { ...evidence, otherTransactionId: id("shoes") },
    ]);
    expect((await detail("shoes")).otherLinks).toEqual([
      { ...evidence, otherTransactionId: id("back") },
    ]);

    // A sync that changes the Spending keeps the link while it passes its hard filters.
    fake.addPages(BANK, {
      changed: [
        fakeTxn({
          id: "shoes",
          accountId: checking.id,
          amount: -8_000,
          postedDate: "2026-10-04",
          description: "SHOE STORE",
        }),
      ],
    });
    await sync();
    expect((await detail("back")).otherLinks).toHaveLength(1);

    expect((await browser.send("DELETE", `/api/links/${linkId}`)).status).toBe(200);
    expect((await detail("back")).otherLinks).toEqual([]);
    expect(await count("refused_links")).toBe(1);
  });

  it("makes a Transfer pair by hand in place of the app's, which ends", async () => {
    const res = await browser.send("POST", "/api/links", {
      kind: "Transfer",
      outTransactionId: id("save-out"),
      inTransactionId: id("save-in"),
    });

    expect(res.status).toBe(200);
    expect((await detail("save-in")).transferLink).toMatchObject({ madeBy: "Member" });
    expect((await detail("save-in")).decision?.step).toBe("2");
  });

  it("links a payment to a Manual loan by hand, and ends the link when the provider removes it", async () => {
    await addManualLoan();

    const res = await browser.send("POST", "/api/links", {
      kind: "loan",
      transactionId: id("lender"),
      loanAccountId: "manual-loan",
    });

    expect(res.status).toBe(200);
    const lender = await detail("lender");
    expect(lender.otherLinks).toMatchObject([
      { kind: "loan", loanAccountId: "manual-loan", madeBy: "Member" },
    ]);
    expect(lender.decision?.step).toBe("2");

    fake.addPages(BANK, { removed: [{ id: "lender" }] });
    await sync();
    expect(await count("loan_links")).toBe(0);
  });

  it("refuses a link that fails its hard filters, and a loan that is not a Manual loan", async () => {
    await addManualLoan();
    const post = (body: unknown) => browser.send("POST", "/api/links", body);

    // A Refund must be money in, after the Spending it reduces.
    const backwards = await post({
      kind: "Refund",
      transactionId: id("shoes"),
      spendingTransactionId: id("back"),
    });
    expect(backwards.status).toBe(400);
    // An Account with no Connection that is not a loan takes no loan link.
    const savingsRow = await test.database.$client.execute(
      "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-savings'",
    );
    const savingsId = String(savingsRow.rows[0]?.id);
    await test.database.$client.execute({
      sql: "UPDATE household_accounts SET connection_id = NULL WHERE id = ?",
      args: [savingsId],
    });
    expect(
      (await post({ kind: "loan", transactionId: id("lender"), loanAccountId: savingsId })).status,
    ).toBe(404);
    expect(
      (await post({ kind: "loan", transactionId: "no-such-id", loanAccountId: "manual-loan" }))
        .status,
    ).toBe(404);
    expect((await post({ kind: "Something", transactionId: id("lender") })).status).toBe(400);
    expect(await count("spending_links")).toBe(0);
    expect(await count("loan_links")).toBe(0);
  });

  it("refuses a hidden Transaction and a connected loan, and never edits a connected loan as a Manual loan", async () => {
    await addManualLoan();
    fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: "acc-car", type: "loan", subtype: "auto", currentBalance: -900_000 }),
      ],
      removed: [{ id: "shoes" }],
    });
    await sync();
    const car = await test.database.$client.execute(
      "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-car'",
    );
    const carId = String(car.rows[0]?.id);
    const post = (body: unknown) => browser.send("POST", "/api/links", body);

    // The Spending no longer shows.
    expect(
      (
        await post({
          kind: "Refund",
          transactionId: id("back"),
          spendingTransactionId: id("shoes"),
        })
      ).status,
    ).toBe(404);
    // A connected loan's payments link by pairing, never by hand.
    expect(
      (await post({ kind: "loan", transactionId: id("lender"), loanAccountId: carId })).status,
    ).toBe(404);
    expect(
      (
        await browser.send("PUT", `/api/manual-loans/${carId}`, {
          lender: "Lakeside Credit",
          kind: "car",
          balance: 1_000,
          balanceDate: "2026-10-01",
          apr: 5,
          regularPayment: null,
          escrow: null,
          loanType: null,
        })
      ).status,
    ).toBe(404);

    expect(await count("spending_links")).toBe(0);
    expect(await count("loan_links")).toBe(0);
    expect(await count("typed_balances")).toBe(0);
    const unchanged = await test.database.$client.execute({
      sql: "SELECT name, member_apr FROM household_accounts WHERE id = ?",
      args: [carId],
    });
    expect({ ...unchanged.rows[0] }).toEqual({ name: "Account acc-car", member_apr: null });
  });

  it("refuses a Refund, Reimbursement, or loan link on a pending Transaction until it posts", async () => {
    await addManualLoan();
    fake.addPages(BANK, {
      added: [
        fakeTxn({
          id: "pending-back",
          accountId: checking.id,
          amount: 2_000,
          postedDate: "2026-10-12",
          pending: true,
        }),
        fakeTxn({
          id: "pending-shoes",
          accountId: checking.id,
          amount: -6_000,
          postedDate: "2026-10-11",
          pending: true,
        }),
        fakeTxn({
          id: "pending-lender",
          accountId: checking.id,
          amount: -40_000,
          postedDate: "2026-10-12",
          pending: true,
        }),
      ],
    });
    await sync();
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
    const post = (body: unknown) => browser.send("POST", "/api/links", body);

    for (const kind of ["Refund", "Reimbursement"]) {
      for (const [money, spent] of [
        ["pending-back", "shoes"],
        ["back", "pending-shoes"],
      ]) {
        const answer = await post({
          kind,
          transactionId: id(money ?? ""),
          spendingTransactionId: id(spent ?? ""),
        });
        expect(answer.status).toBe(400);
        expect(await answer.json()).toEqual({
          error: "A pending Transaction links once it posts.",
        });
      }
    }
    const loan = await post({
      kind: "loan",
      transactionId: id("pending-lender"),
      loanAccountId: "manual-loan",
    });
    expect(loan.status).toBe(400);
    expect(await count("spending_links")).toBe(0);
    expect(await count("loan_links")).toBe(0);

    // The posted ones link.
    expect(
      (
        await post({
          kind: "Refund",
          transactionId: id("back"),
          spendingTransactionId: id("shoes"),
        })
      ).status,
    ).toBe(200);
    expect(
      (await post({ kind: "loan", transactionId: id("lender"), loanAccountId: "manual-loan" }))
        .status,
    ).toBe(200);
  });

  it("answers 401 with no session, 403 from another origin, and 415 to a body that is not JSON, and links nothing", async () => {
    const body = {
      kind: "Refund",
      transactionId: id("back"),
      spendingTransactionId: id("shoes"),
    };
    const linkId = (await detail("save-in")).transferLink?.id ?? "";
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.send("POST", "/api/links", body)).status).toBe(401);
    expect((await stranger.send("DELETE", `/api/links/${linkId}`)).status).toBe(401);
    for (const origin of [{ origin: "http://evil.example" }, { origin: undefined }]) {
      expect((await browser.send("POST", "/api/links", body, origin)).status).toBe(403);
      expect((await browser.send("DELETE", `/api/links/${linkId}`, undefined, origin)).status).toBe(
        403,
      );
    }
    expect(
      (await browser.send("POST", "/api/links", body, { "content-type": "text/plain" })).status,
    ).toBe(415);

    expect(await count("spending_links")).toBe(0);
    expect(await count("refused_transfer_links")).toBe(0);
    expect((await detail("save-in")).transferLink?.id).toBe(linkId);
  });

  describe("Manual loans", () => {
    const car = {
      lender: "Lakeside Auto",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-09-01",
      apr: 7.3,
      regularPayment: 40_000,
    };

    it("adds, lists, and edits a Manual loan, and links a payment to it", async () => {
      const added = await browser.send("POST", "/api/manual-loans", car);

      expect(added.status).toBe(200);
      const { loan } = (await added.json()) as { loan: { id: string } };
      expect(loan).toEqual({
        ...car,
        id: expect.any(String),
        escrow: null,
        loanType: "purchase loan",
        setBy: "app",
      });
      const edited = await browser.send("PUT", `/api/manual-loans/${loan.id}`, {
        ...car,
        balance: 950_000,
        balanceDate: "2026-10-01",
        loanType: "cash loan",
      });
      expect(edited.status).toBe(200);
      expect(await (await browser.get("/api/manual-loans")).json()).toEqual({
        loans: [
          {
            ...car,
            id: loan.id,
            balance: 950_000,
            balanceDate: "2026-10-01",
            escrow: null,
            loanType: "cash loan",
            setBy: "Member",
          },
        ],
      });

      const linked = await browser.send("POST", "/api/links", {
        kind: "loan",
        transactionId: id("lender"),
        loanAccountId: loan.id,
      });
      expect(linked.status).toBe(200);
      // 9 days on $9,500 at 7.3%: $17.10 of interest; the rest goes to the Cash loan.
      expect((await detail("lender")).decision?.parts).toEqual([
        { type: "Spending", amount: -1_710, category: "Interest and fees" },
        { type: "Transfer", amount: -38_290, category: null },
      ]);
    });

    it("refuses a credit card, a line of credit, escrow off a mortgage, and missing fields", async () => {
      for (const kind of ["credit card", "line of credit"]) {
        const res = await browser.send("POST", "/api/manual-loans", { ...car, kind });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error:
            "A credit card or a line of credit can't be a Manual loan: its balance moves with purchases the app cannot see.",
        });
      }
      const escrow = await browser.send("POST", "/api/manual-loans", { ...car, escrow: 10_000 });
      expect(await escrow.json()).toEqual({ error: "Escrow is for mortgages only." });
      for (const body of [
        { ...car, lender: " " },
        { ...car, balanceDate: "2026-02-30" },
        { ...car, apr: 101 },
        { ...car, balance: 12.5 },
        { ...car, balance: undefined },
      ]) {
        expect((await browser.send("POST", "/api/manual-loans", body)).status).toBe(400);
      }
      expect((await browser.send("PUT", "/api/manual-loans/no-such-id", car)).status).toBe(404);
      // A connected Account is never edited as a Manual loan.
      expect((await browser.send("PUT", `/api/manual-loans/${id("lender")}`, car)).status).toBe(
        404,
      );
      const checking = await test.database.$client.execute(
        "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-checking'",
      );
      expect(
        (await browser.send("PUT", `/api/manual-loans/${checking.rows[0]?.id}`, car)).status,
      ).toBe(404);
      expect(await count("household_accounts WHERE kind = 'loan'")).toBe(0);
      expect(await count("typed_balances")).toBe(0);
    });

    it("answers 401 with no session, 403 from another origin, and 415 to a body that is not JSON, and changes no loan", async () => {
      const added = await browser.send("POST", "/api/manual-loans", car);
      const { loan } = (await added.json()) as { loan: { id: string } };
      const path = `/api/manual-loans/${loan.id}`;
      const stored = async () => {
        const rows = await test.database.$client.execute({
          sql: `SELECT a.name, a.subtype, a.member_apr, a.loan_type, b.date, b.balance
                FROM household_accounts a JOIN typed_balances b ON b.account_id = a.id
                WHERE a.id = ? ORDER BY b.date`,
          args: [loan.id],
        });
        return rows.rows.map((row) => ({ ...row }));
      };
      const before = await stored();
      expect(before).toHaveLength(1);
      // Each refused edit would change every field.
      const edit = {
        lender: "Other Lender",
        kind: "personal",
        balance: 1,
        balanceDate: "2026-10-15",
        apr: 1,
        regularPayment: null,
        escrow: null,
        loanType: "cash loan",
      };
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

      expect((await stranger.get("/api/manual-loans")).status).toBe(401);
      expect((await stranger.send("POST", "/api/manual-loans", car)).status).toBe(401);
      expect((await stranger.send("PUT", path, edit)).status).toBe(401);
      for (const origin of [{ origin: "http://evil.example" }, { origin: undefined }]) {
        expect((await browser.send("POST", "/api/manual-loans", car, origin)).status).toBe(403);
        expect((await browser.send("PUT", path, edit, origin)).status).toBe(403);
      }
      expect(
        (await browser.send("POST", "/api/manual-loans", car, { "content-type": "text/plain" }))
          .status,
      ).toBe(415);
      expect((await browser.send("PUT", path, edit, { "content-type": "text/plain" })).status).toBe(
        415,
      );

      expect(await count("household_accounts WHERE kind = 'loan'")).toBe(1);
      expect(await stored()).toEqual(before);
      // The same edit, sent as it should be, changes it.
      expect((await browser.send("PUT", path, edit)).status).toBe(200);
      expect(await stored()).not.toEqual(before);
    });
  });
});
