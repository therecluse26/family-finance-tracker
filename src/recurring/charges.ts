import { type Category, isCategory } from "../categories/index.ts";
import { categorize, registerCascadeStep } from "../categorization/index.ts";
import {
  clearCascadeCategories,
  type Database,
  deleteMemberPriceChange,
  editRecurringCharge,
  endRecurringCharge,
  type FoundRecurringCharge,
  listPostedSpending,
  listRecurringCharges,
  listShownTransactionIds,
  markChargeTransaction,
  moveOldPriceHistories,
  readChargeOfTransaction,
  readRecurringCharge,
  replaceRecurringCharges,
  type StoredRecurringCharge,
  storeMemberPriceChange,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain, registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { isMaskedMerchant, type Merchant, merchantKey } from "../merchants/index.ts";
import { findIncomeSeries } from "./income.ts";
import { groupOf, householdToday } from "./merchant-days.ts";
import {
  type ChargeSchedule,
  fixedDayOf,
  lastActiveDay,
  type Schedule,
  scheduleName,
} from "./schedules.ts";
import {
  amountOn,
  continueKept,
  factsOf,
  type KeptCharge,
  MASKED_CHARGE_RULE,
  type PriceChange,
  priceChangesIn,
  RECURRING_CHARGE_RULE,
  replayMerchant,
  type Series,
  type SeriesRule,
  type SeriesTxn,
  type Status,
} from "./series.ts";

// The Recurring charge checks (spec 06, Recurring charges; When checks run). They run in the
// follow-up job's checks step, after Matching and Categorization, on posted Transactions only. Each
// run finds every Recurring charge again from posted Spending, so those a history load brings are
// Recurring charges at once, and a removed Transaction leaves its series. A Recurring charge a
// Member marked ended never changes again, and one a Member edited keeps every edit (spec 06,
// Member edits).

export type RecurringCharge = {
  id: string;
  merchant: Merchant;
  // The name a Member gave it, or null: the pages then show the Merchant's.
  name: string | null;
  // A Member's Category, else its last Transaction's.
  category: string | null;
  categoryByHand: boolean;
  // A Member's price band in tenths of a percent, or null for the default.
  priceBand: number | null;
  // The default price band in tenths of a percent: 7.5%, or exact cents for a masked Merchant.
  defaultPriceBand: number;
  schedule: Schedule;
  // A monthly one's fixed day of the month (spec 06, Monthly series), from its price history. 31
  // is the last day of every month. Null on the other schedules.
  fixedDay: number | null;
  nextExpectedDate: string;
  // Whole cents spent: its last Transaction's, or a Member's price change since.
  latestAmount: number;
  // Each Transaction's posted date and amount in whole cents spent, oldest first.
  priceHistory: { transactionId: string; date: string; amount: number }[];
  // The Transactions in it that a Member added.
  addedByHand: string[];
  // Its price changes, oldest first: a Member's, and those the checks found.
  priceChanges: { id: string; fromDate: string; amount: number; byHand: boolean }[];
  // The Account its last Transaction landed on.
  accountId: string;
  status: Status;
};

const INTEREST_AND_FEES = "Interest and fees";

const merchantOfStored = (charge: StoredRecurringCharge): Merchant => ({
  id: charge.merchantId,
  name: charge.merchantName,
});

const ruleOf = (merchant: Merchant): SeriesRule<ChargeSchedule> =>
  // A masked Merchant's series match only exact cents (spec 06, A masked Merchant's series).
  isMaskedMerchant(merchant) ? MASKED_CHARGE_RULE : RECURRING_CHARGE_RULE;

// Whether a Member edited it, so the checks keep it (spec 06, Member edits).
const isKept = (charge: StoredRecurringCharge) =>
  charge.name !== null ||
  charge.handSetCategory !== null ||
  charge.priceBand !== null ||
  charge.priceChanges.some((change) => change.byHand) ||
  charge.removedByHand.length > 0 ||
  charge.priceHistory.some((entry) => entry.addedByHand);

// Its Transactions on its schedule: those a Member added are off it, unless every one is.
function onSchedule(charge: StoredRecurringCharge): StoredRecurringCharge["priceHistory"] {
  const scheduled = charge.priceHistory.filter((entry) => !entry.addedByHand);
  return scheduled.length > 0 ? scheduled : charge.priceHistory;
}

const memberChanges = (charge: StoredRecurringCharge): PriceChange[] =>
  charge.priceChanges
    .filter((change) => change.byHand)
    .map(({ fromDate, amount }) => ({ fromDate, amount }));

// The Transactions a Member's Category covers: each one in a Recurring charge with one (spec 04,
// The categorization cascade).
function coveredByCategory(
  charges: readonly { handSetCategory: string | null; priceHistory: { transactionId: string }[] }[],
): Map<string, string> {
  const covered = new Map<string, string>();
  for (const charge of charges) {
    if (charge.handSetCategory === null) continue;
    for (const entry of charge.priceHistory)
      covered.set(entry.transactionId, charge.handSetCategory);
  }
  return covered;
}

// A found series as stored, with the price changes in it and, for one a Member edited, the
// Transactions they added.
function foundCharge(
  id: string,
  merchant: Merchant,
  series: Series<ChargeSchedule>,
  foundAt: Date,
  kept?: StoredRecurringCharge,
  added: readonly SeriesTxn[] = [],
): FoundRecurringCharge {
  const rule = ruleOf(merchant);
  const changes = kept === undefined ? [] : memberChanges(kept);
  const byHand = new Set(
    kept?.priceHistory.filter((entry) => entry.addedByHand).map((entry) => entry.transactionId),
  );
  const facts = factsOf(series.schedule, series.txns);
  const history = [...series.txns, ...added].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  return {
    id,
    merchantId: merchant.id,
    merchantName: merchant.name,
    schedule: scheduleName(series.schedule),
    ...facts,
    latestAmount: amountOn(series.txns, changes, facts.nextExpectedDate),
    priceHistory: history.map((txn) => ({
      transactionId: txn.id,
      date: txn.date,
      amount: txn.amount,
      addedByHand: byHand.has(txn.id),
    })),
    priceChanges: priceChangesIn(series.txns, kept?.priceBand ?? rule.band, changes).filter(
      (change) => !changes.some((each) => each.fromDate === change.fromDate),
    ),
    status: series.status,
    foundAt,
    endedAt: null,
    endedBy: null,
  };
}

// Finds every Recurring charge again, and stores them in place of the ones not marked ended. A
// Recurring charge that keeps one of its Transactions keeps its ID. One a Member edited goes first:
// it keeps its Transactions and takes the later ones that fit it (continueKept), and the replay
// finds the others from the rest. With `only`, just that Merchant's, as after a Member's edit. A
// Transaction that joins or leaves a Recurring charge with a Member's Category goes through the
// cascade again.
export async function findRecurringCharges(
  database: Database,
  now = new Date(),
  options: { only?: Merchant } = {},
): Promise<void> {
  const today = await householdToday(database, now);
  const onlyGroup = options.only === undefined ? undefined : groupOf(options.only);
  const inScope = (merchant: Merchant) =>
    onlyGroup === undefined || groupOf(merchant) === onlyGroup;
  const stored = await listRecurringCharges(database);
  const covered = stored.filter((charge) => inScope(merchantOfStored(charge)));
  const claimed = new Set<string>();
  for (const charge of stored) {
    if (charge.status !== "ended") continue;
    for (const entry of charge.priceHistory) claimed.add(entry.transactionId);
  }
  const kept = covered
    .filter((charge) => charge.status !== "ended" && isKept(charge))
    .sort((a, b) => (a.priceHistory[0]?.date ?? "").localeCompare(b.priceHistory[0]?.date ?? ""));
  for (const charge of kept) {
    for (const entry of charge.priceHistory) claimed.add(entry.transactionId);
  }
  const earlier = new Map<string, StoredRecurringCharge>();
  for (const charge of covered) {
    if (charge.status === "ended" || isKept(charge)) continue;
    for (const entry of charge.priceHistory) earlier.set(entry.transactionId, charge);
  }

  const merchants = new Map<string, { merchant: Merchant; txns: SeriesTxn[] }>();
  const posted = new Map<string, SeriesTxn>();
  // Spending in Interest and fees never forms a Recurring charge (spec 06, Finding a series): card
  // interest and fees send the Card interest or fee Alert, and loan interest is a part of a loan
  // payment.
  for (const row of await listPostedSpending(database, { exceptCategory: INTEREST_AND_FEES })) {
    if (row.merchantCleanName === null || row.spending >= 0) continue;
    const merchant = { id: row.merchantId, name: row.merchantCleanName };
    if (merchant.id === null && merchantKey(merchant.name) === "") continue;
    if (!inScope(merchant)) continue;
    const key = groupOf(merchant);
    const group = merchants.get(key) ?? { merchant, txns: [] };
    group.merchant = merchant;
    const txn = {
      id: row.id,
      date: row.postedDate,
      amount: -row.spending,
      accountId: row.accountId,
      category: row.category,
    };
    group.txns.push(txn);
    posted.set(txn.id, txn);
    merchants.set(key, group);
  }

  const charges: FoundRecurringCharge[] = [];
  const gone: string[] = [];
  // A Member's Transaction stays while it shows, in any Category.
  const shown = await listShownTransactionIds(
    database,
    kept.flatMap((charge) =>
      charge.priceHistory.map((entry) => entry.transactionId).filter((id) => !posted.has(id)),
    ),
  );
  // The Transactions the other series of a Merchant take with 2 or more of their own before them,
  // from a replay with every kept one's Transactions claimed. A kept one's price change never takes
  // these, so it never merges another series (spec 06, A masked Merchant's series). Replayed once
  // for each Merchant with a kept one.
  const ownedOf = new Map<string, Set<string>>();
  const ownedByOthers = (key: string, merchant: Merchant): Set<string> => {
    let owned = ownedOf.get(key);
    if (owned === undefined) {
      owned = new Set();
      const txns = merchants.get(key)?.txns ?? [];
      for (const series of replayMerchant(txns, claimed, today, ruleOf(merchant))) {
        const ordered = [...series.txns].sort(
          (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
        );
        for (const txn of ordered.slice(2)) owned.add(txn.id);
      }
      ownedOf.set(key, owned);
    }
    return owned;
  };
  const prepared: {
    charge: StoredRecurringCharge;
    merchant: Merchant;
    kept: KeptCharge;
    added: SeriesTxn[];
    removed: Set<string>;
  }[] = [];
  for (const charge of kept) {
    const merchant = merchantOfStored(charge);
    const stillShown = (entry: StoredRecurringCharge["priceHistory"][number]): SeriesTxn[] => {
      const txn = posted.get(entry.transactionId);
      if (txn !== undefined) return [txn];
      if (!shown.has(entry.transactionId)) return [];
      return [
        {
          id: entry.transactionId,
          date: entry.date,
          amount: entry.amount,
          accountId: charge.accountId,
          category: null,
        },
      ];
    };
    // A Transaction a Member added stays in it, but off its schedule: it moves no expected date,
    // fixed day, latest amount or price change. With none of the others left, they are its schedule.
    let members = charge.priceHistory.filter((entry) => !entry.addedByHand).flatMap(stillShown);
    let added = charge.priceHistory.filter((entry) => entry.addedByHand).flatMap(stillShown);
    if (members.length === 0) [members, added] = [added, []];
    if (members.length === 0) {
      gone.push(charge.id);
      continue;
    }
    const schedule: ChargeSchedule =
      charge.schedule === "monthly"
        ? { fixedDay: fixedDayOf(members.map((txn) => txn.date)) }
        : charge.schedule;
    prepared.push({
      charge,
      merchant,
      kept: {
        schedule,
        members,
        priceChanges: memberChanges(charge),
        band: charge.priceBand ?? undefined,
      },
      added,
      removed: new Set(charge.removedByHand),
    });
  }
  const candidatesOf = (each: (typeof prepared)[number]) =>
    (merchants.get(groupOf(each.merchant))?.txns ?? []).filter(
      (txn) => !claimed.has(txn.id) && !each.removed.has(txn.id),
    );
  // Each kept one's own continuation at its own amount, with no price change, from the same
  // Transactions, so the order of the kept ones changes nothing. Another kept one's price change
  // never takes these, so 2 edited series never merge (spec 06, Kept by hand).
  const keptOwners = new Map<string, Set<string>>();
  for (const each of prepared) {
    const own = continueKept(
      each.kept,
      candidatesOf(each),
      () => true,
      today,
      ruleOf(each.merchant),
    );
    for (const txn of own.txns) {
      const owners = keptOwners.get(txn.id) ?? new Set();
      owners.add(each.charge.id);
      keptOwners.set(txn.id, owners);
    }
  }
  for (const each of prepared) {
    const { charge, merchant, added } = each;
    const owned = ownedByOthers(groupOf(merchant), merchant);
    const ownedByOther = (txn: SeriesTxn) =>
      owned.has(txn.id) || [...(keptOwners.get(txn.id) ?? [])].some((id) => id !== charge.id);
    const series = continueKept(
      each.kept,
      candidatesOf(each),
      ownedByOther,
      today,
      ruleOf(merchant),
    );
    for (const txn of [...series.txns, ...added]) claimed.add(txn.id);
    charges.push(foundCharge(charge.id, merchant, series, charge.foundAt, charge, added));
  }

  const reused = new Set<string>();
  for (const { merchant, txns } of merchants.values()) {
    for (const series of replayMerchant(txns, claimed, today, ruleOf(merchant))) {
      const previous = series.txns
        .map((txn) => earlier.get(txn.id))
        .find((charge) => charge !== undefined && !reused.has(charge.id));
      if (previous !== undefined) reused.add(previous.id);
      charges.push(
        foundCharge(
          previous?.id ?? crypto.randomUUID(),
          merchant,
          series,
          previous?.foundAt ?? now,
        ),
      );
    }
  }
  await replaceRecurringCharges(database, charges, {
    covered: covered.filter((charge) => charge.status !== "ended").map((charge) => charge.id),
    gone,
  });

  // The Transactions whose Member's Category changed: each one that joined or left a Recurring
  // charge with one.
  const found = new Map(charges.map((charge) => [charge.id, charge.priceHistory]));
  const before = coveredByCategory(kept);
  const after = coveredByCategory(
    kept.map((charge) => ({ ...charge, priceHistory: found.get(charge.id) ?? [] })),
  );
  const again = [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => before.get(id) !== after.get(id),
  );
  if (again.length > 0) {
    await followUpAgain(database, again);
    // The cascade chooses their Categories again now, so the steps after the checks in this job
    // read the new ones (spec 04, Re-runs). Step 2 answers with no AI call. One that needs the AI
    // waits for the next follow-up job with no Category, and so does each one after it by date: the
    // steps after the checks in this job see it with none.
    await clearCascadeCategories(database, again);
    const dateOf = (id: string) => posted.get(id)?.date ?? "";
    await categorize(
      database,
      [...again].sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.localeCompare(b)),
      "follow-up job",
    );
    await followUpSoon();
  }
  log.info("Found Recurring charges", {
    active: charges.filter((charge) => charge.status === "active").length,
    inactive: charges.filter((charge) => charge.status === "inactive").length,
    kept: kept.length,
  });
}

// Starts a follow-up job for Transactions whose Category a Recurring charge changed. If that fails,
// the app logs it: the next follow-up job handles them.
async function followUpSoon(): Promise<void> {
  try {
    await askForFollowUp();
  } catch (error) {
    log.error("Could not start a follow-up job after a Recurring charge changed", { error });
  }
}

// The schedule a Recurring charge's dates follow: a monthly one's from its fixed day. Every caller
// of the next expected date and the last active day reads it.
export function chargeSchedule(
  charge: Pick<RecurringCharge, "schedule" | "fixedDay">,
): ChargeSchedule {
  if (charge.schedule !== "monthly") return charge.schedule;
  if (charge.fixedDay === null) throw new Error("A monthly Recurring charge has a fixed day.");
  return { fixedDay: charge.fixedDay };
}

// The status on `today`: an active Recurring charge whose last active day has passed since the
// last checks is inactive.
function statusOn(charge: RecurringCharge, today: string): Status {
  const last = charge.priceHistory.at(-1);
  if (charge.status !== "active" || last === undefined) return charge.status;
  return today > lastActiveDay(chargeSchedule(charge), last.date) ? "inactive" : "active";
}

function chargeOf(stored: StoredRecurringCharge, today: string): RecurringCharge {
  const charge: RecurringCharge = {
    id: stored.id,
    merchant: merchantOfStored(stored),
    name: stored.name,
    category: stored.handSetCategory ?? stored.category,
    categoryByHand: stored.handSetCategory !== null,
    priceBand: stored.priceBand,
    defaultPriceBand: ruleOf(merchantOfStored(stored)).band,
    schedule: stored.schedule,
    fixedDay:
      stored.schedule === "monthly"
        ? fixedDayOf(onSchedule(stored).map((entry) => entry.date))
        : null,
    nextExpectedDate: stored.nextExpectedDate,
    latestAmount: stored.latestAmount,
    priceHistory: stored.priceHistory.map(({ transactionId, date, amount }) => ({
      transactionId,
      date,
      amount,
    })),
    addedByHand: stored.priceHistory
      .filter((entry) => entry.addedByHand)
      .map((entry) => entry.transactionId),
    priceChanges: stored.priceChanges,
    accountId: stored.accountId,
    status: stored.status,
  };
  return { ...charge, status: statusOn(charge, today) };
}

// Every Recurring charge, by next expected date, with its status on the Household's today.
export async function recurringCharges(
  database: Database,
  now = new Date(),
): Promise<RecurringCharge[]> {
  const today = await householdToday(database, now);
  return (await listRecurringCharges(database)).map((stored) => chargeOf(stored, today));
}

// A Member marks a Recurring charge ended. It never comes back by itself: later Transactions from
// that Merchant start a new series. Undefined when no Recurring charge has the ID.
export async function endCharge(
  database: Database,
  id: string,
  memberId: string,
  now = new Date(),
): Promise<RecurringCharge | undefined> {
  const ended = await endRecurringCharge(database, id, { memberId, at: now });
  if (ended === undefined) return undefined;
  log.info("A Member marked a Recurring charge ended");
  return chargeOf(ended, await householdToday(database, now));
}

// A Member's edit (spec 06, Member edits): the charge after it, or why it did not apply. "not
// found" when no Recurring charge has the ID; "no Transaction" when the Transaction is not one it
// can take, or not one it holds; "no price change" when it has no Member's price change with the
// ID; "ended" when the Recurring charge, or the one the Transaction is in, is marked ended; "last
// Transaction" when a removal would leave it with none.
export type ChargeEdit =
  | RecurringCharge
  | "not found"
  | "no Transaction"
  | "no price change"
  | "ended"
  | "last Transaction";

// The name, Category, and price band a Member may set. Null clears one.
export type ChargeEdits = {
  name?: string | null;
  category?: Category | null;
  // Tenths of a percent.
  priceBand?: number | null;
};

// Applies an edit, marks `touched` for the follow-up job, so the cascade and the checks run on them
// again, then finds its Merchant's Recurring charges again. The marks come before the find, so a
// find that fails still leaves the follow-up work (K5). Only a name and a Category apply to one
// marked ended (`onEnded`, owner decision D38): its Transactions never change.
async function edited(
  database: Database,
  id: string,
  now: Date,
  apply: (
    charge: StoredRecurringCharge,
  ) => Promise<string[] | Exclude<ChargeEdit, RecurringCharge>>,
  onEnded = false,
): Promise<ChargeEdit> {
  const charge = await readRecurringCharge(database, id);
  if (charge === undefined) return "not found";
  if (charge.status === "ended" && !onEnded) return "ended";
  const touched = await apply(charge);
  if (typeof touched === "string") return touched;
  if (touched.length > 0) await followUpAgain(database, touched);
  try {
    await findRecurringCharges(database, now, { only: merchantOfStored(charge) });
  } finally {
    if (touched.length > 0) await followUpSoon();
  }
  const after = await readRecurringCharge(database, id);
  if (after === undefined) return "not found";
  return chargeOf(after, await householdToday(database, now));
}

// A Member names a Recurring charge, sets its Category, or sets its price band. A Category covers
// each of its Transactions not set by hand, so they go through the cascade again. One marked ended
// takes a name and a Category, but no price band.
export function editCharge(
  database: Database,
  id: string,
  edits: ChargeEdits,
  now = new Date(),
): Promise<ChargeEdit> {
  return edited(
    database,
    id,
    now,
    async (charge) => {
      const { category, ...rest } = edits;
      const stored = await editRecurringCharge(database, id, {
        ...rest,
        ...(category === undefined ? {} : { handSetCategory: category }),
      });
      if (!stored) return "ended";
      log.info("A Member edited a Recurring charge", {
        name: edits.name !== undefined,
        category: category !== undefined,
        priceBand: edits.priceBand !== undefined,
      });
      return category === undefined ? [] : charge.priceHistory.map((entry) => entry.transactionId);
    },
    edits.priceBand === undefined,
  );
}

// A Member sets a price change: a new amount, in whole cents spent, from a date. Each later
// Transaction is judged against it, and the Transactions since a past start date that fit join.
export function setChargePriceChange(
  database: Database,
  id: string,
  change: PriceChange,
  now = new Date(),
): Promise<ChargeEdit> {
  return edited(database, id, now, async () => {
    await storeMemberPriceChange(database, id, change);
    log.info("A Member set a Recurring charge's price change");
    return [];
  });
}

// A Member deletes their price change.
export function deleteChargePriceChange(
  database: Database,
  id: string,
  changeId: string,
  now = new Date(),
): Promise<ChargeEdit> {
  return edited(database, id, now, async () => {
    if (!(await deleteMemberPriceChange(database, id, changeId))) return "no price change";
    log.info("A Member deleted a Recurring charge's price change");
    return [];
  });
}

// A Member adds one of the Merchant's posted Spending Transactions that shows. It leaves any other
// Recurring charge it was in, and stays until it is hidden or removed.
export function addChargeTransaction(
  database: Database,
  id: string,
  transactionId: string,
  now = new Date(),
): Promise<ChargeEdit> {
  return edited(database, id, now, async (charge) => {
    const [txn] = await listPostedSpending(database, { transactionIds: [transactionId] });
    if (
      txn === undefined ||
      txn.spending >= 0 ||
      txn.merchantCleanName === null ||
      groupOf({ id: txn.merchantId, name: txn.merchantCleanName }) !==
        groupOf(merchantOfStored(charge))
    ) {
      return "no Transaction";
    }
    const other = await readChargeOfTransaction(database, transactionId);
    if (other?.status === "ended") return "ended";
    await markChargeTransaction(
      database,
      id,
      { transactionId, date: txn.postedDate, amount: -txn.spending },
      "added",
    );
    log.info("A Member added a Transaction to a Recurring charge");
    return [transactionId];
  });
}

// A Member removes a Transaction from a Recurring charge. It never joins it again by itself.
export function removeChargeTransaction(
  database: Database,
  id: string,
  transactionId: string,
  now = new Date(),
): Promise<ChargeEdit> {
  return edited(database, id, now, async (charge) => {
    const entry = charge.priceHistory.find((each) => each.transactionId === transactionId);
    if (entry === undefined) return "no Transaction";
    if (charge.priceHistory.length === 1) return "last Transaction";
    await markChargeTransaction(database, id, entry, "removed");
    log.info("A Member removed a Transaction from a Recurring charge");
    return [transactionId];
  });
}

// A posted Spending Transaction a Member may add to a Recurring charge.
export type ChargeCandidate = {
  transactionId: string;
  date: string;
  amount: number;
  removedByHand: boolean;
};

// One page of the charges a Member may add, and whether older ones follow.
export type ChargeCandidates = { candidates: ChargeCandidate[]; more: boolean };

// Which page: only those at `amount`, in whole cents spent, and only those older than the
// Transaction `before`, the last one of the page before.
export type CandidateFilter = { amount?: number; before?: string };

// The Merchant's posted Spending Transactions that a Member may add to a Recurring charge: those
// not in it and not in one marked ended (spec 07, Recurring charges page). The first page lists
// first each one a Member removed from it, at any amount, so a removal can be undone. Then 50 of
// the others at a time, newest first. Undefined when no Recurring charge has the ID; "no
// Transaction" when `before` is none of the Merchant's posted Spending.
export async function chargeCandidates(
  database: Database,
  id: string,
  filter: CandidateFilter = {},
): Promise<ChargeCandidates | "no Transaction" | undefined> {
  const charge = await readRecurringCharge(database, id);
  if (charge === undefined) return undefined;
  const group = groupOf(merchantOfStored(charge));
  const inIt = new Set(charge.priceHistory.map((entry) => entry.transactionId));
  const removed = new Set(charge.removedByHand);
  const ended = new Set(
    (await listRecurringCharges(database))
      .filter((each) => each.status === "ended")
      .flatMap((each) => each.priceHistory.map((entry) => entry.transactionId)),
  );
  const newestFirst = (await listPostedSpending(database))
    .filter(
      (row) =>
        row.merchantCleanName !== null &&
        row.spending < 0 &&
        groupOf({ id: row.merchantId, name: row.merchantCleanName }) === group,
    )
    .map(
      (row): ChargeCandidate => ({
        transactionId: row.id,
        date: row.postedDate,
        amount: -row.spending,
        removedByHand: removed.has(row.id),
      }),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.transactionId.localeCompare(a.transactionId));
  let from = 0;
  if (filter.before !== undefined) {
    const at = newestFirst.findIndex((each) => each.transactionId === filter.before);
    if (at === -1) return "no Transaction";
    from = at + 1;
  }
  const open = (each: ChargeCandidate) =>
    !inIt.has(each.transactionId) && !ended.has(each.transactionId);
  const undo =
    filter.before === undefined
      ? newestFirst.filter((each) => each.removedByHand && open(each))
      : [];
  const others = newestFirst
    .slice(from)
    .filter(
      (each) =>
        !each.removedByHand &&
        open(each) &&
        (filter.amount === undefined || each.amount === filter.amount),
    );
  return {
    candidates: [...undo, ...others.slice(0, CANDIDATES_PER_PAGE)],
    more: others.length > CANDIDATES_PER_PAGE,
  };
}
const CANDIDATES_PER_PAGE = 50;

// Registers the checks step, which finds the Recurring charges, then the Income series behind
// Steady Income, after each sync (spec 05, Steady Income), and the cascade's step for a Member's
// Category on a Recurring charge (spec 04, The categorization cascade). The start calls it before
// jobs run, and `atStart` once, before any job runs.
export function startRecurringCharges(options: { database: Database; now?: () => Date }): {
  stop(): void;
  atStart(): Promise<void>;
} {
  const { database, now = () => new Date() } = options;
  const stops = [
    registerFollowUpStep("recurring charge checks", async () => {
      await findRecurringCharges(database, now());
      await findIncomeSeries(database, now());
      return undefined;
    }),
    registerCascadeStep("Recurring charge", async (txn) => {
      const charge = await readChargeOfTransaction(database, txn.id);
      const category = charge?.handSetCategory;
      return category !== undefined && category !== null && isCategory(category)
        ? { category, confidence: "certain" }
        : undefined;
    }),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
    },
    // Each price history stored before recurring_charge_transactions moves into it.
    atStart: () => moveOldPriceHistories(database),
  };
}
