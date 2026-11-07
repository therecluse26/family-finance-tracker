import { aliasedTable, and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database, Queries } from "./client.ts";
import type { LinkMaker, SpendingLinkKind, TransferLinkMaker } from "./links.ts";
import {
  householdAccounts,
  loanLinks,
  members,
  spendingLinks,
  transactionDecisions,
  transactionParts,
  transactions,
  transferLinks,
} from "./schema.ts";

// Each Transaction's type and parts (spec 03, Order of decisions). The money-movement module
// decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type StoredPart = typeof transactionParts.$inferSelect;
export type PartType = StoredPart["type"];

export type CategorySource = NonNullable<StoredPart["categorySource"]>;
export type CategoryConfidence = NonNullable<StoredPart["categoryConfidence"]>;

// A part as a decision stores it. The categorization step fills the Category's provenance later,
// unless the part carries it over from the pending Transaction it replaces.
export type NewPart = Pick<StoredPart, "type" | "amount" | "category"> &
  Partial<
    Pick<
      StoredPart,
      "keepsCategory" | "linked" | "categorySource" | "categoryConfidence" | "categoryNeedsAi"
    >
  >;

export type StoredDecision = {
  transactionId: string;
  step: string;
  provisionalUntil: string | null;
  decidedAt: Date;
  parts: NewPart[];
};

// What the order of decisions reads of a Transaction.
export type DecisionRecord = {
  id: string;
  // The adapter's stable ID. A tie between Transactions breaks on it, never on the random `id`.
  providerTransactionId: string;
  accountId: string;
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
  merchantId: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  // The other parties named on it, with their types, such as "payment_app".
  counterparties: { name: string; type: string }[];
  handSet: Record<string, unknown>;
  // Who made the Transfer link that uses it, or null when it has none.
  transferLink: TransferLinkMaker | null;
  // The other side of that link, or null.
  otherSide: { transactionId: string; accountId: string; postedDate: string } | null;
  // The Manual loan it links to, as its payment or payout, and who made the link; or null.
  loanLink: { loanAccountId: string; madeBy: LinkMaker } | null;
  // The Spending it reduces, as a Refund or a Reimbursement, and who made the link; or null.
  spendingLink: { kind: SpendingLinkKind; spendingTransactionId: string; madeBy: LinkMaker } | null;
  hidden: boolean;
};

// One of the Household's Accounts, as the order of decisions reads it.
export type DecisionAccount = {
  id: string;
  // The Member's rename, or the name from the provider or the form.
  name: string;
  kind: string;
  subtype: string | null;
  institutionName: string | null;
  // The last 4 digits.
  mask: string | null;
  // False for an Account that no provider syncs.
  connected: boolean;
  closed: boolean;
  // When and why it was Closed, or null while it is open (spec 02, Closed Accounts).
  closedAt: Date | null;
  closedReason: (typeof householdAccounts.$inferSelect)["closedReason"];
  // A Member turned on its Exclude switch (spec 02, Exclude).
  excluded: boolean;
  // A loan's type as a Member set it, or null while the app decides it.
  loanType: "cash loan" | "purchase loan" | null;
  // An APR a Member typed on a loan, as a percent, such as 6.5.
  memberApr: number | null;
};

export async function listDecisionAccounts(database: Database): Promise<DecisionAccount[]> {
  const rows = await database
    .select({
      id: householdAccounts.id,
      name: householdAccounts.name,
      memberName: householdAccounts.memberName,
      kind: householdAccounts.kind,
      subtype: householdAccounts.subtype,
      institutionName: householdAccounts.institutionName,
      mask: householdAccounts.mask,
      connectionId: householdAccounts.connectionId,
      closedAt: householdAccounts.closedAt,
      closedReason: householdAccounts.closedReason,
      excluded: householdAccounts.excluded,
      loanType: householdAccounts.loanType,
      memberApr: householdAccounts.memberApr,
    })
    .from(householdAccounts)
    .orderBy(asc(householdAccounts.name), asc(householdAccounts.id));
  return rows.map(({ memberName, connectionId, ...row }) => ({
    ...row,
    name: memberName ?? row.name,
    connected: connectionId !== null,
    closed: row.closedAt !== null,
  }));
}

