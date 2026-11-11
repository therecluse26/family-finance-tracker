import { asc, getTableColumns, getTableName, isNull, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.ts";
import { readShownParts, type ShownPart } from "./decisions.ts";
import * as schema from "./schema.ts";

// What the data export reads from app.db (spec 11, Data export). What goes in is an allowlist of
// tables and columns: a table or a column added later stays out until someone adds it here, and a
// test fails until they do. Three things never go in:
// - secrets and login records: every Master-key secret, passkeys, TOTP secrets, backup codes,
//   password hashes, sessions, invite and reset links (spec 11, Never included);
// - the provider's own IDs and raw data for each record, which only sync uses;
// - the app's work state, such as job tries, follow-up marks, delivery queues, and caches, which
//   is not the Household's data.

type ColumnsOf<T extends SQLiteTable> = keyof T["_"]["columns"] & string;

export type ExportedTable = {
  table: SQLiteTable;
  // The table's name in app.db, which names it in data.json.
  name: string;
  // The columns that go in, by property name.
  columns: readonly string[];
  // The columns that never go in, by property name.
  leftOut: readonly string[];
};

function exported<T extends SQLiteTable>(
  table: T,
  columns: readonly ColumnsOf<T>[] | "every column",
  leftOut: readonly ColumnsOf<T>[] = [],
): ExportedTable {
  const all = Object.keys(getTableColumns(table));
  return {
    table,
    name: getTableName(table),
    columns: columns === "every column" ? all : columns,
    leftOut,
  };
}

// Every table in data.json, in this order.
export const EXPORTED_TABLES: readonly ExportedTable[] = [
  // Login state, such as the TOTP flag, stays out.
  exported(
    schema.members,
    ["id", "name", "email", "createdAt"],
    ["emailVerified", "image", "twoFactorEnabled", "updatedAt"],
  ),
  exported(schema.removedMembers, "every column"),
  exported(schema.householdFacts, "every column"),
  exported(
    schema.connections,
    [
      "id",
      "provider",
      "bankId",
      "bankName",
      "health",
      "historyLoaded",
      "origin",
      "lastSyncedAt",
      "createdAt",
      "removedAt",
      "syncHeld",
    ],
    [
      // A Master-key secret: the provider credential, such as a Plaid access token.
      "credential",
      // The provider's place in the bank's records.
      "syncCursor",
      // The sync schedule's work state.
      "syncMinute",
      "lastSyncAttemptAt",
      "nextSyncAt",
      "retryingSince",
      "failedSyncs",
      "lastRefreshAt",
      "historyWaitReleasedAt",
      "laterHooksStartedAt",
      "laterHooksRestarts",
    ],
  ),
  exported(schema.connectionCarryOvers, "every column"),
  exported(
    schema.householdAccounts,
    [
      "id",
      "connectionId",
      "name",
      "memberName",
      "kind",
      "subtype",
      "institutionId",
      "institutionName",
      "mask",
      "currentBalance",
      "availableBalance",
      "creditLimit",
      "cardAprs",
      "statementBalance",
      "statementIssueDate",
      "minimumPayment",
      "paymentDueDate",
      "loanApr",
      "loanPrincipal",
      "interestPaidThisYear",
      "loanType",
      "memberApr",
      "regularPayment",
      "escrow",
      "excluded",
      "closedAt",
      "closedReason",
      "historySplitDate",
    ],
    ["providerAccountId", "raw", "providerMissing"],
  ),
  exported(
    schema.transactions,
    [
      "id",
      "connectionId",
      "accountId",
      "amount",
      "postedDate",
      "authorizedDate",
      "pending",
      "description",
      "merchantName",
      "merchantId",
      "merchantCleanName",
      "counterparties",
      "providerCategory",
      "providerCategoryConfidence",
      "providerCategoryVersion",
      "mcc",
      "handSet",
      // A removed Transaction keeps its reason: "removed by provider".
      "hiddenReason",
      "hiddenAt",
    ],
    [
      "providerTransactionId",
      "pendingTransactionId",
      "raw",
      "merchantNeedsAi",
      "historyLoad",
      "postedSeenAt",
    ],
  ),
  exported(schema.dailyBalances, "every column"),
  exported(schema.typedBalances, "every column"),
  exported(schema.unconnectedAssignments, "every column"),
  exported(schema.transactionDecisions, "every column"),
  exported(
    schema.transactionParts,
    [
      "transactionId",
      "part",
      "type",
      "amount",
      "category",
      "keepsCategory",
      "linked",
      "categorySource",
      "categoryConfidence",
    ],
    ["categoryNeedsAi"],
  ),
  exported(schema.transferLinks, "every column"),
  exported(schema.refusedTransferLinks, "every column"),
  exported(schema.spendingLinks, "every column"),
  exported(schema.loanLinks, "every column"),
  exported(schema.refusedLinks, "every column"),
  exported(schema.aiLinkAnswers, "every column"),
  exported(
    schema.reviewItems,
    [
      "id",
      "kind",
      "subjectType",
      "subjectIds",
      "decided",
      "bestAnswer",
      "createdAt",
      "closedAt",
      "closedReason",
      "answer",
      "answeredBy",
    ],
    ["needsAi"],
  ),
  exported(
    schema.categoryRules,
    ["id", "merchantId", "merchantName", "category", "madeAt", "madeBy"],
    // The clean name as identity compares it, made from merchant_name.
    ["merchantKey"],
  ),
  exported(schema.transferAnswers, "every column"),
  exported(schema.recurringCharges, "every column"),
  exported(schema.recurringChargeTransactions, "every column"),
  exported(schema.recurringChargePriceChanges, "every column"),
  exported(schema.incomeSeries, "every column"),
  exported(schema.typedSteadyIncome, "every column"),
  exported(schema.budgets, "every column"),
  exported(schema.budgetInputs, "every column"),
  exported(schema.budgetDraftAcceptance, "every column"),
  exported(schema.goals, "every column"),
  exported(schema.proposals, "every column"),
  exported(schema.proposalBudgets, "every column"),
  exported(schema.redraftProposals, "every column"),
  exported(
    schema.alerts,
    ["id", "kind", "createdAt", "facts", "text", "category", "advice", "state"],
    ["advisedAt"],
  ),
  exported(schema.alertParts, "every column"),
  exported(schema.alertTransactions, "every column"),
  exported(schema.alertPresses, "every column"),
  exported(schema.alertNotesDone, "every column"),
  exported(schema.alertSettings, "every column"),
  exported(schema.alertChannels, "every column"),
  exported(schema.systemNotices, "every column"),
  exported(schema.monthlyReviews, "every column"),
  exported(schema.reviewPlanTicks, "every column"),
  exported(schema.reviewLinksDone, "every column"),
  exported(schema.insightCards, "every column"),
  exported(schema.chatThreads, "every column"),
  exported(schema.chatMessages, "every column"),
  exported(schema.chatAlertThreads, "every column"),
  // The AI provider and its models. The API key and the gateway token are Master-key secrets. A
  // base URL may hold a sign-in name and password. A rejected key and a refused web search are the
  // app's own state about the AI provider.
  exported(
    schema.aiSettings,
    ["provider", "quickModel", "writerModel", "chatModel", "webLookup"],
    ["id", "apiKey", "gatewayToken", "baseUrl", "keyRejectedAt", "webSearchRefused", "generation"],
  ),
  // Line items and Item rules (spec 14). The card's last 4 digits go in, as an Account's mask does.
  exported(
    schema.lineItems,
    [
      "id",
      "source",
      "orderId",
      "orderDate",
      "shipDate",
      "shipTime",
      "productId",
      "name",
      "quantity",
      "unitPrice",
      "unitTax",
      "shippingCharge",
      "discounts",
      "total",
      "cardLast4",
      "giftCard",
      "category",
      "categorySource",
      "categoryConfidence",
      "transactionId",
      "linkKind",
      "addedAt",
      "updatedAt",
    ],
    // The import key and the clean name are made from the fields above.
    ["key", "cleanName", "place", "categoryNeedsAi"],
  ),
  exported(schema.refusedLineItemLinks, "every column"),
  exported(
    schema.itemRules,
    ["id", "productId", "name", "category", "madeAt", "madeBy"],
    // The product key and the clean name, made from the product ID and the name.
    ["productKey", "cleanName"],
  ),
  exported(schema.lineItemImports, "every column"),
  // The deal finder (spec 15, Data and privacy): its settings, Stores, Products, prices, Shopping
  // list, matches and plans. Each Price source key is a Master-key secret, and its last 4
  // characters and Tests stay with it. Where the Stores were last found is work state.
  exported(
    schema.dealFinderSettings,
    ["openFoodFacts", "useZip", "findDistanceMiles", "costCap", "tripSaving", "dietaryNeeds"],
    [
      "id",
      "apifyToken",
      "apifyTokenLast4",
      "apifyCheck",
      "apifyCheckedAt",
      "krogerClientId",
      "krogerClientIdLast4",
      "krogerClientSecret",
      "krogerClientSecretLast4",
      "krogerCheck",
      "krogerCheckedAt",
      "storesFoundZip",
      "storesFoundAt",
    ],
  ),
  exported(schema.priceSourceCosts, "every column"),
  exported(schema.dealFinderStores, "every column"),
  exported(schema.dealFinderProducts, "every column"),
  exported(schema.dealFinderPriceReads, "every column"),
  exported(schema.shoppingListItems, "every column"),
  exported(schema.memberMatchChoices, "every column"),
  exported(schema.productMatches, "every column"),
  exported(schema.shoppingPlans, "every column"),
  exported(schema.shoppingPlanLines, "every column"),
  // Each Shopping list change Chat made, with the List items it touched, for its card and Undo.
  exported(schema.shoppingListChanges, "every column"),
  // Each Merchant's Web lookup: its Category and the line about the business.
  exported(schema.merchantLookups, "every column"),
  exported(schema.aiCalls, "every column"),
  exported(schema.aiCostCap, ["capCents"], ["id", "warnedMonth", "reachedMonth"]),
  exported(schema.aiModelPrices, "every column"),
  // The AI request log's switch and kept days. Its kept text never goes in.
  exported(
    schema.aiRequestLogSettings,
    ["on", "keepDays"],
    ["id", "cleanupFailures", "switchOffs"],
  ),
  // The SMTP password is a Master-key secret, and the sign-in name is the other half of it.
  exported(schema.smtpSettings, ["host", "port", "sender"], ["id", "username", "password"]),
  // The Plaid client ID and secret are the Plaid keys.
  exported(schema.plaidSettings, ["appItems", "outsideItems"], ["id", "clientId", "secret"]),
  // Who last checked the Master key, and whether it matched. It never holds the key.
  exported(schema.masterKeyChecks, "every column"),
];

// Every other table in app.db, with the reason it never goes in.
export const NEVER_EXPORTED_TABLES: ReadonlyMap<string, string> = new Map([
  [getTableName(schema.dataKeys), "The data key, which encrypts every Master-key secret."],
  [getTableName(schema.sessions), "Sessions."],
  [getTableName(schema.accounts), "Password hashes."],
  [
    getTableName(schema.verifications),
    "Sign-ins that wait for a code, and invite and reset links.",
  ],
  [getTableName(schema.twoFactors), "TOTP secrets and backup codes."],
  [getTableName(schema.passkeys), "Passkeys, which sign a Member in."],
  [getTableName(schema.invites), "Open invite links, each with its token's hash."],
  [getTableName(schema.loginResets), "Open reset links, each with its token's hash."],
  [getTableName(schema.rateLimits), "Login records: request counts by client address."],
  [getTableName(schema.signInTries), "Login records: failed sign-ins by Member and IP address."],
  [getTableName(schema.vapidKeys), "The VAPID keys, which are Master-key secrets."],
  [
    getTableName(schema.pushDevices),
    "Each browser's push address and keys, which let anyone push to it.",
  ],
  [getTableName(schema.pushSends), "Work state: the push queue."],
  [getTableName(schema.noticeDeliveries), "Work state: the email and push queue."],
  [getTableName(schema.alertDeliveries), "Work state: the email and push queue."],
  [getTableName(schema.weeklySummarySends), "Work state: the weekly summary email's sends."],
  [getTableName(schema.scheduledTasks), "Work state: the scheduler."],
  [getTableName(schema.setupSteps), "Work state: the first-run wizard."],
  [getTableName(schema.cpiValues), "Public BLS figures, not the Household's data."],
  [getTableName(schema.cpiFetch), "Work state: the CPI fetch."],
  [getTableName(schema.updateCheck), "Work state: the Update check."],
  [getTableName(schema.historyWait), "Work state: the first history load."],
  [getTableName(schema.aiRetries), "Work state: AI retries."],
  [
    getTableName(schema.aiRequestLog),
    "The AI request log: a copy of what the AI provider got, kept a few days at most.",
  ],
  [getTableName(schema.aiRedo), "Work state: when AI went away, for the redo."],
  [getTableName(schema.followUpMarks), "Work state: the follow-up pipeline."],
  [getTableName(schema.followUpChanges), "Work state: the follow-up pipeline."],
  [getTableName(schema.merchantNameAnswers), "A cache of AI answers. Each clean name is exported."],
  [getTableName(schema.merchantLookupMonths), "Work state: the Web lookup's monthly count."],
  [getTableName(schema.budgetMonthStarts), "Work state: the Month start job."],
  [getTableName(schema.alertDecisions), "Work state: the Alerts step's tries."],
  [getTableName(schema.anomalyChecks), "Work state: the Anomaly checks' tries."],
  [getTableName(schema.overspendingChecks), "Work state: the Overspending checks' tries."],
  [
    getTableName(schema.monthlyReviewRuns),
    "Work state: the Monthly review run. Each review is exported.",
  ],
  [getTableName(schema.householdSummary), "A day's cache of app-built text for the AI."],
  [getTableName(schema.budgetTailoringRuns), "Work state: Budget tailoring runs."],
]);

const PAGE_ROWS = 1000;

// The column kinds data.json writes. A moment is ISO text in UTC as app.db stores it, the same text
// JSON.stringify writes for a Date, so SQLite passes it through as text.
const JSON_KINDS = new Set([
  "SQLiteText",
  "SQLiteInteger",
  "SQLiteReal",
  "SQLiteBoolean",
  "SQLiteTextJson",
  "SQLiteCustomColumn",
]);

// One column's value as JSON: a boolean as true or false, a JSON column as its JSON, any other
// value as it is stored.
function jsonValue(table: string, column: SQLiteColumn): SQL {
  if (!JSON_KINDS.has(column.columnType)) {
    throw new Error(
      `${table}.${column.name} is a ${column.columnType}, which data.json cannot write.`,
    );
  }
  if (column.columnType === "SQLiteBoolean") {
    return sql`json(iif(${column} IS NULL, 'null', iif(${column}, 'true', 'false')))`;
  }
  if (column.columnType === "SQLiteTextJson") return sql`json(${column})`;
  // SQLite writes a real with 15 digits, which can change it; 17 always reads back the same.
  if (column.columnType === "SQLiteReal") {
    return sql`iif(${column} IS NULL, NULL, json(printf('%!.17g', ${column})))`;
  }
  return sql`${column}`;
}

// The table's exported columns as JSON text, one page of rows at a time in the order they were
// stored: each row one JSON object keyed by column name as app.db names it, the rows of a page
// joined by commas. SQLite writes the JSON, so no row becomes a JS object.
export async function* readExportedJson(
  database: Database,
  entry: ExportedTable,
  pageRows = PAGE_ROWS,
): AsyncGenerator<string> {
  const columns = getTableColumns(entry.table);
  const fields = sql.join(
    entry.columns.map((key) => {
      const column = columns[key];
      if (column === undefined) throw new Error(`${entry.name} has no column ${key}.`);
      return sql`${column.name}, ${jsonValue(entry.name, column)}`;
    }),
    sql`, `,
  );
  let after = 0;
  for (;;) {
    const page = await database.all<{ exportRowid: number; row: string }>(
      sql`SELECT rowid AS exportRowid, json_object(${fields}) AS row FROM ${entry.table}
        WHERE rowid > ${after} ORDER BY rowid LIMIT ${pageRows}`,
    );
    if (page.length === 0) return;
    after = page.at(-1)?.exportRowid ?? after;
    yield page.map((found) => found.row).join(",");
    if (page.length < pageRows) return;
  }
}

// One Transaction that shows, as transactions.csv writes it (spec 11, Data export).
export type ExportedTransaction = {
  id: string;
  accountId: string;
  // Whole cents. Money into the Account is positive.
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchant: string | null;
  // Its parts as the app shows them: a split's each, and a linked Refund's spread over its
  // Spending's Categories. Empty before Matching has decided it.
  parts: ShownPart[];
  // The Transactions on the other side of its Transfer, Refund, and Reimbursement links.
  linkedIds: string[];
};

const PAGE_TRANSACTIONS = 500;

// Every Transaction that shows, one page at a time in the order they were stored. A hidden
// Transaction, such as one the provider removed, is left out: data.json holds it, with its reason.
// Each page's parts come from one batch. The links are read once: there are far fewer links than
// Transactions, and one read of each table costs less than a read per page.
export async function* readExportedTransactions(
  database: Database,
  pageSize = PAGE_TRANSACTIONS,
): AsyncGenerator<ExportedTransaction[]> {
  const { transactions, transferLinks, spendingLinks } = schema;
  const linked = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const found = linked.get(from);
    if (found === undefined) linked.set(from, [to]);
    else if (!found.includes(to)) found.push(to);
  };
  const transfers = await database
    .select({ a: transferLinks.outTransactionId, b: transferLinks.inTransactionId })
    .from(transferLinks);
  const spending = await database
    .select({ a: spendingLinks.transactionId, b: spendingLinks.spendingTransactionId })
    .from(spendingLinks);
  for (const { a, b } of [...transfers, ...spending]) {
    link(a, b);
    link(b, a);
  }
  let after = 0;
  for (;;) {
    const page = await database
      .select({
        rowid: sql<number>`${transactions}.rowid`,
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        pending: transactions.pending,
        description: transactions.description,
        merchant: transactions.merchantCleanName,
      })
      .from(transactions)
      .where(sql`${transactions}.rowid > ${after} AND ${isNull(transactions.hiddenReason)}`)
      .orderBy(sql`${transactions}.rowid`)
      .limit(pageSize);
    if (page.length === 0) return;
    after = page.at(-1)?.rowid ?? after;
    const ids = page.map((txn) => txn.id);
    const parts = await readShownParts(database, ids);
    yield page.map(({ rowid: _, ...txn }) => ({
      ...txn,
      parts: parts.get(txn.id) ?? [],
      linkedIds: [...(linked.get(txn.id) ?? [])].sort(),
    }));
    if (page.length < pageSize) return;
  }
}

export type ExportedBudget = typeof schema.budgets.$inferSelect;

// Every Budget record, the ones no longer in effect too, oldest first.
export async function listEveryBudget(database: Database): Promise<ExportedBudget[]> {
  return database.select().from(schema.budgets).orderBy(asc(schema.budgets.id));
}
