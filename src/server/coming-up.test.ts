import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection, type TxnRecord } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addConnection,
  addManualLoan as addStoredManualLoan,
  listConnections,
  listDueAccounts,
  listTransactions,
  markSetupStep,
} from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { comingUpRow, loadDashboard, lowestLine } from "../web/dashboard.ts";
import { createApp } from "./app.ts";
import type { AccountView } from "./bank-views.ts";
import type { ComingUpView } from "./coming-up-views.ts";
import type { PaydayView, RecurringChargeView } from "./recurring-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// "Coming up" on the demo household (spec 07, 6. Coming up), through the app's HTTP interface on a
// fake clock: Nov 7, 2026, a week after the demo history ends. The demo cards' statements were
// issued Sep 30. Capital One and Chase paid theirs in October; Synchrony paid $200 of it.

const APP_URL = "http://nas.local:8080";
// Noon in New York, the demo Household's time zone, on Nov 7, 2026.
const NOW = new Date("2026-11-07T17:00:00.000Z");

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-coming-up-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Coming up on the demo household", () => {
  let test: TestAuth;
  let browser: TestBrowser;
  let app: ReturnType<typeof createApp>;
  let fake: FakeBankAdapter;
  let stops: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
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
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
      startRecurringCharges({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
      member.id,
    );
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();

    // The page's requests go to the app as the signed-in browser.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return browser.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body);
    });
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    test.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const comingUp = async () => (await loadDashboard()).comingUp;
  const at = (now: string) => vi.setSystemTime(new Date(now));
  const shape = (view: ComingUpView) =>
    view.rows.map(({ date, kind, what, onCard }) => ({ date, kind, what, onCard }));
  const ofKind = (view: ComingUpView, kind: ComingUpView["rows"][number]["kind"]) =>
    view.rows.filter((row) => row.kind === kind);

  // Adds these Transactions to a demo bank's next page, syncs it, and runs the follow-up job.
  async function addToBank(bankId: string, added: TxnRecord[]) {
    fake.addPages(bankId, { added });
    const connection = (await listConnections(test.database)).find(
      (each) => each.bankId === bankId,
    );
    await syncConnection(connection?.id ?? "");
    await runFollowUp();
  }

  // A posted line of money out on the demo checking Account.
  const checkingLine = (id: string, postedDate: string, amount: number, merchant: string) =>
    fakeTxn({
      id,
      accountId: "demo-ally-checking",
      amount,
      postedDate,
      description: `${merchant.toUpperCase()} ${id}`,
      merchantName: merchant,
    });

  it("answers 401 with no session", async () => {
    const answer = await new TestBrowser(app, APP_URL, "192.168.1.21").get("/api/coming-up");
    expect(answer.status).toBe(401);
    expect(await answer.text()).not.toContain("rows");
  });

  it("lists what is due from tomorrow to 14 days from today, in date order, with checking after each row", async () => {
    const view = await comingUp();
    const { charges } = (await (await browser.get("/api/recurring-charges")).json()) as {
      charges: RecurringChargeView[];
    };
    const { paydays } = (await (await browser.get("/api/paydays")).json()) as {
      paydays: PaydayView[];
    };
    const { accounts } = (await (await browser.get("/api/accounts")).json()) as {
      accounts: AccountView[];
    };

    expect(view).toMatchObject({ from: "2026-11-08", to: "2026-11-21" });
    expect(shape(view)).toEqual([
      { date: "2026-11-08", kind: "Recurring charge", what: "Streamflix", onCard: true },
      {
        date: "2026-11-10",
        kind: "Recurring charge",
        what: "City of Mapleford Utilities",
        onCard: false,
      },
      { date: "2026-11-12", kind: "Recurring charge", what: "Brightwave Wireless", onCard: false },
      { date: "2026-11-13", kind: "payday", what: "Northwind Logistics", onCard: false },
      { date: "2026-11-15", kind: "loan payment", what: "Personal Loan payment", onCard: false },
      { date: "2026-11-15", kind: "payday", what: "Harbor Dental Group", onCard: false },
      { date: "2026-11-18", kind: "card payment", what: "Home Store Card payment", onCard: false },
      { date: "2026-11-18", kind: "Recurring charge", what: "Tunebox", onCard: true },
    ]);
    // Each Recurring charge at its latest amount, and each payday at its series' latest amount.
    for (const row of ofKind(view, "Recurring charge")) {
      const charge = charges.find((each) => each.merchantName === row.what);
      expect(row.amount).toBe(-(charge?.latestAmount ?? 0));
    }
    for (const row of ofKind(view, "payday")) {
      expect(row.amount).toBe(paydays.find((each) => each.payerName === row.what)?.amount);
    }

    // Checking starts from the connected checking Account's current balance. Each row that is not
    // on a card moves it.
    const checking = accounts
      .filter((account) => account.kind === "depository" && account.subtype === "checking")
      .reduce((sum, account) => sum + (account.currentBalance ?? 0), 0);
    expect(view.checking).toBe(checking);
    let balance = checking;
    for (const row of view.rows.filter((each) => !each.onCard)) {
      balance += row.amount;
      expect(row.checkingAfter, row.what).toBe(balance);
    }
    // The big number is every outgoing row, those on a card too.
    expect(view.outgoing).toBe(
      -view.rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
    );

    // A payday shows a "+" amount and money out a "−" one, in cents.
    const rows = view.rows.map((row) => comingUpRow(row, "2026-11-07"));
    expect(rows[3]).toEqual({
      date: "Nov 13",
      what: "Northwind Logistics payday",
      amount: "+$1,865.90",
      checkingAfter: expect.stringMatching(/^\$[\d,]+\.\d\d$/),
      payday: true,
    });
    expect(rows[1]?.amount).toMatch(/^−\$\d+\.\d\d$/);
  });

  it("runs from tomorrow, not today, to 14 days from today", async () => {
    const dates = async () => (await comingUp()).rows.map((row) => `${row.date} ${row.what}`);

    // Nov 13 is tomorrow on Nov 12, and today on Nov 13.
    at("2026-11-12T17:00:00.000Z");
    expect(await dates()).toContain("2026-11-13 Northwind Logistics");
    at("2026-11-13T17:00:00.000Z");
    expect((await comingUp()).from).toBe("2026-11-14");
    expect(await dates()).not.toContain("2026-11-13 Northwind Logistics");

    // Nov 18 is 14 days from Nov 4, and 15 days from Nov 3.
    at("2026-11-04T17:00:00.000Z");
    expect((await comingUp()).to).toBe("2026-11-18");
    expect(await dates()).toEqual(
      expect.arrayContaining(["2026-11-18 Home Store Card payment", "2026-11-18 Tunebox"]),
    );
    at("2026-11-03T17:00:00.000Z");
    expect((await comingUp()).to).toBe("2026-11-17");
    expect((await dates()).filter((row) => row.startsWith("2026-11-18"))).toEqual([]);
  });

  it("shows no row for a card whose statement balance is already paid", async () => {
    // On Nov 8 every demo card's payment is due in the window, and each owes a statement balance.
    at("2026-11-08T17:00:00.000Z");
    const cards = (await listDueAccounts(test.database)).filter(
      (account) => account.kind === "credit",
    );
    expect(cards.map(({ name, paymentDueDate }) => [name, paymentDueDate])).toEqual([
      ["Chase Card", "2026-11-22"],
      ["Home Store Card", "2026-11-18"],
      ["Rewards Card", "2026-11-20"],
    ]);
    for (const card of cards) {
      expect(card.statementBalance ?? 0).toBeLessThan(0);
      expect(card.statementIssueDate).toBe("2026-09-30");
    }

    // Only Synchrony's Home Store Card, whose payments did not reach it, at its statement balance.
    const synchrony = cards.find((card) => card.name === "Home Store Card");
    expect(ofKind(await comingUp(), "card payment")).toEqual([
      expect.objectContaining({
        date: "2026-11-18",
        what: "Home Store Card payment",
        amount: synchrony?.statementBalance,
      }),
    ]);

    // An excluded card owes nothing here.
    const excluded = await browser.send("PUT", `/api/accounts/${synchrony?.id}/exclude`, {
      excluded: true,
    });
    expect(excluded.status).toBe(200);
    expect(ofKind(await comingUp(), "card payment")).toEqual([]);
  });

  it('shows "on card" for a Recurring charge on a card, which leaves checking where it was', async () => {
    const view = await comingUp();
    const onCard = view.rows.filter((row) => row.onCard);

    expect(onCard.map((row) => row.what)).toEqual(["Streamflix", "Tunebox"]);
    for (const row of onCard) {
      expect(row.checkingAfter).toBeNull();
      expect(comingUpRow(row, "2026-11-07").checkingAfter).toBe("on card");
    }
    // Streamflix comes first, so checking after the next row is the starting balance less that
    // row alone. The card's payment due moves checking.
    const [, utilities] = view.rows;
    expect(utilities?.checkingAfter).toBe((view.checking ?? 0) + (utilities?.amount ?? 0));
    expect(ofKind(view, "card payment")[0]?.checkingAfter).not.toBeNull();
  });

  it("names the lowest checking balance and its day", async () => {
    const view = await comingUp();
    const afters = view.rows.flatMap((row) => row.checkingAfter ?? []);

    expect(view.lowest?.amount).toBe(Math.min(view.checking ?? 0, ...afters));
    expect(view.lowest?.date).toBe("2026-11-12");
    expect(lowestLine(view, "2026-11-07")).toBe("Lowest checking balance: $18,756 on Nov 12");

    // A charge after the last payday, larger than the balance, takes the lowest point to its day, below $0.
    await addToBank("fake-ally", [
      checkingLine("tuition-8", "2026-08-19", -2_500_000, "Maple Academy"),
      checkingLine("tuition-9", "2026-09-19", -2_500_000, "Maple Academy"),
      checkingLine("tuition-10", "2026-10-19", -2_500_000, "Maple Academy"),
    ]);
    const later = await comingUp();
    const tuition = later.rows.find((row) => row.what === "Maple Academy");
    expect(tuition?.date).toBe("2026-11-19");
    expect(later.lowest).toEqual({ amount: tuition?.checkingAfter, date: "2026-11-19" });
    expect(later.lowest?.amount).toBeLessThan(0);
    expect(lowestLine(later, "2026-11-07")).toMatch(
      /^Lowest checking balance: −\$[\d,]+ on Nov 19$/,
    );
  });

  it("shows only Recurring charges: a 2-Transaction series never shows", async () => {
    const gym = async () => (await comingUp()).rows.filter((row) => row.what === "Solo Gym");

    await addToBank("fake-ally", [
      checkingLine("gym-9", "2026-09-09", -4_500, "Solo Gym"),
      checkingLine("gym-10", "2026-10-09", -4_500, "Solo Gym"),
    ]);
    expect(await gym()).toEqual([]);

    await addToBank("fake-ally", [checkingLine("gym-8", "2026-08-09", -4_500, "Solo Gym")]);
    expect(await gym()).toEqual([
      expect.objectContaining({ date: "2026-11-09", kind: "Recurring charge", amount: -4_500 }),
    ]);
  });

  it("finds the demo's yearly Recurring charges only where no other Transactions fall between", async () => {
    const { charges } = (await (await browser.get("/api/recurring-charges")).json()) as {
      charges: RecurringChargeView[];
    };
    // Blue Door Cafe and HomeWorks Supply are shops the Household visits all year, and the card's
    // interest is in Interest and fees. Alex Rivera has only 2 other payments between the yearly
    // pair, so by spec 06 that pair is a yearly series.
    expect(
      charges
        .filter((charge) => charge.schedule === "yearly")
        .map((charge) => charge.merchantName)
        .sort(),
    ).toEqual(["Alex Rivera", "ShopMart Plus"]);
    expect(charges.map((charge) => charge.merchantName)).not.toContain(
      "Interest Charge On Purchases",
    );
  });

  it("shows a Manual loan's regular payment on the day of the month of its last linked payment", async () => {
    await addToBank("fake-ally", [
      checkingLine("loan-pmt", "2026-10-17", -38_500, "Online Payment"),
    ]);
    const body = {
      lender: "Lakeside Auto",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-10-01",
      apr: 7.3,
      regularPayment: 40_000,
    };
    const added = await browser.post("/api/manual-loans", body);
    const { loan } = (await added.json()) as { loan: { id: string } };
    // A second loan with a regular payment but no linked payment has no usual day.
    const other = await browser.post("/api/manual-loans", { ...body, lender: "Riverside Credit" });
    expect(other.status).toBe(200);

    const lakeside = async () =>
      ofKind(await comingUp(), "loan payment").filter(
        (row) => row.what !== "Personal Loan payment",
      );
    expect(await lakeside()).toEqual([]);

    const payment = (await listTransactions(test.database)).find(
      (each) => each.description === "ONLINE PAYMENT loan-pmt",
    );
    const linked = await browser.post("/api/links", {
      kind: "loan",
      transactionId: payment?.id,
      loanAccountId: loan.id,
    });
    expect(linked.status).toBe(200);
    expect(await lakeside()).toEqual([
      expect.objectContaining({
        date: "2026-11-17",
        what: "Lakeside Auto payment",
        amount: -40_000,
      }),
    ]);

    // With no regular payment, the row pays the last linked payment's amount.
    const edited = await browser.send("PUT", `/api/manual-loans/${loan.id}`, {
      ...body,
      regularPayment: null,
    });
    expect(edited.status).toBe(200);
    expect(await lakeside()).toEqual([
      expect.objectContaining({ date: "2026-11-17", amount: -38_500 }),
    ]);
  });

  it("shows a connected loan's next payment from its loan details", async () => {
    const loan = (id: string, dueDate: string) =>
      fakeAccount({
        id,
        name: `Loan ${id}`,
        type: "loan",
        subtype: "student",
        currentBalance: -900_000,
        loan: {
          apr: 5.5,
          principal: -900_000,
          interestPaidThisYear: 12_000,
          minimumPayment: 31_200,
          dueDate,
        },
      });
    fake.addPages("fake-lender", {
      accounts: [loan("due", "2026-11-16"), loan("later", "2026-11-30")],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: "fake-lender",
      bankName: "Fake Lender",
      origin: "linked",
      syncMinute: 17,
    });
    await syncConnection(connectionId);

    const rows = ofKind(await comingUp(), "loan payment");
    expect(rows.filter((row) => row.what.startsWith("Loan "))).toEqual([
      expect.objectContaining({ date: "2026-11-16", what: "Loan due payment", amount: -31_200 }),
    ]);
  });

  it("shows an active Recurring charge whose day has come with no charge on today, as late", async () => {
    // City of Mapleford Utilities is expected Nov 10. On Nov 11 no charge has come, and it stays
    // active through Nov 12, 2 days after its day.
    at("2026-11-11T17:00:00.000Z");
    const view = await comingUp();
    const utilities = view.rows.filter((row) => row.what === "City of Mapleford Utilities");

    expect(utilities).toEqual([
      expect.objectContaining({ date: "2026-11-11", late: true, amount: -10_981 }),
    ]);
    // Streamflix is expected Sunday Nov 8, so the business-day shift lets it post Monday Nov 9: it
    // is late too, and stays active through Nov 11 (spec 06, Monthly series).
    expect(view.rows.filter((row) => row.late).map((row) => row.what)).toEqual([
      "City of Mapleford Utilities",
      "Streamflix",
    ]);
    // It comes first, on today's position, moves checking, and counts in the big number.
    const [late] = utilities;
    expect(view.rows[0]).toEqual(late);
    expect(late?.checkingAfter).toBe((view.checking ?? 0) - 10_981);
    expect(view.outgoing).toBe(
      -view.rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
    );
    expect(late === undefined ? undefined : comingUpRow(late, "2026-11-11").date).toBe("late");

    // On Nov 13 it is inactive, so it leaves Coming up (spec 06).
    at("2026-11-13T17:00:00.000Z");
    const after = await comingUp();
    expect(after.rows.filter((row) => row.what === "City of Mapleford Utilities")).toEqual([]);
  });

  it("shows a Recurring charge expected today with no charge on today, not late, until Household midnight", async () => {
    // 10 PM on Nov 10 in New York is Nov 11 in UTC. The Household's day is still Nov 10, the
    // charge's expected day.
    for (const now of ["2026-11-10T17:00:00.000Z", "2026-11-11T03:00:00.000Z"]) {
      at(now);
      const view = await comingUp();
      const utilities = view.rows.filter((row) => row.what === "City of Mapleford Utilities");
      expect(utilities).toEqual([
        expect.objectContaining({ date: "2026-11-10", late: false, amount: -10_981 }),
      ]);
      const [today] = utilities;
      expect(view.rows[0]).toEqual(today);
      expect(today?.checkingAfter).toBe((view.checking ?? 0) - 10_981);
      expect(view.outgoing).toBeGreaterThanOrEqual(10_981);
      expect(today === undefined ? undefined : comingUpRow(today, "2026-11-10").date).toBe(
        "Nov 10",
      );
    }

    // At 12:30 AM on Nov 11 in New York, the day has passed: it is late.
    at("2026-11-11T05:30:00.000Z");
    const yesterday = await comingUp();
    expect(yesterday.rows.filter((row) => row.what === "City of Mapleford Utilities")).toEqual([
      expect.objectContaining({ date: "2026-11-11", late: true, amount: -10_981 }),
    ]);
  });

  it("shows every expected date in the window of a series whose interval is shorter", async () => {
    const wages = (id: string, postedDate: string) =>
      fakeTxn({
        id,
        accountId: "demo-ally-checking",
        amount: 40_000,
        postedDate,
        merchantName: "Day Shift Staffing",
        description: `DAY SHIFT STAFFING PAYROLL ${id}`,
      });
    await addToBank("fake-ally", [
      checkingLine("bean-1", "2026-10-17", -1_250, "Corner Bean"),
      checkingLine("bean-2", "2026-10-24", -1_250, "Corner Bean"),
      checkingLine("bean-3", "2026-10-31", -1_250, "Corner Bean"),
      checkingLine("bean-4", "2026-11-07", -1_250, "Corner Bean"),
      wages("shift-1", "2026-10-16"),
      wages("shift-2", "2026-10-23"),
      wages("shift-3", "2026-10-30"),
      wages("shift-4", "2026-11-06"),
    ]);
    const view = await comingUp();
    const datesOf = (what: string) =>
      view.rows.filter((row) => row.what === what).map((row) => row.date);

    // Weekly: twice in 14 days, each in the checking chain and the big number.
    expect(datesOf("Corner Bean")).toEqual(["2026-11-14", "2026-11-21"]);
    expect(datesOf("Day Shift Staffing")).toEqual(["2026-11-13", "2026-11-20"]);
    let balance = view.checking ?? 0;
    for (const row of view.rows.filter((each) => !each.onCard)) {
      balance += row.amount;
      expect(row.checkingAfter, row.what).toBe(balance);
    }
    expect(view.outgoing).toBe(
      -view.rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
    );
    // Every 2 weeks and monthly come once in 14 days.
    expect(datesOf("Northwind Logistics")).toEqual(["2026-11-13"]);
    expect(datesOf("Brightwave Wireless")).toEqual(["2026-11-12"]);
  });

  // Connects a loan bank with these Accounts and Transactions, and syncs it.
  async function addLoanBank(
    bankId: string,
    bankName: string,
    accounts: ReturnType<typeof fakeAccount>[],
    added: TxnRecord[] = [],
  ) {
    fake.addPages(bankId, { accounts, added, historyLoaded: true });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId,
      bankName,
      origin: "linked",
      syncMinute: 17,
    });
    await syncConnection(connectionId);
    await runFollowUp();
  }
  // A connected loan with no loan details, as Plaid sends for a personal loan.
  const noDetails = (id: string) =>
    fakeAccount({
      id,
      name: `Loan ${id}`,
      type: "loan",
      subtype: "personal",
      currentBalance: -500_000,
    });
  const loanRow = async (what: string) =>
    ofKind(await comingUp(), "loan payment").filter((row) => row.what === what);

  it("shows a connected loan with no minimum payment at its last payment, a month after it", async () => {
    // The demo's Personal Loan has no loan details. Its payments to Larkspur from checking are
    // untracked loan payments, the last on Oct 15.
    expect(await loanRow("Personal Loan payment")).toEqual([
      expect.objectContaining({ date: "2026-11-15", amount: -45_218, late: false }),
    ]);

    // A loan whose payment pairs as a Transfer pays that payment's amount, from the paying side.
    await addLoanBank(
      "fake-lender",
      "Fake Lender",
      [noDetails("paired")],
      [
        fakeTxn({
          id: "paired-in",
          accountId: "paired",
          amount: 30_000,
          postedDate: "2026-10-20",
          description: "PAYMENT RECEIVED",
        }),
      ],
    );
    await addToBank("fake-ally", [
      fakeTxn({
        id: "paired-out",
        accountId: "demo-ally-checking",
        amount: -30_000,
        postedDate: "2026-10-20",
        description: "FAKE LENDER LOAN PMT",
        merchantName: "Fake Lender",
        category: {
          name: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
          confidence: "VERY_HIGH",
          version: "v2",
          mcc: null,
        },
      }),
    ]);
    expect(await loanRow("Loan paired payment")).toEqual([
      expect.objectContaining({ date: "2026-11-20", amount: -30_000 }),
    ]);

    // A second loan at Larkspur: the app cannot tell which loan the payments pay, so neither
    // shows.
    await addLoanBank("fake-larkspur-2", "Larkspur", [noDetails("second")]);
    expect(await loanRow("Personal Loan payment")).toEqual([]);
    expect(await loanRow("Loan second payment")).toEqual([]);
  });

  // The demo Personal Loan's row, from its untracked payments to Larkspur.
  const demoLoanRow = [expect.objectContaining({ date: "2026-11-15", amount: -45_218 })];

  // An untracked loan payment from checking to Larkspur under this code.
  const larkspurPayment = (id: string, postedDate: string, amount: number, code: string) =>
    fakeTxn({
      id,
      accountId: "demo-ally-checking",
      amount,
      postedDate,
      description: `LARKSPUR ${id}`,
      merchantName: "Larkspur",
      category: { name: code, confidence: "VERY_HIGH", version: "v2", mcc: null },
    });

  it("counts a connected loan's Transfer pair only from the past 3 months", async () => {
    // Jul 20 is before Aug 7, 3 months before today. Without the limit, it gives Nov 20.
    await addLoanBank(
      "fake-lender",
      "Fake Lender",
      [noDetails("old")],
      [
        fakeTxn({
          id: "old-in",
          accountId: "old",
          amount: 30_000,
          postedDate: "2026-07-20",
          description: "PAYMENT RECEIVED",
        }),
      ],
    );
    await addToBank("fake-ally", [
      fakeTxn({
        id: "old-out",
        accountId: "demo-ally-checking",
        amount: -30_000,
        postedDate: "2026-07-20",
        description: "FAKE LENDER LOAN PMT",
        merchantName: "Fake Lender",
        category: {
          name: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
          confidence: "VERY_HIGH",
          version: "v2",
          mcc: null,
        },
      }),
    ]);
    expect(await loanRow("Loan old payment")).toEqual([]);
    expect(await loanRow("Personal Loan payment")).toEqual(demoLoanRow);
  });

  it("takes a lender's untracked payments for no loan when another open loan has that lender", async () => {
    expect(await loanRow("Personal Loan payment")).toEqual(demoLoanRow);

    // A connected Larkspur student loan with a minimum payment: the payments may be its own.
    await addLoanBank("fake-larkspur-student", "Larkspur", [
      fakeAccount({
        id: "student",
        name: "Student Loan",
        type: "loan",
        subtype: "student",
        currentBalance: -900_000,
        loan: {
          apr: 5.5,
          principal: -900_000,
          interestPaidThisYear: 0,
          minimumPayment: 20_000,
          dueDate: "2026-11-19",
        },
      }),
    ]);
    expect(await loanRow("Personal Loan payment")).toEqual([]);
    expect(await loanRow("Student Loan payment")).toEqual([
      expect.objectContaining({ date: "2026-11-19", amount: -20_000 }),
    ]);

    // Its own payment changes nothing.
    await addToBank("fake-ally", [
      larkspurPayment("student-1", "2026-10-18", -20_000, "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT"),
    ]);
    expect(await loanRow("Personal Loan payment")).toEqual([]);
  });

  it("takes a lender's untracked payments for no connected loan when a Manual loan has that lender", async () => {
    expect(await loanRow("Personal Loan payment")).toEqual(demoLoanRow);
    // Stored straight, so that no payment links to it: adding it through the app would link every
    // Larkspur payment to it, and leave the Personal Loan none to fall back on.
    await addStoredManualLoan(
      test.database,
      {
        lender: " larkspur ",
        subtype: "car",
        apr: 7.3,
        regularPayment: 30_000,
        escrow: null,
        loanType: null,
      },
      { date: "2026-10-01", balance: -1_000_000, typedAt: NOW, typedBy: null },
    );
    expect(await loanRow("Personal Loan payment")).toEqual([]);
  });

  it("takes a lender's untracked payments for no loan when they come twice in a month", async () => {
    expect(await loanRow("Personal Loan payment")).toEqual(demoLoanRow);
    // A car loan at Larkspur the Household never connected: October has two payments, so the
    // lender has two payment streams.
    await addToBank("fake-ally", [
      larkspurPayment("car-1", "2026-10-20", -30_000, "LOAN_PAYMENTS_CAR_PAYMENT"),
    ]);
    expect(await loanRow("Personal Loan payment")).toEqual([]);
  });

  // A monthly payment from checking to a loan, under Plaid's car payment code.
  const carPayment = (id: string, postedDate: string, amount: number, description: string) =>
    fakeTxn({
      id,
      accountId: "demo-ally-checking",
      amount,
      postedDate,
      description,
      category: {
        name: "LOAN_PAYMENTS_CAR_PAYMENT",
        confidence: "VERY_HIGH",
        version: "v2",
        mcc: null,
      },
    });
  const months = ["2026-08", "2026-09", "2026-10"];

  it("shows a loan payment once: no Recurring charge of the payments to a loan with its own row", async () => {
    const before = await comingUp();
    // The auto loan in the T83 review: its minimum payment is due on the 15th, and each payment
    // from checking pairs with the loan's own side.
    const autoLoan = fakeAccount({
      id: "auto-loan",
      name: "Auto Loan",
      type: "loan",
      subtype: "auto",
      mask: "5150",
      currentBalance: -412_380,
      loan: {
        apr: 6.9,
        principal: -3_200_000,
        interestPaidThisYear: 31_870,
        minimumPayment: 61_250,
        dueDate: "2026-11-15",
      },
    });
    await addLoanBank(
      "fake-summit",
      "Summit Auto Finance",
      [autoLoan],
      months.map((month) =>
        fakeTxn({
          id: `summit-in-${month}`,
          accountId: autoLoan.id,
          amount: 61_250,
          postedDate: `${month}-16`,
          description: "PAYMENT RECEIVED - THANK YOU",
        }),
      ),
    );
    await addToBank(
      "fake-ally",
      months.map((month) =>
        carPayment(`summit-out-${month}`, `${month}-15`, -61_250, "SUMMIT AUTO LOAN PMT 5150"),
      ),
    );
    const { charges } = (await (await browser.get("/api/recurring-charges")).json()) as {
      charges: RecurringChargeView[];
    };
    expect(charges.map((charge) => charge.merchantName)).toContain("Summit Auto Loan Pmt");

    const view = await comingUp();
    // Only the loan payment row is new: every Recurring charge that pays no loan still shows.
    const isAutoLoan = (row: { what: string }) => row.what === "Auto Loan payment";
    expect(shape(view).filter(isAutoLoan)).toEqual([
      { date: "2026-11-15", kind: "loan payment", what: "Auto Loan payment", onCard: false },
    ]);
    expect(shape(view).filter((row) => !isAutoLoan(row))).toEqual(shape(before));
    // The big number and "Checking after" count it once.
    expect(view.outgoing - before.outgoing).toBe(61_250);
    const lastChecking = (each: ComingUpView) =>
      each.rows.filter((row) => !row.onCard).at(-1)?.checkingAfter ?? 0;
    expect(view.checking).toBe(before.checking);
    expect(lastChecking(view) - lastChecking(before)).toBe(-61_250);

    // A loan with no due date has no row of its own, so the Recurring charge of its payments shows.
    const noDueDate = fakeAccount({
      ...autoLoan,
      id: "boat-loan",
      name: "Boat Loan",
      mask: "7788",
      loan: {
        apr: 6.9,
        principal: -1_200_000,
        interestPaidThisYear: 9_000,
        minimumPayment: 20_000,
        dueDate: null,
      },
    });
    await addLoanBank(
      "fake-north",
      "North Marine Credit",
      [noDueDate],
      months.map((month) =>
        fakeTxn({
          id: `north-in-${month}`,
          accountId: noDueDate.id,
          amount: 20_000,
          postedDate: `${month}-20`,
          description: "PAYMENT RECEIVED - THANK YOU",
        }),
      ),
    );
    await addToBank(
      "fake-ally",
      months.map((month) =>
        carPayment(`north-out-${month}`, `${month}-19`, -20_000, "NORTH MARINE LOAN PMT 7788"),
      ),
    );
    expect(
      shape(await comingUp()).filter(
        (row) => row.what.startsWith("North Marine") || row.what === "Boat Loan payment",
      ),
    ).toEqual([
      {
        date: "2026-11-19",
        kind: "Recurring charge",
        what: "North Marine Loan Pmt",
        onCard: false,
      },
    ]);
  });

  it("shows the Recurring charge of a loan's payments when the loan's own row is after the window", async () => {
    const before = await comingUp();
    // Due on Nov 24, after the window ends on Nov 21, and paid on the 21st each month.
    const autoLoan = fakeAccount({
      id: "auto-loan",
      name: "Auto Loan",
      type: "loan",
      subtype: "auto",
      mask: "5150",
      currentBalance: -412_380,
      loan: {
        apr: 6.9,
        principal: -3_200_000,
        interestPaidThisYear: 31_870,
        minimumPayment: 61_250,
        dueDate: "2026-11-24",
      },
    });
    await addLoanBank(
      "fake-summit",
      "Summit Auto Finance",
      [autoLoan],
      months.map((month) =>
        fakeTxn({
          id: `summit-in-${month}`,
          accountId: autoLoan.id,
          amount: 61_250,
          postedDate: `${month}-22`,
          description: "PAYMENT RECEIVED - THANK YOU",
        }),
      ),
    );
    await addToBank(
      "fake-ally",
      months.map((month) =>
        carPayment(`summit-out-${month}`, `${month}-21`, -61_250, "SUMMIT AUTO LOAN PMT 5150"),
      ),
    );

    const view = await comingUp();
    expect(
      shape(view).filter(
        (row) => row.what.startsWith("Summit") || row.what === "Auto Loan payment",
      ),
    ).toEqual([
      { date: "2026-11-21", kind: "Recurring charge", what: "Summit Auto Loan Pmt", onCard: false },
    ]);
    const lastChecking = (each: ComingUpView) =>
      each.rows.filter((row) => !row.onCard).at(-1)?.checkingAfter ?? 0;
    expect(view.outgoing - before.outgoing).toBe(61_250);
    expect(lastChecking(view) - lastChecking(before)).toBe(-61_250);
  });

  it("shows no Recurring charge of the payments to a Manual loan or a lender with a loan row", async () => {
    const shown = async (what: string) =>
      (await comingUp()).rows.filter((row) => row.what === what).map((row) => row.kind);

    // Payments to Lakeside Auto: a Recurring charge, until the last one links to a Manual loan,
    // which then has its own row. On a Purchase loan, the principal stays Spending, so the linked
    // payment still continues the Recurring charge, at any amount.
    await addToBank(
      "fake-ally",
      ["2026-07", ...months].map((month) =>
        checkingLine(`lakeside-${month}`, `${month}-17`, -38_500, "Online Payment"),
      ),
    );
    expect(await shown("Online Payment")).toEqual(["Recurring charge"]);
    const added = await browser.post("/api/manual-loans", {
      lender: "Lakeside Auto",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-10-01",
      apr: 7.3,
      regularPayment: 38_500,
      loanType: "purchase loan",
    });
    const { loan } = (await added.json()) as { loan: { id: string } };
    const payment = (await listTransactions(test.database)).find(
      (each) => each.description === "ONLINE PAYMENT lakeside-2026-10",
    );
    const linked = await browser.post("/api/links", {
      kind: "loan",
      transactionId: payment?.id,
      loanAccountId: loan.id,
    });
    expect(linked.status).toBe(200);
    const { charges } = (await (await browser.get("/api/recurring-charges")).json()) as {
      charges: RecurringChargeView[];
    };
    expect(charges.map((charge) => charge.merchantName)).toContain("Online Payment");
    expect(await shown("Lakeside Auto payment")).toEqual(["loan payment"]);
    expect(await shown("Online Payment")).toEqual([]);

    // Untracked payments to the lender of a connected loan with no loan details, which give the
    // loan its row.
    await addLoanBank("fake-harbor", "Harbor Auto Credit", [noDetails("harbor")]);
    await addToBank(
      "fake-ally",
      months.map((month) => ({
        ...carPayment(`harbor-${month}`, `${month}-12`, -27_500, `HARBOR AUTO CREDIT ${month}`),
        merchantName: "Harbor Auto Credit",
      })),
    );
    expect(await shown("Loan harbor payment")).toEqual(["loan payment"]);
    expect(await shown("Harbor Auto Credit")).toEqual([]);
  });
});