// Each Member's name, as a Member typed it (spec 03, Payment apps: a Zelle line names a Member).
export async function listMemberNames(database: Database): Promise<string[]> {
  const rows = await database.select({ name: members.name }).from(members);
  return rows.map((row) => row.name);
}

// The Transactions that show on an Account, oldest first.
export async function listAccountTransactionIds(
  database: Queries,
  accountId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), isNull(transactions.hiddenReason)))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

// The Transactions among these IDs whose type a Member set by hand.
export async function listHandSetTypes(
  database: Queries,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, chunk),
          sql`json_extract(${transactions.handSet}, '$.type') IS NOT NULL`,
        ),
      );
    for (const { id } of rows) found.add(id);
  }
  return found;
}

// The Transactions with these IDs, in the order given. An unknown ID is left out.
export async function readDecisionRecords(
  database: Database,
  ids: readonly string[],
): Promise<DecisionRecord[]> {
  const other = alias(transactions, "other_side");
  const found = new Map<string, DecisionRecord>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        providerTransactionId: transactions.providerTransactionId,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        pending: transactions.pending,
        description: transactions.description,
        merchantName: transactions.merchantName,
        merchantId: transactions.merchantId,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        counterparties: transactions.counterparties,
        handSet: transactions.handSet,
        transferLink: transferLinks.madeBy,
        otherId: other.id,
        otherAccountId: other.accountId,
        otherPostedDate: other.postedDate,
        loanAccountId: loanLinks.loanAccountId,
        loanLinkMadeBy: loanLinks.madeBy,
        spendingLinkKind: spendingLinks.kind,
        spendingTransactionId: spendingLinks.spendingTransactionId,
        spendingLinkMadeBy: spendingLinks.madeBy,
        hiddenReason: transactions.hiddenReason,
      })
      .from(transactions)
      .leftJoin(
        transferLinks,
        or(
          eq(transferLinks.outTransactionId, transactions.id),
          eq(transferLinks.inTransactionId, transactions.id),
        ),
      )
      .leftJoin(
        other,
        or(
          and(
            eq(transferLinks.outTransactionId, transactions.id),
            eq(other.id, transferLinks.inTransactionId),
          ),
          and(
            eq(transferLinks.inTransactionId, transactions.id),
            eq(other.id, transferLinks.outTransactionId),
          ),
        ),
      )
      .leftJoin(loanLinks, eq(loanLinks.transactionId, transactions.id))
      .leftJoin(spendingLinks, eq(spendingLinks.transactionId, transactions.id))
      .where(inArray(transactions.id, chunk));
    for (const {
      hiddenReason,
      otherId,
      otherAccountId,
      otherPostedDate,
      loanAccountId,
      loanLinkMadeBy,
      spendingLinkKind,
      spendingTransactionId,
      spendingLinkMadeBy,
      ...row
    } of rows) {
      const otherSide =
        otherId === null || otherAccountId === null || otherPostedDate === null
          ? null
          : { transactionId: otherId, accountId: otherAccountId, postedDate: otherPostedDate };
      const loanLink =
        loanAccountId === null || loanLinkMadeBy === null
          ? null
          : { loanAccountId, madeBy: loanLinkMadeBy };
      const spendingLink =
        spendingLinkKind === null || spendingTransactionId === null || spendingLinkMadeBy === null
          ? null
          : { kind: spendingLinkKind, spendingTransactionId, madeBy: spendingLinkMadeBy };
      found.set(row.id, {
        ...row,
        otherSide,
        loanLink,
        spendingLink,
        hidden: hiddenReason !== null,
      });
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// Saves each decision in place of the Transaction's earlier one.
export async function storeDecisions(
  database: Database,
  decisions: readonly StoredDecision[],
): Promise<void> {
  if (decisions.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(decisions)) {
      const ids = chunk.map((decision) => decision.transactionId);
      await tx.delete(transactionDecisions).where(inArray(transactionDecisions.transactionId, ids));
      await tx.insert(transactionDecisions).values(chunk.map(({ parts, ...decision }) => decision));
      const parts = chunk.flatMap((decision) =>
        decision.parts.map((part, index) => ({
          transactionId: decision.transactionId,
          part: index,
          ...part,
        })),
      );
      if (parts.length > 0) await tx.insert(transactionParts).values(parts);
    }
  });
}

