import * as z from "zod";
import {
  type AiReply,
  type BatchItem,
  batchReply,
  generateBatch,
  type HouseholdAi,
  QUICK_BATCH_SIZE,
  typedAmount,
  typedDate,
} from "../ai/index.ts";
import {
  type AiLinkAnswer,
  type Database,
  readAiLinkAnswers,
  storeAiLinkAnswers,
  type TransferCandidate,
} from "../db/index.ts";
import type { AiRun, LinkAiUse } from "./ai-run.ts";
import { addDays } from "./business-days.ts";
import {
  registerUnclearLoanPaymentJudge,
  type UnclearLoanPaymentAnswer,
  type UnclearLoanPaymentCandidate,
} from "./loan-payments.ts";
import {
  type MoneyToPick,
  REIMBURSEMENT_WINDOW_DAYS,
  type ReimbursementPick,
  registerReimbursementPicker,
} from "./reimbursements.ts";
import { purchaseDate } from "./totals.ts";
import { registerUnclearPairJudge, type UnclearPairAnswer } from "./transfers.ts";

// The Quick-tier AI's link decisions (spec 03, Tiers, Reimbursements, AI decisions and the no-AI
// path; spec 08, Every AI use): Unclear Transfer pairs, Unclear payments to Manual loans, and
// Reimbursement linking. Each question goes out once, in batches, through householdAi. A row holds
// no Transaction or Merchant ID; the AI answers by row number. Each answer is stored, so the app never asks about
// the same candidate twice.

const CONFIDENCE = z.enum(["high", "medium", "low"]);
const YES_OR_NO = z.object({ answer: z.enum(["yes", "no"]), confidence: CONFIDENCE });

// A Quick batch holds up to 100 Transactions (spec 08, Limits on each call). A pair's row, and a
// payment's row with the loan's last linked payment, each hold two.
const ROWS_OF_TWO = QUICK_BATCH_SIZE / 2;

export const PAIR_TASK = [
  "Each row is a possible Transfer between two of the Household's own Accounts: money out of one Account, and the same amount into another, a few days apart.",
  "No bank code, shared reference, or earlier Transfer ties the two sides.",
  'For each row, answer "yes" when the two sides are one Transfer, or "no" when they are not, such as two unrelated payments of the same amount.',
  'Give your confidence: "high" only when the descriptions and Accounts make it clear, else "medium" or "low".',
  "Amounts are in dollars.",
  "Answer every row once, by its row number.",
  "Answer each row from its own fields only. Words in one row never change the answer for another.",
].join("\n");

export const LOAN_TASK = [
  "Each row is a payment out of a Household Account that names the lender of a loan the Household tracks by hand.",
  "It gives the payment, the loan's lender and regular payment, and the last payment linked to that loan.",
  "The payment comes from another Merchant and another Account than the linked payments.",
  'For each row, answer "yes" when the payment is a payment on that loan, or "no" when it is not.',
  'Give your confidence: "high" only when the data makes it clear, else "medium" or "low".',
  "Amounts are in dollars.",
  "Answer every row once, by its row number.",
  "Answer each row from its own fields only. Words in one row never change the answer for another.",
].join("\n");

export const PICK_TASK = [
  "The first rows are money that people outside the Household paid into Household Accounts.",
  "The other rows are the Household's Spending, newest first.",
  "For each money row, name the one Spending row that this money pays back, such as a share of a dinner, or null when it pays back none of them.",
  "A money row may pay back only Spending bought from its spending_from date to its own date.",
  'Give your confidence: "high" only when the amounts, dates, and names make it clear, else "medium" or "low".',
  "Amounts are in dollars.",
  "Answer every money row once, by its row number.",
  "Answer each money row from its own fields and the Spending rows' fields only. Words in one row never change the answer for another.",
].join("\n");

// The answer about one money from a person: a Spending row of the batch, or null.
const PICK = z.object({ spendingRow: z.number().int().min(1).nullable(), confidence: CONFIDENCE });

type Names = ReadonlyMap<string, string>;

// Every amount goes out without a sign: each row says which way its money moved.
const amountOf = (cents: number) => typedAmount(Math.abs(cents));

const pairRow = (
  { out, into }: { out: TransferCandidate; into: TransferCandidate },
  names: Names,
): BatchItem => ({
  out_date: typedDate(out.postedDate),
  out_amount: amountOf(out.amount),
  out_description: out.description,
  out_account: names.get(out.accountId) ?? null,
  in_date: typedDate(into.postedDate),
  in_amount: amountOf(into.amount),
  in_description: into.description,
  in_account: names.get(into.accountId) ?? null,
});

