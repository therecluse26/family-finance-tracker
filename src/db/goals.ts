import {
  aliasedTable,
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { isGoalRunOf } from "./budget-tailoring.ts";
import type { Database } from "./client.ts";
import { goals, proposals, spendingLinks, transactionParts, transactions } from "./schema.ts";

// Goals in app.db (spec 05, Goals). The goals module decides; these functions store and read.

export type StoredGoal = typeof goals.$inferSelect;
export type GoalStatus = StoredGoal["status"];

export type NewGoal = Pick<
  StoredGoal,
  "words" | "authorId" | "date" | "target" | "change" | "deadline"
>;

// The Goal amount and its start, as they take effect (spec 05, Progress).
export type GoalStart = Pick<StoredGoal, "goalAmount" | "startsOn" | "startBalance" | "baseline">;

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

// Stores an active Goal with no Goal amount yet. Returns its ID.
export async function addGoal(database: Database, goal: NewGoal): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(goals).values({ id, ...goal, status: "active" });
  return id;
}

// Every Goal, oldest first: by date, then in the order they were added.
export async function listGoals(database: Database): Promise<StoredGoal[]> {
  return database.select().from(goals).orderBy(asc(goals.date), asc(sql`rowid`));
}

export async function readGoal(database: Database, id: string): Promise<StoredGoal | undefined> {
  const [row] = await database.select().from(goals).where(eq(goals.id, id));
  return row;
}

// Sets an active Goal's amount and start. False when no active Goal has the ID.
export async function storeGoalStart(
  database: Database,
  id: string,
  start: GoalStart,
): Promise<boolean> {
  const updated = await database
    .update(goals)
    .set(start)
    .where(and(eq(goals.id, id), eq(goals.status, "active")))
    .returning({ id: goals.id });
  return updated.length === 1;
}

// A Goal's new words and the AI's reading of them (spec 05, Rules). The Goal amount and its start
// are cleared in the same transaction, and the Goal's open Proposals made for the old words close
// as replaced: its Goal amount Proposals, and its Goal runs' Budget change Proposals. The Goal run
// for the new words makes their replacements. False when no active Goal has the ID, which changes
// nothing.
export async function storeGoalWords(
  database: Database,
  id: string,
  words: Pick<StoredGoal, "words" | "target" | "change" | "deadline">,
  at: Date,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(goals)
      .set({ ...words, goalAmount: null, startsOn: null, startBalance: null, baseline: null })
      .where(and(eq(goals.id, id), eq(goals.status, "active")))
      .returning({ id: goals.id });
    if (updated.length !== 1) return false;
    await tx
      .update(proposals)
      .set({ status: "replaced", closedAt: at })
      .where(
        and(
          eq(proposals.status, "open"),
          or(
            and(eq(proposals.kind, "Goal amount"), eq(proposals.goalId, id)),
            and(
              eq(proposals.kind, "Budget change"),
              eq(proposals.source, "Budget tailoring"),
              isGoalRunOf(proposals.runId, id),
            ),
          ),
        ),
      );
    return true;
  });
}

// Marks each of these active Goals done or dropped, on `endedOn`. `endedBy` is the Member who
// marked it, or null when the app set it to done. Returns the IDs it changed: a Goal that is done
// or dropped already keeps its status and its day.
export async function endGoals(
  database: Database,
  ids: readonly string[],
  end: { status: Exclude<GoalStatus, "active">; endedOn: string; endedBy: string | null },
): Promise<string[]> {
  const ended: string[] = [];
  for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
    const rows = await database
      .update(goals)
      .set(end)
      .where(
        and(inArray(goals.id, ids.slice(start, start + IDS_PER_QUERY)), eq(goals.status, "active")),
      )
      .returning({ id: goals.id });
    ended.push(...rows.map((row) => row.id));
  }
  return ended;
}

const shownAndPosted = () =>
  and(eq(transactions.pending, false), isNull(transactions.hiddenReason)) as SQL;

// The day the money moved: the purchase date when there is one, else the posted date. A
// Transaction counts in this day's month (spec 04, Which month a Transaction counts in).
const purchaseDate = (table: typeof transactions) =>
  sql<string>`coalesce(${table.authorizedDate}, ${table.postedDate})`;

// The Spending, Refund and Reimbursement parts of shown, posted Transactions whose purchase date is
// `from` or later, each with its Transaction, type, Category, purchase date and Merchant. A linked
// Refund or Reimbursement carries its Spending's date and Merchant, as the totals count it. Amounts
// have the Transaction sign: Spending is negative.
export async function listSpendingPartsSince(
  database: Database,
  from: string,
): Promise<
  {
    transactionId: string;
    type: (typeof transactionParts.$inferSelect)["type"];
    category: string | null;
    amount: number;
    date: string;
    merchantId: string | null;
    merchantName: string | null;
  }[]
> {
  const spent = aliasedTable(transactions, "spent");
  const linked = sql`${spent.id} IS NOT NULL`;
  const either = <T>(spentColumn: SQLWrapper, ownColumn: SQLWrapper) =>
    sql<T>`CASE WHEN ${linked} THEN ${spentColumn} ELSE ${ownColumn} END`;
  const date = either<string>(purchaseDate(spent), purchaseDate(transactions));
  return database
    .select({
      transactionId: transactions.id,
      type: transactionParts.type,
      category: transactionParts.category,
      amount: transactionParts.amount,
      date,
      merchantId: either<string | null>(spent.merchantId, transactions.merchantId),
      merchantName: either<string | null>(spent.merchantCleanName, transactions.merchantCleanName),
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .leftJoin(
      spendingLinks,
      and(eq(transactionParts.linked, true), eq(spendingLinks.transactionId, transactions.id)),
    )
    .leftJoin(spent, eq(spent.id, spendingLinks.spendingTransactionId))
    .where(
      and(
        inArray(transactionParts.type, ["Spending", "Refund", "Reimbursement"]),
        shownAndPosted(),
        sql`${date} >= ${from}`,
      ),
    );
}

// The sum of the Saving parts of shown, posted Transactions whose purchase date is `from` or later.
// Saving is money out of the Account, so the sum is negative when money went in.
export async function sumSavingSince(database: Database, from: string): Promise<number> {
  const [row] = await database
    .select({ total: sql<number | null>`sum(${transactionParts.amount})` })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Saving"),
        shownAndPosted(),
        sql`${purchaseDate(transactions)} >= ${from}`,
      ),
    );
  return row?.total ?? 0;
}