export async function removeDecisions(database: Database, ids: readonly string[]): Promise<void> {
  for (const chunk of chunks(ids)) {
    await database
      .delete(transactionDecisions)
      .where(inArray(transactionDecisions.transactionId, chunk));
  }
}

export async function readDecision(
  database: Database,
  transactionId: string,
): Promise<StoredDecision | undefined> {
  const [decision] = await database
    .select()
    .from(transactionDecisions)
    .where(eq(transactionDecisions.transactionId, transactionId));
  if (decision === undefined) return undefined;
  const rows = await database
    .select({
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
      linked: transactionParts.linked,
    })
    .from(transactionParts)
    .where(eq(transactionParts.transactionId, transactionId))
    .orderBy(asc(transactionParts.part));
  // A linked part shows its Spending's Category.
  const spending = rows.some((row) => row.linked)
    ? (await readLinkedSpending(database, [transactionId])).get(transactionId)
    : undefined;
  const parts = rows.map(({ linked, ...part }) =>
    linked ? { ...part, linked, category: spending?.category ?? null } : part,
  );
  return { ...decision, parts };
}

// The Transactions whose provisional result ended before `today`, oldest first.
export async function listProvisionalPassed(database: Database, today: string): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .innerJoin(transactions, eq(transactions.id, transactionDecisions.transactionId))
    .where(lt(transactionDecisions.provisionalUntil, today))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

// The Transactions whose result came from one of these steps, oldest first.
export async function listDecidedAt(
  database: Queries,
  steps: readonly string[],
): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .innerJoin(transactions, eq(transactions.id, transactionDecisions.transactionId))
    .where(inArray(transactionDecisions.step, [...steps]))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

type LinkedSpending = {
  spendingTransactionId: string;
  postedDate: string;
  authorizedDate: string | null;
  category: string | null;
  // Posted and not hidden: the Spending counts in the totals.
  counted: boolean;
};

// The Spending that each linked Refund or Reimbursement reduces, by the money in's ID: its ID, its
// dates, which give the month, the Category of its first Spending part that has one, and whether it
// counts. Reads every link, or the links of these Transactions.
async function readLinkedSpending(
  database: Queries,
  moneyIds?: readonly string[],
): Promise<Map<string, LinkedSpending>> {
  const spent = aliasedTable(transactions, "spent");
  const firstCategory = sql<string | null>`(
    SELECT ${transactionParts.category} FROM ${transactionParts}
    WHERE ${transactionParts.transactionId} = ${spent.id}
      AND ${transactionParts.type} = 'Spending'
      AND ${transactionParts.category} IS NOT NULL
    ORDER BY ${transactionParts.part} LIMIT 1
  )`;
  const select = () =>
    database
      .select({
        moneyId: spendingLinks.transactionId,
        spendingTransactionId: spent.id,
        postedDate: spent.postedDate,
        authorizedDate: spent.authorizedDate,
        category: firstCategory,
        pending: spent.pending,
        hiddenReason: spent.hiddenReason,
      })
      .from(spendingLinks)
      .innerJoin(spent, eq(spent.id, spendingLinks.spendingTransactionId));
  const rows: Awaited<ReturnType<typeof select>> = [];
  if (moneyIds === undefined) rows.push(...(await select()));
  for (const chunk of chunks(moneyIds ?? [])) {
    rows.push(...(await select().where(inArray(spendingLinks.transactionId, chunk))));
  }
  return new Map(
    rows.map(({ moneyId, pending, hiddenReason, ...spending }) => [
      moneyId,
      { ...spending, counted: !pending && hiddenReason === null },
    ]),
  );
}

