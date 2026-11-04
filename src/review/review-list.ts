import {
  addReviewItem,
  addReviewItems,
  answerOpenReviewItem,
  closeReviewItems,
  countOpenReviewItems,
  type Database,
  listOpenReviewItems,
  type Queries,
  readReviewItem,
  type StoredReviewItem,
} from "../db/index.ts";
import { log } from "../log.ts";

// The Review list (spec 07, Review list page; spec 03 and 04, Review list items). It is optional:
// each item already has a result that counts, and nothing ever waits for it. Opening an item
// changes no data that counts, so totals stay as they are while it is open. The Review list sends
// no push and no email.
// - Each kind of item registers its other choices and how a Member's answer applies. Its owner
//   ticket opens its items.
// - An item closes when a Member answers it, by accepting the best answer or picking another
//   choice, or when a later event settles it.
// - Every answer counts as hand-set. Each kind's answer sets the hand-set marks on its subject.

export type ReviewChoice = { value: string; label: string };

export type ReviewSubject =
  | { type: "transactions"; transactionIds: string[] }
  | { type: "loan"; accountId: string };

export type ReviewItem = {
  id: string;
  kind: string;
  subject: ReviewSubject;
  // What the app decided, or could not settle, in words.
  decided: string;
  bestAnswer: ReviewChoice;
  createdAt: Date;
};

export type ReviewKind = {
  // The choices behind "Not this", such as the Category list. The best answer may be among them.
  otherChoices(item: ReviewItem): Promise<ReviewChoice[]>;
  // Applies a Member's answer to the item's subject, and sets its hand-set marks. It runs inside
  // the transaction that closes the item, so it writes only through `answering.database`.
  answer(
    item: ReviewItem,
    choice: ReviewChoice,
    answering: { memberId: string; database: Queries },
  ): Promise<void>;
  // Optional work after the answer's transaction commits, outside the queue, such as starting a
  // follow-up job. If it fails, the app logs the error and the item stays answered.
  afterAnswer?(
    item: ReviewItem,
    choice: ReviewChoice,
    answered: { memberId: string; database: Database },
  ): Promise<void>;
};

const kinds = new Map<string, ReviewKind>();

// Registers a kind of item. Returns a function that removes it again.
export function registerReviewKind(kind: string, handler: ReviewKind): () => void {
  if (kind.trim() === "") throw new Error("A Review list kind needs a name.");
  if (kinds.has(kind)) throw new Error(`The Review list kind "${kind}" is already registered.`);
  kinds.set(kind, handler);
  return () => {
    if (kinds.get(kind) === handler) kinds.delete(kind);
  };
}

function itemOf(stored: StoredReviewItem): ReviewItem {
  const subject: ReviewSubject =
    stored.subjectType === "transactions"
      ? { type: "transactions", transactionIds: stored.subjectIds }
      : { type: "loan", accountId: stored.subjectIds[0] ?? "" };
  return {
    id: stored.id,
    kind: stored.kind,
    subject,
    decided: stored.decided,
    bestAnswer: stored.bestAnswer,
    createdAt: stored.createdAt,
  };
}

function subjectIdsOf(subject: ReviewSubject): string[] {
  return subject.type === "transactions" ? subject.transactionIds : [subject.accountId];
}

type NewItem = { kind: string; subject: ReviewSubject; decided: string; bestAnswer: ReviewChoice };

function storedItem(item: NewItem) {
  if (!kinds.has(item.kind)) throw new Error(`No Review list kind "${item.kind}" is registered.`);
  const subjectIds = subjectIdsOf(item.subject);
  if (subjectIds.length === 0 || subjectIds.some((id) => id === "")) {
    throw new Error("A Review list item needs its Transactions or its loan.");
  }
  return {
    kind: item.kind,
    subjectType: item.subject.type,
    subjectIds,
    decided: item.decided,
    bestAnswer: item.bestAnswer,
  };
}

// Opens an item of a registered kind, and returns its ID.
export async function openReviewItem(database: Database, item: NewItem): Promise<string> {
  return addReviewItem(database, storedItem(item), new Date());
}

