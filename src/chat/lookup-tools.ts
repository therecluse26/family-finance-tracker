import * as z from "zod";
import {
  type AiTools,
  aiTool,
  type HouseholdAi,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "../ai/index.ts";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import { CATEGORIES, type Category, categoryGroupOf } from "../categories/index.ts";
import { type Database, listAccounts, readShownParts, searchTransactions } from "../db/index.ts";
import { type Goal, progressDetailPieces, readGoalsWithProgress } from "../goals/index.ts";
import { TRANSACTION_TYPES } from "../money-movement/index.ts";
import { householdToday, recurringCharges } from "../recurring/index.ts";
import { balanceHistory, DAILY_DAYS, tileAccounts } from "./balance-history.ts";
import { TOTAL_GROUPINGS, TOTAL_KINDS, totalsBy } from "./totals.ts";

// Chat's five lookup tools (spec 08, Lookup tools). Each is a plain function: it checks its input
// against its Zod schema, reads app.db, writes nothing, and answers with plain JSON data. Every
// description and schema is built only from constants in the code, such as the fixed Category
// list, never from Household data. Amounts, dates, months, and counts read as src/ai/typed.ts
// writes them, such as "-48.21". Transactions go out with no ID.

// The most rows search_transactions and get_totals answer with.
export const LOOKUP_ROWS = 50;

// The most Recurring charges get_recurring_charges answers with. Each holds its price history, so
// 50 would not fit the answer size: the AI reads each answer again on every later round, and 20
// charges stay under 10,000 characters, about 2,500 tokens (src/large-history/cases/lookup-tools.ts).
export const RECURRING_ROWS = 20;

// How many of a Recurring charge's latest Transactions its price history holds: enough to show a
// change.
export const PRICE_HISTORY_ROWS = 6;

export type LookupOptions = {
  database: Database;
  ai: Pick<HouseholdAi, "accountNames">;
  now?: () => Date;
};

const CATEGORY_NAMES = CATEGORIES.map(({ name }) => name) as [Category, ...Category[]];

const isDate = (text: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
const DATE = z.string().refine(isDate, "A date is written YYYY-MM-DD.");
const MONTH = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "A month is written YYYY-MM.");
const ACCOUNT_NAME = z.string().min(1).max(100);
const DOLLARS = z.number().nonnegative().max(100_000_000);

// Cents as dollars, with 2 decimals and no thousands separator, such as "-1234.50", at any size.
function dollars(cents: number): string {
  const size = Math.abs(Math.round(cents));
  const sign = cents < 0 && size > 0 ? "-" : "";
  return `${sign}${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`;
}

const cents = (amount: number) => Math.round(amount * 100);

// The largest amount typedAmount writes: under 10^12 cents.
const TYPED_AMOUNT_CAP = 10 ** 12;

// A Goal's progress detail (src/goals/progress.ts) in parts: its words, and each amount the app
// computed, as the Household summary sends it.
const progressDetail = (detail: string) =>
  progressDetailPieces(detail).map((piece) =>
    typeof piece === "string"
      ? piece
      : Math.abs(piece.cents) < TYPED_AMOUNT_CAP
        ? typedAmount(piece.cents)
        : dollars(piece.cents),
  );

// The Account with this name as the AI reads it (HouseholdAi.accountNames), in any case.
function accountWithName(names: ReadonlyMap<string, string>, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  for (const [id, each] of names) if (each.toLowerCase() === wanted) return id;
  return undefined;
}

const unknownName = (names: ReadonlyMap<string, string>) => ({
  error: "No Account has that name.",
  accountNames: [...new Set(names.values())].sort(),
});

const joined = (values: readonly (string | null)[]) => {
  const named = [...new Set(values.filter((value): value is string => value !== null))];
  return named.length === 0 ? null : named.join(", ");
};

// A Goal as the AI reads it: what it targets, by Category, Merchant, or Account name, with its
// reading, progress, and status.
function goalOf(goal: Goal, names: ReadonlyMap<string, string>) {
  const nameOf = (id: string) => names.get(id) ?? "Account";
  const target = goal.reading.target;
  let named: string | null = null;
  if (target !== null) {
    switch (target.kind) {
      case "Category":
        named = `Category: ${target.category}`;
        break;
      case "Merchant":
        named = `Merchant: ${target.merchant.name}`;
        break;
      case "Saving":
        named = "Saving";
        break;
      case "Accounts":
        named = `Accounts: ${target.accountIds.map(nameOf).join(", ")}`;
        break;
      case "loan":
        named = `loan: ${nameOf(target.accountId)}`;
        break;
    }
  }
  const { change, deadline } = goal.reading;
  return {
    target: named,
    change:
      change === null ? null : "amount" in change ? dollars(change.amount) : `${change.percent}%`,
    deadline,
    goalAmount: goal.goalAmount === null ? null : dollars(goal.goalAmount),
    status: goal.status,
    progress:
      goal.progress === null
        ? null
        : {
            kind: goal.progress.kind,
            percentage: goal.progress.percentage,
            state: goal.progress.state,
            detail: progressDetail(goal.progress.detail),
            estimated: goal.progress.estimated,
          },
  };
}

export function lookupTools({ database, ai, now = () => new Date() }: LookupOptions): AiTools {
  const search_transactions = aiTool({
    description: `Find Transactions. Every field set must match; leave a field null to skip it. Answers with up to ${LOOKUP_ROWS} Transactions, newest first, and the count and total of all matches. An amount is negative when money left the Account.`,
    input: z
      .object({
        merchant: z
          .string()
          .min(1)
          .max(100)
          .nullable()
          .describe(
            'Words that each start a word in the Merchant\'s name, in any case. "Exact words" in quotes; *text for text inside a word',
          ),
        category: z.enum(CATEGORY_NAMES).nullable(),
        account: ACCOUNT_NAME.nullable().describe("An Account name"),
        type: z.enum(TRANSACTION_TYPES).nullable(),
        from: DATE.nullable().describe("The first date, YYYY-MM-DD"),
        to: DATE.nullable().describe("The last date, YYYY-MM-DD"),
        minAmount: DOLLARS.nullable().describe("The least amount in dollars, either way"),
        maxAmount: DOLLARS.nullable().describe("The most amount in dollars, either way"),
      })
      .refine((input) => input.from === null || input.to === null || input.from <= input.to, {
        message: "from is on or before to.",
      })
      .refine(
        (input) =>
          input.minAmount === null ||
          input.maxAmount === null ||
          input.minAmount <= input.maxAmount,
        { message: "minAmount is at most maxAmount." },
      ),
    async run(input) {
      const names = await ai.accountNames();
      let accountId: string | undefined;
      if (input.account !== null) {
        accountId = accountWithName(names, input.account);
        if (accountId === undefined) return unknownName(names);
      }
      const found = await searchTransactions(
        database,
        {
          ...(accountId === undefined ? {} : { accountId }),
          ...(input.merchant === null ? {} : { merchant: input.merchant.trim() }),
          ...(input.category === null ? {} : { category: input.category }),
          ...(input.type === null ? {} : { type: input.type }),
          ...(input.from === null ? {} : { from: input.from }),
          ...(input.to === null ? {} : { to: input.to }),
          ...(input.minAmount === null ? {} : { minAmount: cents(input.minAmount) }),
          ...(input.maxAmount === null ? {} : { maxAmount: cents(input.maxAmount) }),
        },
        LOOKUP_ROWS,
      );
      const parts = await readShownParts(
        database,
        found.transactions.map((txn) => txn.id),
      );
      return {
        count: typedCount(found.count),
        total: typedAmount(found.total),
        transactions: found.transactions.map((txn) => {
          const shown = parts.get(txn.id) ?? [];
          return {
            date: typedDate(txn.shownDate),
            merchant: txn.merchantCleanName,
            amount: typedAmount(txn.amount),
            category: joined(shown.map((part) => part.category)),
            type: joined(shown.map((part) => part.type)),
            account: names.get(txn.accountId) ?? "Account",
            pending: txn.pending,
          };
        }),
      };
    },
  });

  const get_totals = aiTool({
    description: `Total Spending, Income, or Saving from posted Transactions in a date range, grouped by Category, Category group, Merchant, or month. Answers with up to ${LOOKUP_ROWS} rows of name and total in dollars, largest first, and the count of all rows. Only Spending has a Category.`,
    input: z
      .object({
        of: z.enum(TOTAL_KINDS),
        groupedBy: z.enum(TOTAL_GROUPINGS),
        from: DATE.describe("The first date, YYYY-MM-DD"),
        to: DATE.describe("The last date, YYYY-MM-DD"),
      })
      .refine((input) => input.from <= input.to, { message: "from is on or before to." })
      .refine(
        (input) =>
          input.of === "Spending" ||
          (input.groupedBy !== "Category" && input.groupedBy !== "Category group"),
        { message: "Only Spending has a Category." },
      ),
    async run(input) {
      const rows = await totalsBy(database, input.of, input.groupedBy, input);
      return {
        count: typedCount(rows.length),
        rows: rows.slice(0, LOOKUP_ROWS).map(({ name, total }) => ({
          name: input.groupedBy === "month" ? typedMonth(name) : name,
          total: typedAmount(total),
        })),
      };
    },
  });

  const get_balance_history = aiTool({
    description: `Balances over a date range for one Account, for Cash on hand, or for Debt. Answers with daily balances for a range of ${DAILY_DAYS} days or less, else month-end balances. Money owed is negative. An estimated balance is marked.`,
    input: z
      .object({
        of: z
          .enum(["Account", "Cash on hand", "Debt"])
          .describe("One Account, Cash on hand, or Debt"),
        account: ACCOUNT_NAME.nullable().describe("The Account name, for one Account"),
        from: DATE.describe("The first date, YYYY-MM-DD"),
        to: DATE.describe("The last date, YYYY-MM-DD"),
      })
      .refine((input) => input.from <= input.to, { message: "from is on or before to." })
      .refine((input) => (input.of === "Account") === (input.account !== null), {
        message: "An Account name is given for one Account, and only then.",
      }),
    async run(input) {
      const accounts = await listAccounts(database);
      let counted = accounts;
      let name: string = input.of;
      if (input.of === "Account") {
        const names = await ai.accountNames();
        const accountId = accountWithName(names, input.account ?? "");
        if (accountId === undefined) return unknownName(names);
        counted = accounts.filter((account) => account.id === accountId);
        name = names.get(accountId) ?? "Account";
      } else {
        counted = tileAccounts(accounts, input.of);
      }
      const today = await householdToday(database, now());
      const { daily, points } = await balanceHistory(database, counted, input, today);
      return {
        of: name,
        balances: daily ? "daily" : "month-end",
        points: points.map(({ date, balance, estimated }) => ({
          date: typedDate(date),
          balance: typedAmount(balance),
          estimated,
        })),
      };
    },
  });

  const get_recurring_charges = aiTool({
    description: `Recurring charges that are active or inactive, or only those in one Category. Answers with up to ${RECURRING_ROWS}, active first, soonest next date first, and the count of all: each one's Merchant, latest amount spent, interval, next date, Account name, and its ${PRICE_HISTORY_ROWS} latest Transactions as price history.`,
    input: z.object({ category: z.enum(CATEGORY_NAMES).nullable() }),
    async run(input) {
      const names = await ai.accountNames();
      const charges = (await recurringCharges(database, now()))
        .filter(
          (charge) =>
            charge.status !== "ended" &&
            (input.category === null || charge.category === input.category),
        )
        .sort(
          (a, b) =>
            Number(b.status === "active") - Number(a.status === "active") ||
            a.nextExpectedDate.localeCompare(b.nextExpectedDate) ||
            b.latestAmount - a.latestAmount ||
            a.merchant.name.localeCompare(b.merchant.name),
        );
      return {
        count: typedCount(charges.length),
        recurringCharges: charges.slice(0, RECURRING_ROWS).map((charge) => ({
          merchant: charge.merchant.name,
          category: charge.category,
          amount: typedAmount(charge.latestAmount),
          interval: charge.schedule,
          nextDate: typedDate(charge.nextExpectedDate),
          account: names.get(charge.accountId) ?? "Account",
          status: charge.status,
          priceHistory: charge.priceHistory
            .slice(-PRICE_HISTORY_ROWS)
            .map(({ date, amount }) => ({ date: typedDate(date), amount: typedAmount(amount) })),
        })),
      };
    },
  });

  const get_budgets_and_goals = aiTool({
    description:
      "Each Category's Budget, Spending, and status in a month, with Categories that have Spending and no Budget; the yearly Budgets, with the year's Spending through that month; and every Goal with its reading, progress, and status.",
    input: z.object({ month: MONTH.describe("The month, YYYY-MM") }),
    async run(input) {
      const at = now();
      const { budgets } = await budgetsForMonth(database, input.month);
      const spending = await budgetSpending(database, input.month, budgets, at);
      const names = await ai.accountNames();
      const goals = await readGoalsWithProgress(database, at);
      const withSpending = budgets.map((budget) => ({
        budget,
        found: spending.budgets.get(budget.category),
      }));
      return {
        budgets: [
          ...withSpending
            .filter(({ budget }) => budget.period === "monthly")
            .map(({ budget, found }) => ({
              category: budget.category,
              categoryGroup: budget.categoryGroup,
              budget: typedAmount(budget.amount),
              spending: typedAmount(found?.spending ?? 0),
              status: found?.status ?? "on track",
            })),
          ...spending.unbudgeted.map((each) => ({
            category: each.category,
            categoryGroup: categoryGroupOf(each.category),
            budget: null,
            spending: typedAmount(each.spending),
            status: null,
          })),
        ],
        yearlyBudgets: withSpending
          .filter(({ budget }) => budget.period === "yearly")
          .map(({ budget, found }) => ({
            category: budget.category,
            budget: typedAmount(budget.amount),
            spendingThisYear: typedAmount(found?.spending ?? 0),
            shareOfYear: `${Math.round((found?.shareOfYear ?? 0) * 100)}%`,
            status: found?.status ?? "on track",
          })),
        goals: goals.map((goal) => goalOf(goal, names)),
      };
    },
  });

  return {
    search_transactions,
    get_totals,
    get_balance_history,
    get_recurring_charges,
    get_budgets_and_goals,
  };
}