// Divides `total` in proportion to `weights`, in whole cents. The shares add up to `total`: each
// takes its whole cents, and the cents left over go to the largest remainders, the earlier one
// first on a tie. Weights that add up to 0 or less give the whole total to the first.
export function inProportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((all, weight) => all + weight, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const exact = weights.map((weight) => (total * weight) / sum);
  const shares = exact.map(Math.trunc);
  let left = total - shares.reduce((all, share) => all + share, 0);
  const step = Math.sign(left);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: Math.abs(value - Math.trunc(value)) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    shares[index] = (shares[index] ?? 0) + step;
    left -= step;
  }
  return shares;
}

type SpendingPart = { category: string | null; amount: number };

// The Spending parts of the Spending that each linked Refund or Reimbursement reduces, by the money
// in's ID, in part order: one statement for every link, or for the links of these Transactions.
async function readLinkedSpendingParts(
  database: Queries,
  moneyIds?: readonly string[],
): Promise<Map<string, SpendingPart[]>> {
  const select = () =>
    database
      .select({
        moneyId: spendingLinks.transactionId,
        category: transactionParts.category,
        amount: transactionParts.amount,
      })
      .from(spendingLinks)
      .innerJoin(
        transactionParts,
        and(
          eq(transactionParts.transactionId, spendingLinks.spendingTransactionId),
          eq(transactionParts.type, "Spending"),
        ),
      )
      .orderBy(asc(spendingLinks.transactionId), asc(transactionParts.part));
  const rows: Awaited<ReturnType<typeof select>> = [];
  if (moneyIds === undefined) rows.push(...(await select()));
  for (const chunk of chunks(moneyIds ?? [])) {
    rows.push(...(await select().where(inArray(spendingLinks.transactionId, chunk))));
  }
  const parts = new Map<string, SpendingPart[]>();
  for (const { moneyId, ...part } of rows) {
    const found = parts.get(moneyId);
    if (found === undefined) parts.set(moneyId, [part]);
    else found.push(part);
  }
  return parts;
}

// A linked Refund or Reimbursement part, as one part for each Spending part of its Spending, such as
// a split (spec 04, Splits): in proportion to their amounts, each with that part's Category. With
// fewer than 2 Spending parts, it stays one part.
function spreadLinked<Row extends SpendingPart>(
  row: Row,
  spending: readonly SpendingPart[],
): Row[] {
  if (spending.length < 2) return [row];
  // Spending is money out, so each part's amount is negative.
  const shares = inProportion(
    row.amount,
    spending.map((part) => -part.amount),
  );
  return spending.map((part, index) => ({
    ...row,
    amount: shares[index] ?? 0,
    category: part.category,
  }));
}

