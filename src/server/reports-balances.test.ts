import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { AccountView, NumberTilesView } from "./bank-views.ts";
import type { BalancesReportView } from "./reports-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// Balances and debt (spec 07, Reports) through the app's HTTP interface, on the demo household on
// Oct 20, 2026. Each demo Account first synced this month, so every earlier month-end is an
// estimate.

const APP_URL = "http://nas.local:8080";
// Noon in New York, the demo Household's time zone.
const NOW = new Date("2026-10-20T16:00:00.000Z");

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-reports-balances-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Balances and debt on the demo household", () => {
  let test: TestAuth;
  let browser: TestBrowser;
  let stops: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    const app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    test.close();
    vi.useRealTimers();
  });

  const report = async (query = "range=12m") => {
    const res = await browser.get(`/api/reports/balances?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as BalancesReportView;
  };
  const accounts = async () =>
    ((await (await browser.get("/api/accounts")).json()) as { accounts: AccountView[] }).accounts;
  const idOf = async (name: string) =>
    (await accounts()).find((account) => account.name === name)?.id ?? "";
  const amounts = (points: BalancesReportView["cashOnHand"]) => points.map((point) => point.amount);
  // An Account's balance at each month-end of the range, through the report's one-Account view.
  const accountLine = async (id: string) => {
    const view = await report(`range=12m&account=${id}`);
    return new Map((view.account?.monthEnds ?? []).map((end) => [end.month, end.currentBalance]));
  };

  it("counts Cash on hand and Debt at each month-end as the number tiles do", async () => {
    const view = await report();
    const tiles = (await (await browser.get("/api/number-tiles")).json()) as NumberTilesView;

    expect(view.months.at(-1)).toBe("2026-10");
    expect(view.account).toBeNull();
    expect(view.cashOnHand.map((point) => point.month)).toEqual(view.months);
    expect(view.cashOnHand.at(-1)?.date).toBe("2026-10-20");
    expect(view.cashOnHand.at(-2)?.date).toBe("2026-09-30");
    // The tiles' trend line: the month-ends before this month, then today.
    for (const [tile, line] of [
      [tiles.cashOnHand, view.cashOnHand],
      [tiles.debt, view.debt],
    ] as const) {
      const ends = tile.trend.slice(0, -1);
      expect(ends.length).toBeGreaterThan(0);
      for (const end of ends) {
        expect(line.find((point) => point.month === end.at)?.amount).toBe(end.amount);
      }
    }
    expect(view.debt.every((point) => point.amount > 0)).toBe(true);
    // No net worth.
    expect(JSON.stringify(view)).not.toMatch(/net ?worth/i);
  });

  it("marks month-ends before the first sync estimated, and later ones known", async () => {
    const first = await report();
    const estimated = (view: BalancesReportView) =>
      view.cashOnHand.map((point) => [point.month, point.estimated]);
    expect(estimated(first)).toEqual(first.months.map((month) => [month, month < "2026-10"]));
    expect(first.debt.map((point) => point.estimated)).toEqual(
      first.months.map((month) => month < "2026-10"),
    );

    // A saved balance for each Account on Aug 31: from then on, the month-ends are known.
    await test.database.$client.execute(
      "INSERT INTO daily_balances (account_id, date, current_balance, credit_limit, synced_at) SELECT account_id, '2026-08-31', current_balance, credit_limit, '2026-08-31T16:00:00.000Z' FROM daily_balances",
    );
    const synced = await report();
    expect(estimated(synced)).toEqual(synced.months.map((month) => [month, month < "2026-08"]));
    for (const card of synced.creditUse.cards) {
      expect(card.points.map((point) => point.estimated)).toEqual(
        synced.months.map((month) => month < "2026-08"),
      );
    }
  });

  it("counts no Excluded or Closed Account in any line", async () => {
    const before = await report();
    const card = await idOf("Chase Card");
    const savings = await idOf("Online Savings");
    const cardLine = await accountLine(card);
    const savingsLine = await accountLine(savings);
    expect(before.creditUse.cards.map((each) => each.id)).toContain(card);

    expect(
      (await browser.send("PUT", `/api/accounts/${card}/exclude`, { excluded: true })).status,
    ).toBe(200);
    expect((await browser.post(`/api/accounts/${savings}/close`)).status).toBe(200);
    const after = await report();

    expect(amounts(after.cashOnHand)).toEqual(
      before.cashOnHand.map((point) => point.amount - (savingsLine.get(point.month) ?? 0)),
    );
    // The card's balance is owed, so it is negative: Debt drops by what it owes.
    expect(amounts(after.debt)).toEqual(
      before.debt.map((point) => point.amount + (cardLine.get(point.month) ?? 0)),
    );
    expect(after.creditUse.cards.map((each) => each.id)).not.toContain(card);
    expect(after.creditUse.cards).toHaveLength(before.creditUse.cards.length - 1);
    expect(after.accounts.map((account) => account.id)).not.toContain(card);
    expect(after.accounts.map((account) => account.id)).not.toContain(savings);
  });

  it("leaves an Unconnected account out of Cash on hand, and counts a Manual loan in Debt and its pay-down", async () => {
    const before = await report();
    expect(before.loans).toEqual([]);
    const added = await browser.post("/api/unconnected-accounts", {
      name: "Credit union savings",
      kind: "savings",
      institutionName: "",
      mask: "",
      balance: 500_000,
    });
    expect(added.status).toBe(200);
    const loan = await browser.post("/api/manual-loans", {
      lender: "Lakeside Auto",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-10-20",
      apr: 7.3,
      regularPayment: 40_000,
    });
    expect(loan.status).toBe(200);
    const after = await report();

    expect(after.cashOnHand).toEqual(before.cashOnHand);
    // The Unconnected account is still offered on its own.
    const unconnected = await idOf("Credit union savings");
    expect(after.accounts.map((account) => account.id)).toContain(unconnected);
    // The loan typed today holds back to the start of the history.
    expect(amounts(after.debt)).toEqual(before.debt.map((point) => point.amount + 1_000_000));
    expect(after.debt.every((point) => point.estimated)).toBe(true);
    expect(after.loans).toHaveLength(1);
    expect(
      after.loans[0]?.points.map(({ principal, estimated }) => ({ principal, estimated })),
    ).toEqual(after.months.map(() => ({ principal: 1_000_000, estimated: true })));
  });

  it("gives each card with a credit limit its credit use, and none to a card with no limit", async () => {
    const before = await report();
    expect(before.creditUse.cards.map((card) => card.name).sort()).toEqual([
      "Chase Card",
      "Home Store Card",
      "Rewards Card",
    ]);
    const chase = before.creditUse.cards.find((card) => card.name === "Chase Card");
    const owed = await accountLine(chase?.id ?? "");
    // Its $12,000 limit.
    expect(chase?.points.map((point) => point.share)).toEqual(
      before.months.map((month) => Math.max(0, 0 - (owed.get(month) ?? 0)) / 1_200_000),
    );
    expect(before.creditUse.all).toHaveLength(before.months.length);

    const store = await idOf("Home Store Card");
    await test.database.$client.execute({
      sql: "UPDATE household_accounts SET credit_limit = NULL WHERE id = ?",
      args: [store],
    });
    await test.database.$client.execute({
      sql: "UPDATE daily_balances SET credit_limit = NULL WHERE account_id = ?",
      args: [store],
    });
    const after = await report();
    expect(after.creditUse.cards.map((card) => card.id)).not.toContain(store);
    expect(after.creditUse.cards).toHaveLength(2);
  });

  it("shows one Account's balance line over the range, and answers 404 to an unknown Account", async () => {
    const checking = await idOf("Interest Checking");
    const view = await report(`range=3m&account=${checking}`);

    expect(view.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(view.account?.id).toBe(checking);
    expect(view.account?.points[0]?.date).toBe("2026-08-01");
    expect(view.account?.points.at(-1)?.date).toBe("2026-10-20");
    expect(view.account?.monthEnds.map((end) => end.month)).toEqual(view.months);
    expect(view.cashOnHand).toEqual([]);
    expect(view.debt).toEqual([]);

    for (const id of ["acc-unknown", `${checking}x`]) {
      const res = await browser.get(`/api/reports/balances?range=12m&account=${id}`);
      expect(res.status).toBe(404);
    }
  });
});