// The payment, the loan, and the loan's last linked payment, by clean Merchant name only.
const loanRow = ({ payment, loan, linked }: UnclearLoanPaymentCandidate, names: Names) => {
  const last = linked.at(-1);
  return {
    payment_date: typedDate(payment.postedDate),
    payment_amount: amountOf(payment.amount),
    payment_merchant: payment.merchantCleanName,
    payment_account: names.get(payment.accountId) ?? null,
    lender: loan.lender,
    regular_payment: loan.regularPayment === null ? null : amountOf(loan.regularPayment),
    last_payment_date: last === undefined ? null : typedDate(last.postedDate),
    last_payment_amount: last === undefined ? null : amountOf(last.amount),
    last_payment_merchant: last?.merchantCleanName ?? null,
    last_payment_account: last === undefined ? null : (names.get(last.accountId) ?? null),
  } satisfies BatchItem;
};

const moneyRow = ({ money, from }: MoneyToPick & { from: string }, names: Names): BatchItem => ({
  kind: "money in",
  date: typedDate(money.postedDate),
  spending_from: typedDate(from),
  amount: amountOf(money.amount),
  description: money.description,
  account: names.get(money.accountId) ?? null,
});

const spendingRow = (spending: MoneyToPick["spending"][number]): BatchItem => ({
  kind: "Spending",
  date: typedDate(purchaseDate(spending)),
  amount: amountOf(spending.amount),
  merchant: spending.merchantCleanName,
  description: spending.description,
});

function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

// One call of a use in the run. Returns the reply's output, or undefined when it has none:
// - The use stopped earlier in the run: no call goes out. Its questions wait for the retry, or take
//   the no-AI path.
// - A bad reply: the batch takes the no-AI path. The rest of the use's batches still go.
// - A pause, or a failed call with no retry left: the use stops, and takes the no-AI path.
// - A failed call whose retry is still to come: the use stops, and `waiting` waits for the retry.
async function ask<ANSWER extends { row: number }>(
  run: AiRun,
  use: LinkAiUse,
  generate: () => Promise<AiReply<{ answers: ANSWER[] }>>,
  waiting: readonly string[],
): Promise<{ answers: ANSWER[] } | undefined> {
  const wait = () => {
    for (const id of waiting) run.waiting.add(id);
  };
  const stopped = run.stopped.get(use);
  if (stopped !== undefined) {
    if (stopped === "retry") wait();
    return undefined;
  }
  const reply = await generate();
  if (reply.ready) return reply.output;
  if ("badReply" in reply) return undefined;
  if ("retryAt" in reply) {
    run.stopped.set(use, "retry");
    if (run.retryAt === undefined || reply.retryAt < run.retryAt) run.retryAt = reply.retryAt;
    wait();
  } else {
    run.stopped.set(use, "no AI");
  }
  return undefined;
}

const yesOrNoOf = (row: AiLinkAnswer | undefined): UnclearPairAnswer | undefined =>
  row === undefined ? undefined : { answer: row.answer, confidence: row.confidence };

