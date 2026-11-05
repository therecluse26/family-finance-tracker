import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiCost, householdAi } from "../ai/index.ts";
import { DEMO_MEMBERS, seedDemoHousehold } from "../bank/demo.ts";
import { fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { budgetsForMonth, draftFirstBudgets, startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addGoal, listAccounts, listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startGoal } from "../goals/index.ts";
import { startMoneyMovement, totalsByMonth } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { LOOKUP_ROWS, lookupTools, PRICE_HISTORY_ROWS, RECURRING_ROWS } from "./index.ts";

// Chat's lookup tools (spec 08, Lookup tools) on the demo Household, with no AI: each is called as
// a plain function, as the AI's tool call would run it, and answers through the privacy filter.
// The demo history runs from May 2025 to October 2026, and loads on November 1, 2026.

type Row = Record<string, unknown>;
type Search = { count: number; total: string; transactions: Row[] };
type Totals = { count: number; rows: { name: string; total: string }[] };
type Balances = {
  of: string;
  balances: string;
  points: { date: string; balance: string; estimated: boolean }[];
};
type Charges = { count: number; recurringCharges: (Row & { priceHistory: Row[] })[] };
type BudgetsAndGoals = { budgets: Row[]; yearlyBudgets: Row[]; goals: Row[] };

const LOADED = new Date("2026-11-01T14:00:00.000Z");
const NOW = new Date("2026-11-20T14:00:00.000Z");
const cents = (dollars: string) => Math.round(Number(dollars) * 100);
// Merchants the demo history does not hold.
const SHOPS = ["Amber", "Birch", "Cedar", "Dune", "Elm", "Fern"].flatMap((name) =>
  [
    "Books",
    "Bakery",
    "Hardware",
    "Florist",
    "Cafe",
    "Deli",
    "Games",
    "Tailor",
    "Optics",
    "Pets",
  ].map((kind) => `${name} ${kind}`),
);

// Each field the search takes, unset.
const ANY = {
  merchant: null,
  category: null,
  account: null,
  type: null,
  from: null,
  to: null,
  minAmount: null,
  maxAmount: null,
};

describe("the lookup tools", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let tools: ReturnType<typeof lookupTools>;
  let answers: unknown[];
  // The ID of the Goal that meets its "Done when" rule.
  let metGoal: string;

  // Runs a tool, and keeps its answer for the privacy checks.
  const run = async <T>(name: keyof typeof tools, input: unknown): Promise<T> => {
    const answer = await tools[name]?.run(input);
    answers.push(answer);
    return answer as T;
  };
  const search = (input: Partial<Record<keyof typeof ANY, string | number>>) =>
    run<Search>("search_transactions", { ...ANY, ...input });

  beforeAll(async () => {
    let now = LOADED;
    const clock = () => now;
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      startRecurringCharges({ database: bank.database, now: clock }).stop,
      startBudgets({ database: bank.database, now: clock }).stop,
    ];
    for (const [index, member] of DEMO_MEMBERS.entries()) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          `member-${index + 1}`,
          `${member.firstName} ${member.lastName}`,
          member.email,
          `2026-10-0${index + 1}T00:00:00.000Z`,
          `2026-10-0${index + 1}T00:00:00.000Z`,
        ],
      });
    }
    await seedDemoHousehold(bank.database, bank.fake, clock);
    await runFollowUp(clock);
    await draftFirstBudgets(bank.database, LOADED);
    const accounts = await listAccounts(bank.database);
    const savings = accounts.find((account) => account.subtype === "savings");
    for (const goal of [
      {
        target: { kind: "Category" as const, category: "Restaurants" as const },
        goalAmount: 30_000,
      },
      {
        target: { kind: "Accounts" as const, accountIds: [savings?.id ?? ""] },
        goalAmount: undefined,
      },
      // Started October 1 with an amount October ended under: it meets its "Done when" rule.
      {
        target: { kind: "Category" as const, category: "Groceries" as const },
        goalAmount: 10_000_000,
        startsOn: new Date("2026-10-01T14:00:00.000Z"),
      },
    ]) {
      const id = await addGoal(bank.database, {
        words: "Alex Rivera wants this, card 4417",
        authorId: "member-1",
        date: "2026-11-01",
        target: goal.target,
        change: { amount: 50_000 },
        deadline: "2027-06-30",
      });
      await startGoal(bank.database, id, {
        goalAmount: goal.goalAmount,
        now: "startsOn" in goal ? goal.startsOn : LOADED,
      });
      if ("startsOn" in goal) metGoal = id;
    }
    // A later sync: a weekly purchase at each of 60 more Merchants, 3 weeks running, so a total by
    // Merchant has more than 50 rows, and so do the Recurring charges.
    now = NOW;
    const chase = (await listConnections(bank.database)).find(
      (each) => each.bankId === "fake-chase",
    );
    bank.fake.addPages("fake-chase", {
      added: ["2026-11-02", "2026-11-09", "2026-11-16"].flatMap((postedDate, week) =>
        SHOPS.map((shop, index) =>
          fakeTxn({
            id: `later-${week}-${index}`,
            accountId: "demo-chase-card",
            amount: -(1_000 + index * 100),
            postedDate,
            description: shop.toUpperCase(),
            merchantName: shop,
          }),
        ),
      ),
    });
    await syncConnection(chase?.id ?? "", clock);
    await runFollowUp(clock);
    const ai = householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    });
    tools = lookupTools({ database: bank.database, ai, now: () => NOW });
    answers = [];
  }, 120_000);

  afterAll(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("search_transactions", () => {
    it("answers with the 50 newest Transactions, and the count and total of every match", async () => {
      const found = await search({});

      const all = (
        await bank.database.$client.execute(
          "SELECT count(*) AS n, sum(amount) AS total FROM transactions WHERE hidden_reason IS NULL",
        )
      ).rows[0];
      expect(found.transactions).toHaveLength(LOOKUP_ROWS);
      expect(found.count).toBe(Number(all?.n));
      expect(found.count).toBeGreaterThan(LOOKUP_ROWS);
      expect(cents(found.total)).toBe(Number(all?.total));
      const dates = found.transactions.map((txn) => String(txn.date));
      expect(dates).toEqual([...dates].sort().reverse());
      expect(Object.keys(found.transactions[0] ?? {}).sort()).toEqual([
        "account",
        "amount",
        "category",
        "date",
        "merchant",
        "pending",
        "type",
      ]);
    });

    it("finds by Category, type, date range, and amount range together", async () => {
      const found = await search({
        category: "Groceries",
        type: "Spending",
        from: "2026-09-01",
        to: "2026-09-30",
        minAmount: 20,
        maxAmount: 150,
      });

      expect(found.count).toBeGreaterThan(0);
      expect(found.transactions.length).toBe(Math.min(found.count, LOOKUP_ROWS));
      for (const txn of found.transactions) {
        expect(txn.category).toContain("Groceries");
        expect(txn.type).toContain("Spending");
        expect(String(txn.date) >= "2026-09-01" && String(txn.date) <= "2026-09-30").toBe(true);
        expect(Math.abs(cents(String(txn.amount)))).toBeGreaterThanOrEqual(2_000);
        expect(Math.abs(cents(String(txn.amount)))).toBeLessThanOrEqual(15_000);
      }
      const sum = found.transactions.reduce((total, txn) => total + cents(String(txn.amount)), 0);
      if (found.count <= LOOKUP_ROWS) expect(cents(found.total)).toBe(sum);
    });

    it("finds one Account by its label, in any case, and names the labels for an unknown one", async () => {
      const labels = [...(await householdLabels()).values()];
      const label = labels.find((each) => each.toLowerCase().includes("checking")) ?? "";

      const found = await search({ account: label.toUpperCase() });
      const unknown = await run<{ error: string; accountLabels: string[] }>("search_transactions", {
        ...ANY,
        account: "Nowhere savings",
      });

      expect(found.count).toBeGreaterThan(0);
      expect(new Set(found.transactions.map((txn) => txn.account))).toEqual(new Set([label]));
      expect(unknown.error).toBe("No Account has that label.");
      expect(unknown.accountLabels).toEqual([...new Set(labels)].sort());
    });

    it("finds a Merchant by any part of its name, in any case, where % and _ match only themselves", async () => {
      const bakeries = await search({ merchant: "bAKERY" });
      const merchants = new Set(bakeries.transactions.map((txn) => String(txn.merchant)));

      for (const shop of SHOPS.filter((each) => each.endsWith("Bakery"))) {
        expect(merchants).toContain(shop);
      }
      for (const merchant of merchants) expect(merchant.toLowerCase()).toContain("bakery");
      for (const pattern of ["%", "_", "Amber%", "Amber_Bakery"]) {
        expect((await search({ merchant: pattern })).count).toBe(0);
      }
    });

    it("names a Merchant that is a Member by the Member's label", async () => {
      const found = await search({ merchant: "alex rivera" });

      expect(found.count).toBeGreaterThan(0);
      expect(new Set(found.transactions.map((txn) => txn.merchant))).toEqual(new Set(["Member B"]));
    });

    it("refuses an input that does not fit its schema", async () => {
      await expect(
        tools.search_transactions?.run({ ...ANY, from: "2026-10-31", to: "2026-10-01" }),
      ).rejects.toThrow();
      await expect(tools.search_transactions?.run({ merchant: "Starbucks" })).rejects.toThrow();
      await expect(
        tools.search_transactions?.run({ ...ANY, category: "Coffee" }),
      ).rejects.toThrow();
    });
  });

  describe("get_totals", () => {
    it("totals a month's Spending by Category, largest first, as the app counts it", async () => {
      const { rows } = await run<Totals>("get_totals", {
        of: "Spending",
        groupedBy: "Category",
        from: "2026-10-01",
        to: "2026-10-31",
      });

      const october = (await totalsByMonth(bank.database)).find((each) => each.month === "2026-10");
      const totals = rows.map((row) => cents(row.total));
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
      expect(totals.reduce((sum, total) => sum + total, 0)).toBe(october?.spending);
      const restaurants = rows.find((row) => row.name === "Restaurants");
      expect(cents(restaurants?.total ?? "0")).toBe(october?.byCategory.Restaurants);
    });

    it("answers with at most 50 rows", async () => {
      const { count, rows } = await run<Totals>("get_totals", {
        of: "Spending",
        groupedBy: "Merchant",
        from: "2025-05-01",
        to: "2026-11-20",
      });
      const merchants = (
        await bank.database.$client.execute(
          "SELECT count(DISTINCT merchant_clean_name) AS n FROM transactions",
        )
      ).rows[0];

      expect(Number(merchants?.n)).toBeGreaterThan(LOOKUP_ROWS);
      expect(rows).toHaveLength(LOOKUP_ROWS);
      expect(count).toBeGreaterThan(LOOKUP_ROWS);
      const totals = rows.map((row) => cents(row.total));
      expect(totals).toEqual([...totals].sort((a, b) => b - a));
    });

    it("totals Income by month, each named by its days in the range", async () => {
      const { rows } = await run<Totals>("get_totals", {
        of: "Income",
        groupedBy: "month",
        from: "2026-08-15",
        to: "2026-10-31",
      });

      expect(rows.map((row) => row.name).sort()).toEqual([
        "2026-08-15 to 2026-08-31",
        "2026-09-01 to 2026-09-30",
        "2026-10-01 to 2026-10-31",
      ]);
      const october = (await totalsByMonth(bank.database)).find((each) => each.month === "2026-10");
      const row = rows.find((each) => each.name.startsWith("2026-10"));
      expect(cents(row?.total ?? "0")).toBe(october?.income);
    });

    it("refuses Income or Saving by Category: only Spending has one", async () => {
      await expect(
        tools.get_totals?.run({
          of: "Income",
          groupedBy: "Category",
          from: "2026-10-01",
          to: "2026-10-31",
        }),
      ).rejects.toThrow("Only Spending has a Category.");
    });
  });

  describe("get_balance_history", () => {
    const history = (input: { of: string; account?: string; from: string; to: string }) =>
      run<Balances>("get_balance_history", { account: null, ...input });

    it("answers with daily balances for 92 days, and month-end balances for 93", async () => {
      const daily = await history({ of: "Cash on hand", from: "2026-08-01", to: "2026-10-31" });
      const monthly = await history({ of: "Cash on hand", from: "2026-07-31", to: "2026-10-31" });

      expect(daily.balances).toBe("daily");
      expect(daily.points).toHaveLength(92);
      expect(daily.points.at(0)?.date).toBe("2026-08-01");
      expect(daily.points.at(-1)?.date).toBe("2026-10-31");
      expect(monthly.balances).toBe("month-end");
      expect(monthly.points.map((point) => point.date)).toEqual([
        "2026-07-31",
        "2026-08-31",
        "2026-09-30",
        "2026-10-31",
      ]);
      const endOfAugust = daily.points.find((point) => point.date === "2026-08-31");
      expect(monthly.points[1]?.balance).toBe(endOfAugust?.balance);
    });

    it("marks the balances worked back before the first sync as estimated", async () => {
      const { points } = await history({
        of: "Cash on hand",
        from: "2026-10-29",
        to: "2026-11-03",
      });

      expect(points.map(({ date, estimated }) => [date, estimated])).toEqual([
        ["2026-10-29", true],
        ["2026-10-30", true],
        ["2026-10-31", true],
        ["2026-11-01", false],
        ["2026-11-02", false],
        ["2026-11-03", false],
      ]);
    });

    it("sums one Account's balances or the Debt tile's, with money owed negative", async () => {
      const labels = [...(await householdLabels()).values()];
      const card = labels.find((each) => each.toLowerCase().includes("credit")) ?? "";

      const one = await history({
        of: "Account",
        account: card,
        from: "2026-11-01",
        to: "2026-11-01",
      });
      const debt = await history({ of: "Debt", from: "2026-11-01", to: "2026-11-01" });

      expect(one.of).toBe(card);
      expect(cents(one.points[0]?.balance ?? "0")).toBeLessThan(0);
      expect(cents(debt.points[0]?.balance ?? "0")).toBeLessThan(
        cents(one.points[0]?.balance ?? "0"),
      );
    });
  });

  describe("get_recurring_charges", () => {
    it("answers with 20 Recurring charges, active first and soonest first, and the count of all", async () => {
      const { count, recurringCharges } = await run<Charges>("get_recurring_charges", {
        category: null,
      });
      const all = (
        await bank.database.$client.execute(
          "SELECT count(*) AS n FROM recurring_charges WHERE status != 'ended'",
        )
      ).rows[0];

      expect(count).toBe(Number(all?.n));
      expect(count).toBeGreaterThan(RECURRING_ROWS);
      expect(recurringCharges).toHaveLength(RECURRING_ROWS);
      const order = recurringCharges.map(
        (charge) => `${charge.status === "active" ? 0 : 1} ${charge.nextDate}`,
      );
      expect(order).toEqual([...order].sort());
    });

    it("answers with the Recurring charges of one Category, with their latest price history", async () => {
      const { recurringCharges } = await run<Charges>("get_recurring_charges", { category: null });
      const category = String(recurringCharges[0]?.category);
      const inCategory = await run<Charges>("get_recurring_charges", { category });

      expect(recurringCharges.length).toBeGreaterThan(0);
      for (const charge of recurringCharges) {
        expect(["active", "inactive"]).toContain(charge.status);
        expect(charge.priceHistory.length).toBeLessThanOrEqual(PRICE_HISTORY_ROWS);
        const dates = charge.priceHistory.map((each) => String(each.date));
        expect(dates).toEqual([...dates].sort());
      }
      expect(
        recurringCharges.some((charge) => charge.priceHistory.length === PRICE_HISTORY_ROWS),
      ).toBe(true);
      expect(inCategory.recurringCharges.length).toBeGreaterThan(0);
      expect(inCategory.recurringCharges.every((charge) => charge.category === category)).toBe(
        true,
      );
    });
  });

  describe("get_budgets_and_goals", () => {
    it("answers with each Category's Budget, Spending, and status, the yearly Budgets, and every Goal", async () => {
      const month = "2026-11";
      const { budgets } = await budgetsForMonth(bank.database, month);
      const answer = await run<BudgetsAndGoals>("get_budgets_and_goals", { month });

      const monthly = budgets.filter((budget) => budget.period === "monthly");
      expect(answer.budgets.filter((row) => row.budget !== null)).toHaveLength(monthly.length);
      expect(monthly.length).toBeGreaterThan(0);
      for (const row of answer.budgets) {
        expect(row.budget === null ? row.status === null : typeof row.status === "string").toBe(
          true,
        );
      }
      expect(answer.yearlyBudgets.map((row) => row.category).sort()).toEqual(
        budgets
          .filter((budget) => budget.period === "yearly")
          .map((budget) => budget.category)
          .sort(),
      );
      expect(answer.goals).toHaveLength(3);
      expect(answer.goals[0]).toMatchObject({
        target: "Category: Restaurants",
        change: "500.00",
        deadline: "2027-06-30",
        goalAmount: "300.00",
        status: "active",
        progress: { kind: "spend less" },
      });
      expect(String(answer.goals[1]?.target)).toMatch(/^Accounts: [A-Za-z ]+ savings$/);
      expect(JSON.stringify(answer.goals)).not.toContain("wants this");
    });

    it("shows a Goal that meets its Done when rule as done, and leaves it active in app.db", async () => {
      const changes = async () =>
        Number((await bank.database.$client.execute("SELECT total_changes() AS n")).rows[0]?.n);
      const stored = async () =>
        (
          await bank.database.$client.execute({
            sql: "SELECT status FROM goals WHERE id = ?",
            args: [metGoal],
          })
        ).rows[0]?.status;
      const before = await changes();

      const { goals } = await run<BudgetsAndGoals>("get_budgets_and_goals", { month: "2026-11" });

      expect(goals.find((goal) => goal.target === "Category: Groceries")).toMatchObject({
        status: "done",
      });
      expect(await stored()).toBe("active");
      expect(await changes()).toBe(before);
    });
  });

  describe("every answer", () => {
    it("holds no Member name, email address, last 4, or ID, and no escape the AI reads differently", async () => {
      const accounts = await listAccounts(bank.database);
      const ids = (await bank.database.$client.execute("SELECT id FROM transactions")).rows.map(
        (row) => String(row.id),
      );
      const text = JSON.stringify(answers);

      expect(answers.length).toBeGreaterThan(10);
      for (const member of DEMO_MEMBERS) {
        expect(text).not.toMatch(new RegExp(member.lastName, "i"));
        expect(text).not.toContain(member.email);
      }
      for (const account of accounts) {
        expect(text).not.toContain(account.id);
        if (account.mask !== null)
          expect(text).not.toMatch(new RegExp(`(?<!\\d)${account.mask}(?!\\d)`));
      }
      for (const id of ids) expect(text).not.toContain(id);
      expect(text).not.toMatch(/\\[^\\"]/);
    });

    it("writes nothing", async () => {
      const changes = async () =>
        Number((await bank.database.$client.execute("SELECT total_changes() AS n")).rows[0]?.n);
      const before = await changes();

      await search({ category: "Restaurants" });
      await run("get_totals", {
        of: "Saving",
        groupedBy: "month",
        from: "2025-05-01",
        to: "2026-10-31",
      });
      await run("get_balance_history", {
        of: "Debt",
        account: null,
        from: "2025-05-01",
        to: "2026-11-20",
      });
      await run("get_recurring_charges", { category: null });
      await run("get_budgets_and_goals", { month: "2026-11" });

      expect(await changes()).toBe(before);
    });
  });

  const householdLabels = () =>
    householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    }).accountLabels();
});
