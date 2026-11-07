import {
  type Database,
  listDecisionAccounts,
  listCardFactsAt,
  listTransferAnswers,
  type CardFacts,
  type Queries,
  readCardFacts,
  removeTransferAnswer,
  type StoredTransferAnswer,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { accountLastFours, merchantKey } from "../merchants/index.ts";
import {
  type CardMember,
  cardsByKey,
  openReviewItemsOfKind,
  type ReviewChoice,
  regroupCards,
  regroupReviewItems,
} from "../review/index.ts";

// One-sided Transfer cards and remembered answers (spec 03, Review list items). Each key has one
// open item, a card that holds every one-sided Transfer of that key that asks. A Member's answer
// covers the card and is remembered for the key, so each later one-sided Transfer with that key
// takes it with no item. The key's digits stay in the app and never go to the AI (K8).

export const ONE_SIDED_KIND = "one-sided Transfer";

// The steps whose result goes to one Unconnected account, by the case table in one-sided.ts.
export const ONE_SIDED_STEPS = ["5.4", "5.6", "6.3", "6.6", "6.7"] as const;

// A card's key: the clean name as Merchant identity compares it, with the last 4 digits of each
// account number the line holds, found on its plain forms (K13). The name is what the list shows.
export type OneSidedKey = { merchantKey: string; merchantName: string; lastFours: string };

// The key of a one-sided Transfer, or null when its line has no clean Merchant name, so it keeps
// an item of its own and its answer is not remembered.
export function oneSidedKeyOf(txn: {
  merchantCleanName: string | null;
  description: string;
}): OneSidedKey | null {
  const name = txn.merchantCleanName;
  if (name === null) return null;
  const key = merchantKey(name);
  if (key === "") return null;
  return { merchantKey: key, merchantName: name, lastFours: accountLastFours(txn.description).join(",") };
}

export const keyText = (key: Pick<OneSidedKey, "merchantKey" | "lastFours">) =>
  `${key.merchantKey} ${key.lastFours}`;

// A remembered answer, as the order of decisions reads it.
export type RememberedAnswer =
  | { answer: "keep" }
  | { answer: "not a transfer" }
  | { answer: "account"; accountId: string };

export const PICK = "account ";
export const KEEP: ReviewChoice = { value: "keep", label: "Keep it as a Transfer" };
export const NOT_A_TRANSFER: ReviewChoice = { value: "not a transfer", label: "Not a Transfer" };

function rememberedOf(stored: StoredTransferAnswer): RememberedAnswer | undefined {
  if (stored.answer === "keep") return { answer: "keep" };
  if (stored.answer === "not a transfer") return { answer: "not a transfer" };
  if (stored.answer === "account" && stored.accountId !== null) {
    return { answer: "account", accountId: stored.accountId };
  }
  return undefined;
}

// Every remembered answer, by key text, read once a run.
export async function readRememberedAnswers(
  database: Queries,
): Promise<ReadonlyMap<string, RememberedAnswer>> {
  const remembered = new Map<string, RememberedAnswer>();
  for (const stored of await listTransferAnswers(database)) {
    const answer = rememberedOf(stored);
    if (answer !== undefined) remembered.set(keyText(stored), answer);
  }
  return remembered;
}

// What the card says, from its best answer and how many Transactions it holds. A best answer that
// picks the only Unconnected account names it in its label, "Yes, Pinecrest savings".
export function askedText(bestAnswer: ReviewChoice, count: number): string {
  const many = count > 1;
  if (bestAnswer.value.startsWith(PICK)) {
    const name = bestAnswer.label.replace(/^Yes, /, "");
    return many
      ? `They name no account, so the app put them in ${name}, the only one.`
      : `It names no account, so the app put it in ${name}, the only one.`;
  }
  return many
    ? "They name no account, so they count as Transfers. Which account is this?"
    : "It names no account, so it counts as a Transfer. Which account is this?";
}

// What a Transaction asks after this run: its best answer, or null when it asks nothing now.
export type Asked = ReadonlyMap<string, ReviewChoice | null>;

// Keeps the one-sided Transfer cards in step: each Transaction a run decided joins its key's card
// when it asks, and leaves its card when it no longer does, and each Transaction that no longer
// shows leaves too. A card with none left closes. Reads the kind's open items once, and the facts
// of all their Transactions in one batch, and writes in one transaction (K3).
export async function updateOneSidedCards(database: Database, asked: Asked): Promise<void> {
  const open = await openReviewItemsOfKind(database, ONE_SIDED_KIND);
  const asking = [...asked].filter(([, best]) => best !== null).map(([id]) => id);
  if (open.length === 0 && asking.length === 0) return;
  // Each Transaction's best answer: this run's, or else its card's.
  const best = new Map<string, ReviewChoice>();
  for (const item of open) {
    if (item.subject.type !== "transactions") continue;
    for (const id of item.subject.transactionIds) {
      if (!asked.has(id) && !best.has(id)) best.set(id, item.bestAnswer);
    }
  }
  for (const id of asking) {
    const choice = asked.get(id);
    if (choice !== null && choice !== undefined) best.set(id, choice);
  }
  const members: CardMember[] = (await readCardFacts(database, [...best.keys()]))
    .filter((facts) => !facts.hidden)
    .map((facts) => {
      const key = oneSidedKeyOf(facts);
      return { id: facts.id, postedDate: facts.postedDate, key: key === null ? null : keyText(key) };
    });
  const fresh = new Set(asking);
  const regroup = regroupCards(
    ONE_SIDED_KIND,
    open,
    cardsByKey(members),
    (card) => {
      // The newest Transaction this run decided, or else the newest on the card.
      const newest = card.find((member) => fresh.has(member.id)) ?? card[0];
      const bestAnswer = (newest === undefined ? undefined : best.get(newest.id)) ?? KEEP;
      return { decided: askedText(bestAnswer, card.length), bestAnswer };
    },
    "decided again",
  );
  const { grouped, ...writes } = regroup;
  await regroupReviewItems(database, writes);
  if (writes.open.length > 0) {
    log.info("One-sided Transfers went on the Review list", { opened: writes.open.length });
  }
  if (grouped > 0) log.info("One-sided Transfer items were grouped", { closed: grouped });
}

// Whether a Transaction is still on a one-sided Transfer card, as an answer reads it inside its
// transaction: it shows, its last result is one-sided, and no Member set its type or account by
// hand. The card's list is only as fresh as its last update.
const stillAsks = (facts: CardFacts) =>
  !facts.hidden &&
  facts.step !== null &&
  (ONE_SIDED_STEPS as readonly string[]).includes(facts.step) &&
  facts.handSet.type === undefined &&
  facts.handSet.unconnectedAccount === undefined;

// The card's Transactions an answer writes, with the card's key: those still on the card, with the
// key most of them share. Null as the key for a card of a line with no clean Merchant name.
export function stillOnCard(facts: readonly CardFacts[]): {
  key: OneSidedKey | null;
  ids: string[];
} {
  const byKey = new Map<string, { key: OneSidedKey | null; ids: string[] }>();
  for (const each of facts) {
    if (!stillAsks(each)) continue;
    const key = oneSidedKeyOf(each);
    const text = key === null ? `none ${each.id}` : keyText(key);
    const group = byKey.get(text);
    if (group === undefined) byKey.set(text, { key, ids: [each.id] });
    else group.ids.push(each.id);
  }
  let largest: { key: OneSidedKey | null; ids: string[] } | undefined;
  for (const group of byKey.values()) {
    if (largest === undefined || group.ids.length > largest.ids.length) largest = group;
  }
  return largest ?? { key: null, ids: [] };
}

// The remembered answers, as Settings → Categories lists them, by Merchant name.
export type TransferAnswerView = {
  id: string;
  merchantName: string;
  // The last 4 digits of each account number the lines hold, or empty.
  lastFours: string[];
  // "Keep it as a Transfer", "Not a Transfer", or the account's name.
  answer: string;
  madeAt: string;
};

export async function transferAnswerViews(database: Database): Promise<TransferAnswerView[]> {
  const names = new Map(
    (await listDecisionAccounts(database)).map((account) => [account.id, account.name]),
  );
  return (await listTransferAnswers(database)).map((stored) => ({
    id: stored.id,
    merchantName: stored.merchantName,
    lastFours: stored.lastFours === "" ? [] : stored.lastFours.split(","),
    answer:
      stored.answer === "keep"
        ? KEEP.label
        : stored.answer === "not a transfer"
          ? NOT_A_TRANSFER.label
          : (names.get(stored.accountId ?? "") ?? "An account"),
    madeAt: stored.madeAt.toISOString(),
  }));
}

// A Member deletes a remembered answer. Each shown Transaction it decided, a one-sided result of
// its key with no type or account set by hand, goes back through the follow-up job, in the same
// transaction, so it asks again. One read of the one-sided results, and one write (K3). False when
// no remembered answer has the ID.
export async function deleteTransferAnswer(database: Database, id: string): Promise<boolean> {
  const again = await database.transaction(async (tx) => {
    const removed = await removeTransferAnswer(tx, id);
    if (removed === undefined) return undefined;
    const text = keyText(removed);
    const ids = (await listCardFactsAt(tx, ONE_SIDED_STEPS))
      .filter((facts) => {
        if (!stillAsks(facts)) return false;
        const key = oneSidedKeyOf(facts);
        return key !== null && keyText(key) === text;
      })
      .map((facts) => facts.id);
    await followUpAgain(tx, ids);
    return ids;
  });
  if (again === undefined) return false;
  log.info("A Member deleted a remembered Transfer answer", { decidedAgain: again.length });
  if (again.length > 0) {
    try {
      await askForFollowUp();
    } catch (error) {
      log.error("Could not start a follow-up job after a Member's change", { error });
    }
  }
  return true;
}
