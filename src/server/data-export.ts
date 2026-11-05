import { categoryGroupOf, isCategory } from "../categories/list.ts";
import {
  type Database,
  EXPORTED_TABLES,
  listCategoryRules,
  listEveryBudget,
  listGoals,
  listMemberNamesById,
  readExportedJson,
  readExportedTransactions,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { goalReadingOf } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import type { Logger } from "../log.ts";
import type { BankViews } from "./bank-views.ts";
import type { DataExportRoutes } from "./data-export-views.ts";
import { type ZipFile, zipStream } from "./zip.ts";

// "Download my data" (spec 11, Data export): one ZIP file with five CSV files and data.json. Every
// file is written as the ZIP streams, a page of rows at a time, so the export never holds the whole
// history. What data.json holds is the db module's allowlist; it holds no secret.

// A cell a spreadsheet would run as a formula starts with one of these (OWASP, CSV Injection).
const FORMULA_START = /^[=+\-@\t\r]/;

// A text cell: a single quote before a formula's first character, so a spreadsheet shows the text
// and runs nothing, then quoted when it holds a comma, a quote, or a line break (RFC 4180).
export function csvText(value: string | null): string {
  if (value === null) return "";
  const shown = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(shown) ? `"${shown.replaceAll('"', '""')}"` : shown;
}

// An amount in dollars, with 2 decimals and no currency sign, such as -12.34. It holds only digits,
// a point, and a leading minus, which a spreadsheet reads as a number.
export function csvAmount(cents: number | null): string {
  if (cents === null) return "";
  const whole = Math.abs(cents);
  const dollars = `${Math.trunc(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${dollars}` : dollars;
}

const csvFlag = (value: boolean | null) => (value === null ? "" : String(value));

// One line of cells already written by csvText, csvAmount, or csvFlag.
const csvLine = (cells: readonly string[]) => `${cells.join(",")}\r\n`;

const header = (columns: readonly string[]) => csvLine(columns.map(csvText));

const groupOf = (category: string | null) =>
  category !== null && isCategory(category) ? categoryGroupOf(category) : null;

const TRANSACTION_COLUMNS = [
  "id",
  "date",
  "account",
  "merchant",
  "description",
  "amount",
  "category",
  "category_group",
  "kind",
  "status",
  "linked_ids",
] as const;

// Each Transaction that shows, one row per part. Its date is the purchase date when the bank gives
// one, else the posted date (spec 04). A Transaction Matching has not decided yet has one row with
// no Category and no kind.
async function* transactionsCsv(
  database: Database,
  accountNames: ReadonlyMap<string, string>,
): AsyncGenerator<string> {
  yield header(TRANSACTION_COLUMNS);
  for await (const page of readExportedTransactions(database)) {
    let lines = "";
    for (const txn of page) {
      const parts =
        txn.parts.length === 0 ? [{ type: null, amount: txn.amount, category: null }] : txn.parts;
      for (const part of parts) {
        lines += csvLine([
          csvText(txn.id),
          csvText(txn.authorizedDate ?? txn.postedDate),
          csvText(accountNames.get(txn.accountId) ?? null),
          csvText(txn.merchant),
          csvText(txn.description),
          csvAmount(part.amount),
          csvText(part.category),
          csvText(groupOf(part.category)),
          csvText(part.type),
          csvText(txn.pending ? "pending" : "posted"),
          csvText(txn.linkedIds.join(";")),
        ]);
      }
    }
    yield lines;
  }
}

const ACCOUNT_COLUMNS = [
  "id",
  "name",
  "kind",
  "subtype",
  "institution",
  "last_4",
  "current_balance",
  "available_balance",
  "credit_limit",
  "estimated",
  "excluded",
  "closed",
] as const;

// Each Account as the Accounts page shows it. A Closed or excluded Account shows no balance.
async function* accountsCsv(bank: BankViews): AsyncGenerator<string> {
  yield header(ACCOUNT_COLUMNS);
  for (const account of await bank.accounts()) {
    yield csvLine([
      csvText(account.id),
      csvText(account.name),
      csvText(account.kind),
      csvText(account.subtype),
      csvText(account.institutionName),
      csvText(account.mask),
      csvAmount(account.currentBalance),
      csvAmount(account.availableBalance),
      csvAmount(account.creditLimit),
      csvFlag(account.estimated),
      csvFlag(account.excluded),
      csvFlag(account.closed),
    ]);
  }
}

// The facts each CSV file but transactions.csv names: Members by name, and the Household's dates.
type Names = { members: ReadonlyMap<string, string>; day: (moment: Date | null) => string | null };

const BUDGET_COLUMNS = [
  "category",
  "category_group",
  "amount",
  "period",
  "takes_effect",
  "source",
  "set_by",
  "set_on",
  "pinned",
  "ends_budget",
  "reason",
] as const;

// Every Budget record, oldest first: a month uses the newest one in effect, so earlier ones stay.
// A record that ends a Category's Budget has an amount of 0.
async function* budgetsCsv(database: Database, names: Names): AsyncGenerator<string> {
  yield header(BUDGET_COLUMNS);
  for (const budget of await listEveryBudget(database)) {
    yield csvLine([
      csvText(budget.category),
      csvText(groupOf(budget.category)),
      csvAmount(budget.amount),
      csvText(budget.period),
      csvText(budget.takesEffect),
      csvText(budget.source),
      csvText(names.members.get(budget.setBy ?? "") ?? null),
      csvText(names.day(budget.setAt)),
      csvFlag(budget.pinned),
      csvFlag(budget.noBudget),
      csvText(budget.reason),
    ]);
  }
}

const GOAL_COLUMNS = [
  "id",
  "words",
  "author",
  "date",
  "status",
  "ended_on",
  "ended_by",
  "target",
  "change_amount",
  "change_percent",
  "deadline",
  "goal_amount",
  "starts_on",
] as const;

// Each Goal, with the AI's reading: its target, the change it asks for, and its deadline.
async function* goalsCsv(
  database: Database,
  names: Names,
  accountNames: ReadonlyMap<string, string>,
): AsyncGenerator<string> {
  yield header(GOAL_COLUMNS);
  const account = (id: string) => accountNames.get(id) ?? id;
  for (const goal of await listGoals(database)) {
    const { target, change } = goalReadingOf(goal);
    let targetText: string | null = null;
    if (target?.kind === "Category") targetText = target.category;
    else if (target?.kind === "Merchant") targetText = target.merchant.name;
    else if (target?.kind === "Saving") targetText = "Saving";
    else if (target?.kind === "Accounts") targetText = target.accountIds.map(account).join(";");
    else if (target?.kind === "loan") targetText = account(target.accountId);
    yield csvLine([
      csvText(goal.id),
      csvText(goal.words),
      csvText(names.members.get(goal.authorId ?? "") ?? null),
      csvText(goal.date),
      csvText(goal.status),
      csvText(goal.endedOn),
      csvText(names.members.get(goal.endedBy ?? "") ?? null),
      csvText(targetText),
      csvAmount(change !== null && "amount" in change ? change.amount : null),
      csvText(change !== null && "percent" in change ? String(change.percent) : null),
      csvText(goal.deadline),
      csvAmount(goal.goalAmount),
      csvText(goal.startsOn),
    ]);
  }
}

const RULE_COLUMNS = ["id", "merchant", "category", "category_group", "made_on", "made_by"];

// Each Category rule, by Merchant name.
async function* categoryRulesCsv(database: Database, names: Names): AsyncGenerator<string> {
  yield header(RULE_COLUMNS);
  for (const rule of await listCategoryRules(database)) {
    yield csvLine([
      csvText(rule.id),
      csvText(rule.merchantName),
      csvText(rule.category),
      csvText(groupOf(rule.category)),
      csvText(names.day(rule.madeAt)),
      csvText(names.members.get(rule.madeBy ?? "") ?? null),
    ]);
  }
}

// data.json: each table on the db module's allowlist, as app.db holds it, by column name.
async function* dataJson(database: Database, at: Date): AsyncGenerator<string> {
  const about = {
    exported_at: at,
    amounts: "Whole cents. Money into an Account is positive; money out is negative.",
    dates: "Calendar dates are YYYY-MM-DD. Moments are in UTC.",
  };
  yield `{"about":${JSON.stringify(about)},"tables":{`;
  for (const [index, entry] of EXPORTED_TABLES.entries()) {
    yield `${index === 0 ? "" : ","}${JSON.stringify(entry.name)}:[`;
    let first = true;
    for await (const page of readExportedJson(database, entry)) {
      yield `${first ? "" : ","}${page}`;
      first = false;
    }
    yield "]";
  }
  yield "}}";
}

export function dataExportRoutes(
  database: Database,
  bank: BankViews,
  logger: Logger,
): DataExportRoutes {
  return {
    async download() {
      const at = new Date();
      const zone = (await householdTimeZone(database)) ?? "UTC";
      // The Account names and Member names, read once each, when the first file that needs them
      // starts.
      let accountNames: Promise<Map<string, string>> | undefined;
      const accounts = () => {
        accountNames ??= bank
          .accounts()
          .then((all) => new Map(all.map((account) => [account.id, account.name])));
        return accountNames;
      };
      let names: Promise<Names> | undefined;
      const people = () => {
        names ??= listMemberNamesById(database).then((all) => ({
          members: new Map(all.map((member) => [member.id, member.name])),
          day: (moment) => (moment === null ? null : calendarDateIn(moment, zone)),
        }));
        return names;
      };
      const files: ZipFile[] = [
        {
          name: "transactions.csv",
          content: async function* () {
            yield* transactionsCsv(database, await accounts());
          },
        },
        { name: "accounts.csv", content: () => accountsCsv(bank) },
        {
          name: "budgets.csv",
          content: async function* () {
            yield* budgetsCsv(database, await people());
          },
        },
        {
          name: "goals.csv",
          content: async function* () {
            yield* goalsCsv(database, await people(), await accounts());
          },
        },
        {
          name: "category-rules.csv",
          content: async function* () {
            yield* categoryRulesCsv(database, await people());
          },
        },
        { name: "data.json", content: () => dataJson(database, at) },
      ];
      const zip = zipStream(files, at);
      // A failure after the download started cuts the file short, so the browser reports it. The
      // log line names the failure, never the file's content.
      async function* logged(): AsyncGenerator<Uint8Array> {
        try {
          for await (const bytes of zip) yield bytes;
        } catch (error) {
          logger.error("The data export stopped before its end", { error });
          throw error;
        }
      }
      return {
        fileName: `family-finance-data-${calendarDateIn(at, zone)}.zip`,
        stream: ReadableStream.from(logged()),
      };
    },
  };
}