// Every part of every posted Transaction that is not hidden, with the dates its month comes from.
// A linked Refund or Reimbursement part has its Spending's ID, dates, and Category instead (spec 03,
// Which month a link changes); every other part has a null spendingTransactionId. It counts only
// while its Spending counts: a Spending still pending, or hidden, counts nowhere, so neither does
// the part that reduces it (spec 05, Formula terms). While its link is gone, before Matching decides
// it again, it keeps its own. When its Spending has several Spending
// parts, such as a split (spec 04, Splits), the linked part becomes one part for each of them, in
// proportion to their amounts, each with that part's Category.
export async function listPostedParts(database: Database) {
  const rows = await database
    .select({
      transactionId: transactionParts.transactionId,
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
      linked: transactionParts.linked,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(and(eq(transactions.pending, false), isNull(transactions.hiddenReason)));
  const anyLinked = rows.some((row) => row.linked);
  const spending = anyLinked
    ? await readLinkedSpending(database)
    : new Map<string, LinkedSpending>();
  const spendingParts = anyLinked
    ? await readLinkedSpendingParts(database)
    : new Map<string, SpendingPart[]>();
  return rows.flatMap(
    (row): ((typeof rows)[number] & { spendingTransactionId: string | null })[] => {
      const found = row.linked ? spending.get(row.transactionId) : undefined;
      if (found === undefined) return [{ ...row, spendingTransactionId: null }];
      const { counted, ...linked } = found;
      if (!counted) return [];
      return spreadLinked({ ...row, ...linked }, spendingParts.get(row.transactionId) ?? []);
    },
  );
}

// A part as the Transactions page shows it, with the provenance of its Category (spec 04,
// Provenance).
export type ShownPart = {
  type: PartType;
  amount: number;
  category: string | null;
  // The part of a Refund or Reimbursement that its link reduces. It has its Spending's Category,
  // and no provenance of its own.
  linked: boolean;
  categorySource: CategorySource | null;
  categoryConfidence: CategoryConfidence | null;
};

// The parts of each of these Transactions, in part order, by ID; a Transaction Matching has not
// decided is left out. A linked Refund or Reimbursement part has its Spending's Category, as
// listPostedParts gives it: one part for each Spending part, so a Refund on a split purchase shows
// per part. While its link is gone, before Matching decides it again, it keeps its own. One
// statement for each 500 Transactions, and two more for the links among them.
export async function readShownParts(
  database: Queries,
  transactionIds: readonly string[],
): Promise<Map<string, ShownPart[]>> {
  const rows: (ShownPart & { transactionId: string })[] = [];
  for (const chunk of chunks([...new Set(transactionIds)])) {
    rows.push(
      ...(await database
        .select({
          transactionId: transactionParts.transactionId,
          type: transactionParts.type,
          amount: transactionParts.amount,
          category: transactionParts.category,
          linked: transactionParts.linked,
          categorySource: transactionParts.categorySource,
          categoryConfidence: transactionParts.categoryConfidence,
        })
        .from(transactionParts)
        .where(inArray(transactionParts.transactionId, chunk))
        .orderBy(asc(transactionParts.transactionId), asc(transactionParts.part))),
    );
  }
  const linkedIds = [...new Set(rows.filter((row) => row.linked).map((row) => row.transactionId))];
  const spending = await readLinkedSpending(database, linkedIds);
  const spendingParts = await readLinkedSpendingParts(database, linkedIds);
  const shown = new Map<string, ShownPart[]>();
  for (const { transactionId, ...part } of rows) {
    const found = part.linked ? spending.get(transactionId) : undefined;
    const parts =
      found === undefined
        ? [part]
        : spreadLinked(
            { ...part, category: found.category, categorySource: null, categoryConfidence: null },
            spendingParts.get(transactionId) ?? [],
          );
    const listed = shown.get(transactionId);
    if (listed === undefined) shown.set(transactionId, parts);
    else listed.push(...parts);
  }
  return shown;
}

// The parts of the pending Transaction that each posted one replaces, with their Categories' provenance,
// by the posted Transaction's ID (spec 03, Pending Transactions). Read before Matching removes the
// hidden pending Transaction's result.
export async function readPendingParts(
  database: Database,
  postedIds: readonly string[],
): Promise<Map<string, StoredPart[]>> {
  const pending = aliasedTable(transactions, "pending");
  const found = new Map<string, StoredPart[]>();
  for (const chunk of chunks(postedIds)) {
    const rows = await database
      .select({ postedId: transactions.id, part: transactionParts })
      .from(transactions)
      .innerJoin(
        pending,
        and(
          eq(pending.connectionId, transactions.connectionId),
          eq(pending.providerTransactionId, transactions.pendingTransactionId),
        ),
      )
      .innerJoin(transactionParts, eq(transactionParts.transactionId, pending.id))
      .where(and(inArray(transactions.id, chunk), isNotNull(transactions.pendingTransactionId)))
      .orderBy(asc(transactionParts.part));
    for (const { postedId, part } of rows) {
      found.set(postedId, [...(found.get(postedId) ?? []), part]);
    }
  }
  return found;
}

// What the categorization cascade reads of a Transaction, with its parts.
export type CategoryRecord = {
  id: string;
  postedDate: string;
  hidden: boolean;
  merchantId: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  providerCategoryConfidence: string | null;
  handSet: Record<string, unknown>;
  parts: Pick<
    StoredPart,
    "part" | "type" | "category" | "keepsCategory" | "linked" | "categorySource" | "categoryNeedsAi"
  >[];
};

// The Transactions with these IDs, in the order given. An unknown ID is left out.
export async function readCategoryRecords(
  database: Queries,
  ids: readonly string[],
): Promise<CategoryRecord[]> {
  const found = new Map<string, CategoryRecord>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        postedDate: transactions.postedDate,
        hiddenReason: transactions.hiddenReason,
        merchantId: transactions.merchantId,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        providerCategoryConfidence: transactions.providerCategoryConfidence,
        handSet: transactions.handSet,
        part: {
          part: transactionParts.part,
          type: transactionParts.type,
          category: transactionParts.category,
          keepsCategory: transactionParts.keepsCategory,
          linked: transactionParts.linked,
          categorySource: transactionParts.categorySource,
          categoryNeedsAi: transactionParts.categoryNeedsAi,
        },
      })
      .from(transactions)
      .leftJoin(transactionParts, eq(transactionParts.transactionId, transactions.id))
      .where(inArray(transactions.id, chunk))
      .orderBy(asc(transactionParts.part));
    for (const { hiddenReason, part, ...row } of rows) {
      const record = found.get(row.id) ?? { ...row, hidden: hiddenReason !== null, parts: [] };
      if (part !== null) record.parts.push(part);
      found.set(row.id, record);
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// One Spending Transaction in a Merchant's history: its first Spending part's Category and how
// that Category was chosen. Loan payment parts are left out.
export type MerchantHistoryRow = {
  id: string;
  postedDate: string;
  merchantId: string | null;
  merchantCleanName: string;
  category: string;
  categorySource: CategorySource | null;
};

// Every shown Spending Transaction with a Merchant and a Category, oldest first.
export async function listMerchantHistory(database: Queries): Promise<MerchantHistoryRow[]> {
  const rows = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      merchantId: transactions.merchantId,
      merchantCleanName: sql<string>`${transactions.merchantCleanName}`,
      category: sql<string>`${transactionParts.category}`,
      categorySource: transactionParts.categorySource,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        isNotNull(transactionParts.category),
        eq(transactionParts.keepsCategory, false),
        isNull(transactions.hiddenReason),
        isNotNull(transactions.merchantCleanName),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id), asc(transactionParts.part));
  // A Transaction with several Spending parts counts once, with its first.
  return rows.filter((row, index) => index === 0 || rows[index - 1]?.id !== row.id);
}

export type PartCategory = {
  transactionId: string;
  part: number;
  category: string;
  categorySource: CategorySource;
  categoryConfidence: CategoryConfidence;
  categoryNeedsAi: boolean;
};

// Saves the Category the categorization step chose for each part.
export async function storePartCategories(
  database: Queries,
  choices: readonly PartCategory[],
): Promise<void> {
  if (choices.length === 0) return;
  await database.transaction(async (tx) => {
    for (const { transactionId, part, ...choice } of choices) {
      await tx
        .update(transactionParts)
        .set(choice)
        .where(
          and(eq(transactionParts.transactionId, transactionId), eq(transactionParts.part, part)),
        );
    }
  });
}