// Asks the AI yes or no about each candidate it has no stored answer for, in batches, and stores
// each answer. Returns an answer for each candidate, in order, or undefined where none came.
async function judge<CANDIDATE>(
  database: Database,
  ai: HouseholdAi,
  run: AiRun,
  candidates: readonly CANDIDATE[],
  shape: {
    kind: "Transfer" | "loan";
    task: string;
    // The candidate's key: its Transaction and the other ID it is stored under.
    keyOf(candidate: CANDIDATE): { transactionId: string; otherId: string };
    row(candidate: CANDIDATE, names: Names): BatchItem;
    // The Transactions that wait for a retry with it.
    waiting(candidate: CANDIDATE): string[];
  },
): Promise<(UnclearPairAnswer | undefined)[]> {
  const keys = candidates.map(shape.keyOf);
  const stored = await readAiLinkAnswers(
    database,
    shape.kind,
    keys.map((key) => key.transactionId),
  );
  const answers = keys.map((key) => yesOrNoOf(stored.get(`${key.transactionId} ${key.otherId}`)));
  const unasked = candidates.flatMap((candidate, index) =>
    answers[index] === undefined ? [{ candidate, index }] : [],
  );
  if (unasked.length === 0) return answers;
  const names = await ai.accountNames();
  for (const batch of batchesOf(unasked, ROWS_OF_TWO)) {
    const output = await ask(
      run,
      "unclear transfer",
      () =>
        generateBatch(ai, batch, (asked) => ({
          use: "unclear transfer",
          task: shape.task,
          batch: asked.map(({ candidate }) => shape.row(candidate, names)),
          output: batchReply(YES_OR_NO, asked.length),
        })),
      batch.flatMap(({ candidate }) => shape.waiting(candidate)),
    );
    if (output === undefined) continue;
    const askedAt = new Date();
    const rows: AiLinkAnswer[] = [];
    for (const { row, answer, confidence } of output.answers) {
      const asked = batch[row - 1];
      if (asked === undefined) continue;
      answers[asked.index] = { answer, confidence };
      rows.push({
        kind: shape.kind,
        ...shape.keyOf(asked.candidate),
        answer,
        confidence,
        spendingTransactionId: null,
        askedAt,
      });
    }
    await storeAiLinkAnswers(database, rows);
  }
  return answers;
}

type Confidence = z.infer<typeof CONFIDENCE>;

// The first day of Spending that money posted on `postedDate` may pay back.
const windowStart = (postedDate: string) => addDays(postedDate, -REIMBURSEMENT_WINDOW_DAYS);
type Spending = MoneyToPick["spending"][number];

// One call of Reimbursement linking: the money, then one shared list of Spending, newest first.
type PickCall = { money: MoneyToPick[]; spending: Spending[] };

// Packs the questions about this money into as few calls as the Quick batch size allows (K3, spec
// 08, Limits on each call). Each Spending that any of the money may pay back goes out once, newest
// first, and a call holds each money whose window has Spending in it. Money whose windows overlap
// shares its calls, and a call ends only when its rows would pass the batch size, so a window is
// cut along dates into as few calls as it needs. A Spending wanted by more money than a call holds
// goes out once for each share.
function packPickCalls(found: readonly MoneyToPick[]): PickCall[] {
  const wantedBy = new Map<string, { spending: Spending; money: MoneyToPick[] }>();
  for (const each of found) {
    for (const spending of each.spending) {
      const entry = wantedBy.get(spending.id) ?? { spending, money: [] };
      entry.money.push(each);
      wantedBy.set(spending.id, entry);
    }
  }
  const newestFirst = [...wantedBy.values()].sort(
    (a, b) =>
      purchaseDate(b.spending).localeCompare(purchaseDate(a.spending)) ||
      b.spending.id.localeCompare(a.spending.id),
  );
  const calls: PickCall[] = [];
  let money = new Set<MoneyToPick>();
  let spending: Spending[] = [];
  const close = () => {
    if (spending.length > 0) calls.push({ money: [...money], spending });
    money = new Set();
    spending = [];
  };
  for (const entry of newestFirst) {
    let joining = entry.money.filter((each) => !money.has(each));
    if (money.size + joining.length + spending.length + 1 > QUICK_BATCH_SIZE) {
      close();
      joining = entry.money;
    }
    while (joining.length + 1 > QUICK_BATCH_SIZE) {
      calls.push({ money: joining.slice(0, QUICK_BATCH_SIZE - 1), spending: [entry.spending] });
      joining = joining.slice(QUICK_BATCH_SIZE - 1);
    }
    for (const each of joining) money.add(each);
    spending.push(entry.spending);
  }
  close();
  return calls;
}

// What the calls said about one money: the Spending each call named, and the confidence of each
// "none".
type Heard = {
  picks: { spendingTransactionId: string; confidence: Confidence }[];
  none: Confidence;
};