// Opens several items at once, in one transaction, and returns their IDs in order.
export async function openReviewItemBatch(
  database: Database,
  items: readonly NewItem[],
): Promise<string[]> {
  const stored = items.map(storedItem);
  if (stored.length === 0) return [];
  return database.transaction((tx) => addReviewItems(tx, stored, new Date()));
}

// Every open item, newest first.
export async function openReviewItems(database: Database): Promise<ReviewItem[]> {
  return (await listOpenReviewItems(database)).map(itemOf);
}

export function countReviewItems(database: Database): Promise<number> {
  return countOpenReviewItems(database);
}

async function openItem(database: Database, id: string) {
  const stored = await readReviewItem(database, id);
  if (stored === undefined || stored.closedAt !== null) return undefined;
  const kind = kinds.get(stored.kind);
  if (kind === undefined) throw new Error(`No Review list kind "${stored.kind}" is registered.`);
  return { item: itemOf(stored), kind };
}

// The choices behind "Not this" for an open item. Undefined when no open item has this ID.
export async function otherReviewChoices(
  database: Database,
  id: string,
): Promise<ReviewChoice[] | undefined> {
  const open = await openItem(database, id);
  return open === undefined ? undefined : open.kind.otherChoices(open.item);
}

// Answers and settling events close items one at a time, so an event never closes an item while
// its answer runs. The app is one Node process (ADR 0002), so this queue covers every caller. It
// also keeps other writes out of an answer's transaction: libSQL's local driver waits for a locked
// database on the event loop, so a write from this process during the transaction would stall it.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

export type ReviewAnswerResult = "answered" | "not open" | "not a choice";

// A Member's answer: the best answer's value, or one of the other choices. The kind applies it and
// the item closes as answered, in one transaction: an answer that fails partway leaves the item
// open with nothing applied, and two answers, or an answer and a settling event, never both close
// it.
export async function answerReviewItem(
  database: Database,
  id: string,
  value: string,
  memberId: string,
): Promise<ReviewAnswerResult> {
  let applied: { kind: ReviewKind; item: ReviewItem; choice: ReviewChoice } | undefined;
  const answered = await oneAtATime(async (): Promise<ReviewAnswerResult> => {
    const result = await answerOpenReviewItem(
      database,
      id,
      async (tx, stored) => {
        const kind = kinds.get(stored.kind);
        if (kind === undefined) {
          throw new Error(`No Review list kind "${stored.kind}" is registered.`);
        }
        const item = itemOf(stored);
        const choice =
          value === item.bestAnswer.value
            ? item.bestAnswer
            : (await kind.otherChoices(item)).find((other) => other.value === value);
        if (choice === undefined) return undefined;
        await kind.answer(item, choice, { memberId, database: tx });
        applied = { kind, item, choice };
        return choice;
      },
      memberId,
      new Date(),
    );
    if (result === "refused") return "not a choice";
    if (result === "answered") log.info("A Member answered a Review list item", { itemId: id });
    return result;
  });
  if (answered === "answered" && applied !== undefined) {
    try {
      await applied.kind.afterAnswer?.(applied.item, applied.choice, { memberId, database });
    } catch (error) {
      log.error("The work after a Review list answer failed", {
        itemId: id,
        kind: applied.item.kind,
        error,
      });
    }
  }
  return answered;
}

// A later event settled every open item of this kind about this Transaction or loan, such as a
// later AI answer with high confidence, or about any of several, which reads the open items once.
// Returns how many closed. `reason` says what settled them.
export async function settleReviewItems(
  database: Database,
  about: { kind: string; subjectId: string } | { kind: string; subjectIds: readonly string[] },
  reason: string,
): Promise<number> {
  if (reason.trim() === "" || reason === "answered") {
    throw new Error("Say which event settled the Review list item.");
  }
  const subjects = new Set("subjectId" in about ? [about.subjectId] : about.subjectIds);
  if (subjects.size === 0) return 0;
  return oneAtATime(async () => {
    const settled = (await listOpenReviewItems(database)).filter(
      (item) => item.kind === about.kind && item.subjectIds.some((id) => subjects.has(id)),
    );
    return closeReviewItems(
      database,
      settled.map((item) => item.id),
      { reason, at: new Date() },
    );
  });
}