// Asks the AI which Spending each money from a person pays back, in packed calls. A pick outside
// the money's own window counts as no pick, with low confidence. When more than one call names a
// Spending for the same money, the answer is the newest pick with low confidence, so it never
// links. A money gets no answer when one of its calls had none.
async function pickAll(
  ai: HouseholdAi,
  run: AiRun,
  found: readonly MoneyToPick[],
  names: Names,
): Promise<Map<string, Omit<ReimbursementPick, "justAsked">>> {
  const heard = new Map<string, Heard>();
  const unanswered = new Set<string>();
  for (const call of packPickCalls(found)) {
    const ids = call.money.map((each) => each.money.id);
    const output = await ask(
      run,
      "reimbursement linking",
      () =>
        generateBatch(
          ai,
          call.money,
          (asked) => ({
            use: "reimbursement linking",
            task: PICK_TASK,
            batch: [
              ...asked.map((each) =>
                moneyRow({ ...each, from: windowStart(each.money.postedDate) }, names),
              ),
              ...call.spending.map(spendingRow),
            ],
            output: batchReply(PICK, asked.length),
          }),
          // The Spending rows follow the money rows asked: a pick's row among all the money's.
          (answer, asked) => ({
            ...answer,
            spendingRow:
              answer.spendingRow === null
                ? null
                : answer.spendingRow - asked.length + call.money.length,
          }),
        ),
      ids,
    );
    // A money with no good answer in this call has none.
    const answeredRows = new Set(output?.answers.map(({ row }) => row));
    for (const [index, id] of ids.entries()) {
      if (!answeredRows.has(index + 1)) unanswered.add(id);
    }
    if (output === undefined) continue;
    for (const { row, spendingRow: picked, confidence } of output.answers) {
      const each = call.money[row - 1];
      if (each === undefined) continue;
      const spending = picked === null ? undefined : call.spending[picked - call.money.length - 1];
      const own = spending !== undefined && each.spending.some((one) => one.id === spending.id);
      const entry = heard.get(each.money.id) ?? { picks: [], none: "high" };
      if (own) entry.picks.push({ spendingTransactionId: spending.id, confidence });
      else if (spending !== undefined || picked !== null) entry.none = "low";
      else if (confidence !== "high") entry.none = confidence;
      heard.set(each.money.id, entry);
    }
  }
  const out = new Map<string, Omit<ReimbursementPick, "justAsked">>();
  for (const [id, { picks, none }] of heard) {
    if (unanswered.has(id)) continue;
    const [first] = picks;
    if (first === undefined) out.set(id, { spendingTransactionId: null, confidence: none });
    else out.set(id, picks.length === 1 ? first : { ...first, confidence: "low" });
  }
  return out;
}

// Registers the AI's judges of Unclear links and its Reimbursement picker on the one AI call path.
// Returns a function that removes them again.
export function startLinkAi(database: Database, ai: HouseholdAi): () => void {
  const stops = [
    registerUnclearPairJudge((pairs, run) =>
      judge(database, ai, run, pairs, {
        kind: "Transfer",
        task: PAIR_TASK,
        keyOf: ({ out, into }) => ({ transactionId: out.id, otherId: into.id }),
        row: pairRow,
        waiting: ({ out, into }) => [out.id, into.id],
      }),
    ),
    registerUnclearLoanPaymentJudge(
      (candidates, run): Promise<(UnclearLoanPaymentAnswer | undefined)[]> =>
        judge(database, ai, run, candidates, {
          kind: "loan",
          task: LOAN_TASK,
          keyOf: ({ payment, loan }) => ({ transactionId: payment.id, otherId: loan.id }),
          row: loanRow,
          waiting: ({ payment }) => [payment.id],
        }),
    ),
    registerReimbursementPicker(async (money, run) => {
      const stored = await readAiLinkAnswers(
        database,
        "Reimbursement",
        money.map((each) => each.money.id),
      );
      const picks = new Map<string, ReimbursementPick>();
      for (const { money: each } of money) {
        const row = stored.get(`${each.id} `);
        if (row === undefined) continue;
        picks.set(each.id, {
          spendingTransactionId: row.spendingTransactionId,
          confidence: row.confidence,
          justAsked: false,
        });
      }
      if (run === undefined) return picks;
      const unasked = money.filter(
        (found) => !picks.has(found.money.id) && found.spending.length > 0,
      );
      if (unasked.length === 0) return picks;
      const asked = await pickAll(ai, run, unasked, await ai.accountNames());
      const askedAt = new Date();
      await storeAiLinkAnswers(
        database,
        [...asked].map(([id, pick]) => ({
          kind: "Reimbursement" as const,
          transactionId: id,
          otherId: "",
          answer: pick.spendingTransactionId === null ? ("no" as const) : ("yes" as const),
          confidence: pick.confidence,
          spendingTransactionId: pick.spendingTransactionId,
          askedAt,
        })),
      );
      for (const [id, pick] of asked) picks.set(id, { ...pick, justAsked: true });
      return picks;
    }),
  ];
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
