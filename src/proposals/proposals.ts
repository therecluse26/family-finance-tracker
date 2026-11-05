import * as z from "zod";
import { YEARLY_CATEGORIES } from "../budgets/index.ts";
import { type Category, categoryGroupOf, isCategory } from "../categories/index.ts";
import {
  type AppliedGoalChange,
  claimGoalAmount,
  type Database,
  dropHouseholdSummary,
  expireProposals,
  listBankNames,
  listBudgetsInEffect,
  listChatProposals,
  listDueProposals,
  listGoals,
  listOpenProposals,
  listProposalsClosedSince,
  listUndoableProposals,
  type ProposalKind,
  type ProposalRow,
  type ProposalSource,
  type ProposalStatus,
  readGoal,
  readProposal,
  reopenProposal,
  type StoredBudget,
  type StoredGoal,
  storeBudgetChangeAccept,
  storeGoalAmountApplied,
  storeNewGoalAccept,
  storeProposal,
  storeProposalSkip,
  storeProposalUndo,
} from "../db/index.ts";
import { calendarDateIn, wholeDollars } from "../format.ts";
import { startGoal } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { totalsByMonth } from "../money-movement/index.ts";
import { namedCompany, US_BANKS_AND_LENDERS } from "./companies.ts";

// Proposals (spec 08, Proposals; spec 05, What accepting a Proposal changes): a change the AI
// suggests. The app enforces every guardrail here, in code, for every source, whatever the prompt
// said. Nothing changes until a Member accepts. Accepting, editing, skipping and Undo make no AI
// call. The only changes a Proposal can make are a Budget amount, a Goal amount, and a new Goal:
// nothing here moves money.

// At most 2 Proposals in one answer, review, or tailoring run (rule 3).
export const MAX_PROPOSALS_PER_RUN = 2;
// An open Proposal closes as "expired" after 60 days.
export const PROPOSAL_DAYS = 60;
// A Proposal's text: a one-sentence reason, and a new Goal's words, under 15 words.
const MAX_REASON_LENGTH = 300;
const MAX_WORDS_LENGTH = 200;
const MAX_GOAL_WORDS = 14;
// The largest amount, in whole cents, as for a Member's Budget.
const MAX_CENTS = 100_000_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Each guardrail's words, which name the rule a refused Proposal broke (spec 08, Proposal tools).
export const GUARDRAIL = {
  perRun: `At most ${MAX_PROPOSALS_PER_RUN} Proposals in one answer, review, or tailoring run.`,
  shape:
    "A Proposal is a new Budget amount for one or more Categories, a Goal amount, or a new Goal, with a one-sentence reason. The AI cannot move money.",
  category: "Name each Category exactly as the Category list does, once.",
  chatOneCategory: "A Budget change from Chat holds one Category.",
  bills: "Bills are never proposed.",
  range:
    "A Budget change stays from 50% to 150% of the current Budget, or of the 3-month average Spending for a Category with no Budget.",
  goal: "The AI cannot edit or delete a Goal. A Goal amount is for an active Goal whose amount is not set yet.",
  company:
    "A Proposal never names a bank, card issuer, or lender: not one of the Household's, and not one on the app's list.",
  goalWords: `A new Goal is in the Member's plain words, under ${MAX_GOAL_WORDS + 1} words.`,
} as const;

const SOURCES = ["Chat", "Monthly review", "Budget tailoring"] as const satisfies ProposalSource[];

const cents = z.number().int().min(0).max(MAX_CENTS);
const text = (max: number) => z.string().trim().min(1).max(max);
const common = { source: z.enum(SOURCES), runId: text(200), reason: text(MAX_REASON_LENGTH) };

// What a run asks for. It comes from AI output, so every field is checked here.
const proposalInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("Budget change"),
      ...common,
      // A Budget tailoring run gives a one-sentence reason per Category.
      budgets: z
        .array(
          z
            .object({
              category: z.string(),
              amount: cents,
              reason: text(MAX_REASON_LENGTH).nullable().optional(),
            })
            .strict(),
        )
        .min(1),
      // A redraft's inputs, which the app records once the Proposal closes (spec 05, What
      // accepting a Proposal changes).
      redraft: z
        .object({
          steadyIncome: cents,
          ceDataYear: z.number().int().min(2000).max(9999),
          sampleBenchmarks: z.boolean(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("Goal amount"), ...common, goalId: text(100), goalAmount: cents })
    .strict(),
  z.object({ kind: z.literal("new Goal"), ...common, words: text(MAX_WORDS_LENGTH) }).strict(),
]);

export type ProposalInput = z.input<typeof proposalInput>;

export type ProposeResult =
  | { outcome: "shown"; id: string }
  | { outcome: "refused"; guardrail: string };

async function householdDay(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

const monthPlus = (month: string, count: number) => {
  const [year = 0, number = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + count, 1)).toISOString().slice(0, 7);
};

const wordCount = (words: string) => words.split(/\s+/u).filter((word) => word !== "").length;

// Each Category's Spending in the 3 complete calendar months before `month`, ÷ 3.
async function threeMonthAverages(database: Database, month: string): Promise<Map<string, number>> {
  const months = new Set([-3, -2, -1].map((back) => monthPlus(month, back)));
  const sums = new Map<string, number>();
  for (const totals of await totalsByMonth(database)) {
    if (!months.has(totals.month)) continue;
    for (const [category, spent] of Object.entries(totals.byCategory)) {
      sums.set(category, (sums.get(category) ?? 0) + (spent ?? 0));
    }
  }
  return new Map([...sums].map(([category, sum]) => [category, Math.round(sum / 3)]));
}

// Rule 4 for each of a Budget change's Categories, on `month`'s Budgets. Undefined when every
// Category passes, else the broken rule.
async function budgetRefusal(
  database: Database,
  source: ProposalSource,
  lines: readonly { category: string; amount: number }[],
  month: string,
): Promise<string | undefined> {
  const names = lines.map((line) => line.category);
  if (!names.every(isCategory) || new Set(names).size !== names.length) return GUARDRAIL.category;
  if (source === "Chat" && lines.length !== 1) return GUARDRAIL.chatOneCategory;
  if (names.some((name) => categoryGroupOf(name) === "Bills")) return GUARDRAIL.bills;
  const inEffect = new Map(
    (await listBudgetsInEffect(database, month)).map((row) => [row.category, row.amount]),
  );
  const averages = names.some((name) => !inEffect.has(name))
    ? await threeMonthAverages(database, month)
    : new Map<string, number>();
  for (const { category, amount } of lines) {
    // A yearly Category with no Budget measures from 12 times its monthly average.
    const yearly = YEARLY_CATEGORIES.includes(category as Category) ? 12 : 1;
    const base = inEffect.get(category) ?? (averages.get(category) ?? 0) * yearly;
    if (amount * 2 < base || amount * 2 > base * 3) return GUARDRAIL.range;
  }
  return undefined;
}

// Closes as "expired" each open Proposal 60 days old or more. Every read and write of Proposals
// runs it first, so an expired Proposal never shows and cannot be accepted. It writes only when one
// is due, so reading the AI box takes no write lock otherwise.
async function expire(database: Database, now: Date): Promise<void> {
  const due = await listDueProposals(database, new Date(now.getTime() - PROPOSAL_DAYS * DAY_MS));
  if (due.length === 0) return;
  const expired = await expireProposals(database, due, now);
  if (expired.length > 0) log.info("Proposals expired", { count: expired.length });
}

// Stores a Proposal from a run, once it passes every guardrail. It shows at once; nothing changes
// until a Member accepts it. A refused Proposal stores nothing, and its result names the broken
// guardrail.
export async function propose(
  database: Database,
  input: ProposalInput,
  now = new Date(),
): Promise<ProposeResult> {
  const refused = (guardrail: string): ProposeResult => ({ outcome: "refused", guardrail });
  const parsed = proposalInput.safeParse(input);
  if (!parsed.success) return refused(GUARDRAIL.shape);
  const proposal = parsed.data;
  // Only a Budget tailoring run redrafts.
  if (
    proposal.kind === "Budget change" &&
    proposal.redraft !== undefined &&
    proposal.source !== "Budget tailoring"
  ) {
    return refused(GUARDRAIL.shape);
  }
  await expire(database, now);
  const month = (await householdDay(database, now)).slice(0, 7);

  const texts = [proposal.reason];
  if (proposal.kind === "Budget change") {
    const broken = await budgetRefusal(database, proposal.source, proposal.budgets, month);
    if (broken !== undefined) return refused(broken);
    for (const line of proposal.budgets) if (line.reason != null) texts.push(line.reason);
  } else if (proposal.kind === "Goal amount") {
    // A Goal amount sets the number progress counts toward. It never changes one already set.
    const goal = await readGoal(database, proposal.goalId);
    if (goal === undefined || goal.status !== "active" || goal.goalAmount !== null) {
      return refused(GUARDRAIL.goal);
    }
  } else {
    if (wordCount(proposal.words) > MAX_GOAL_WORDS) return refused(GUARDRAIL.goalWords);
    texts.push(proposal.words);
  }
  const companies = [...(await listBankNames(database)), ...US_BANKS_AND_LENDERS];
  if (texts.some((each) => namedCompany(each, companies) !== undefined)) {
    return refused(GUARDRAIL.company);
  }

  const stored = await storeProposal(
    database,
    {
      kind: proposal.kind,
      source: proposal.source,
      runId: proposal.runId,
      reason: proposal.reason,
      goalId: proposal.kind === "Goal amount" ? proposal.goalId : null,
      goalAmount: proposal.kind === "Goal amount" ? proposal.goalAmount : null,
      words: proposal.kind === "new Goal" ? proposal.words : null,
      createdAt: now,
      budgets: proposal.kind === "Budget change" ? proposal.budgets : [],
      ...(proposal.kind === "Budget change" && proposal.redraft !== undefined
        ? { redraft: proposal.redraft }
        : {}),
    },
    MAX_PROPOSALS_PER_RUN,
  );
  if (stored === "run full") return refused(GUARDRAIL.perRun);
  log.info("The AI made a Proposal", {
    kind: proposal.kind,
    source: proposal.source,
    replaced: stored.replaced.length,
  });
  return { outcome: "shown", id: stored.id };
}

// One Category of a Budget change: its Budget in effect now, or null with none, and the proposed
// one, per month or per year.
export type ProposedBudget = {
  category: string;
  from: number | null;
  to: number;
  period: StoredBudget["period"];
};

// A Proposal as its card shows it (spec 07, 1. AI box): the change, one line each, such as
// "Restaurants Budget: $600 → $480", and the AI's reason. A Budget tailoring run's line ends with
// its Category's reason.
export type Proposal = {
  id: string;
  kind: ProposalKind;
  source: ProposalSource;
  createdAt: Date;
  reason: string;
  changes: string[];
  // A Budget change's Categories, in the order proposed. Empty for a Goal Proposal.
  budgets: ProposedBudget[];
  // A Goal amount's Goal, with its words, and the amount.
  goal: { id: string; words: string; goalAmount: number } | null;
  // A new Goal's words.
  words: string | null;
};

function budgetLine({ category, from, to, period }: ProposedBudget, reason: string | null): string {
  const each = period === "yearly" ? " a year" : "";
  const was = from === null ? "no Budget" : `${wholeDollars(from)}${each}`;
  const line = `${category} Budget: ${was} → ${wholeDollars(to)}${each}`;
  return reason === null ? line : `${line}. ${reason}`;
}

async function cardsOf(
  database: Database,
  rows: ProposalRow[],
  month: string,
): Promise<Proposal[]> {
  const inEffect = new Map(
    (await listBudgetsInEffect(database, month)).map((row) => [row.category, row]),
  );
  const goals = rows.some((row) => row.kind === "Goal amount")
    ? new Map((await listGoals(database)).map((goal) => [goal.id, goal]))
    : new Map<string, StoredGoal>();
  return rows.map((row): Proposal => {
    const budgets = row.budgets.map((line): ProposedBudget => {
      const current = inEffect.get(line.category);
      const yearly = YEARLY_CATEGORIES.includes(line.category as Category);
      return {
        category: line.category,
        // An accepted Proposal shows the Budget it replaced; an open one the Budget in effect now.
        from: line.appliedBudgetId === null ? (current?.amount ?? null) : line.replacedAmount,
        to: line.amount,
        period: current?.period ?? (yearly ? "yearly" : "monthly"),
      };
    });
    const goal =
      row.kind === "Goal amount" && row.goalId !== null && row.goalAmount !== null
        ? {
            id: row.goalId,
            words: goals.get(row.goalId)?.words ?? "",
            goalAmount: row.goalAmount,
          }
        : null;
    const changes =
      row.kind === "Budget change"
        ? budgets.map((budget, index) => budgetLine(budget, row.budgets[index]?.reason ?? null))
        : goal !== null
          ? [`Goal amount for "${goal.words}": ${wholeDollars(goal.goalAmount)}`]
          : [`New Goal: "${row.words ?? ""}"`];
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      createdAt: row.createdAt,
      reason: row.reason,
      changes,
      budgets,
      goal,
      words: row.words,
    };
  });
}

// The open Proposals, newest first, as their cards show them. Expired ones close first.
export async function openProposals(database: Database, now = new Date()): Promise<Proposal[]> {
  await expire(database, now);
  const month = (await householdDay(database, now)).slice(0, 7);
  return (await cardsOf(database, await listOpenProposals(database), month)).reverse();
}

// The open Proposals a Monthly review shows under "Budget changes to consider" (spec 07, Reviews
// page; spec 08, Review fields), newest first: those the review's own run made, whose run ID is
// the review's month, and those still open when it was written. It writes nothing, so opening a
// review changes nothing: one past its 60 days is left out, and closes at the next read that
// saves.
export async function openReviewProposals(
  database: Database,
  review: { month: string; writtenAt: Date },
  now = new Date(),
): Promise<Proposal[]> {
  const due = now.getTime() - PROPOSAL_DAYS * DAY_MS;
  const rows = (await listOpenProposals(database)).filter(
    (row) =>
      row.createdAt.getTime() > due &&
      (row.createdAt <= review.writtenAt ||
        (row.source === "Monthly review" && row.runId === review.month)),
  );
  const month = (await householdDay(database, now)).slice(0, 7);
  return (await cardsOf(database, rows, month)).reverse();
}

// The accepted Proposals whose Undo is still offered, newest first.
export async function undoableProposals(database: Database, now = new Date()): Promise<Proposal[]> {
  const month = (await householdDay(database, now)).slice(0, 7);
  return cardsOf(database, await listUndoableProposals(database, month), month);
}

// A Proposal a Member accepted or skipped, and when.
export type ClosedProposal = Proposal & { status: "accepted" | "skipped"; closedAt: Date };

// The Proposals a Member accepted or skipped after `since`, or ever with no `since`, in the order
// they closed: feedback for the next Insight card run (spec 08, Insight cards).
export async function closedProposals(
  database: Database,
  since: Date | undefined,
  now = new Date(),
): Promise<ClosedProposal[]> {
  const month = (await householdDay(database, now)).slice(0, 7);
  const rows = await listProposalsClosedSince(database, since);
  const cards = await cardsOf(database, rows, month);
  return cards.flatMap((card, index) => {
    const row = rows[index];
    if (row?.closedAt == null || (row.status !== "accepted" && row.status !== "skipped")) {
      return [];
    }
    return [{ ...card, status: row.status, closedAt: row.closedAt }];
  });
}

// A Member's Edit before "Save and accept": the amount of any of a Budget change's Categories, a
// Goal amount, or a new Goal's words. A Member's own edit is not bound by the 50% rule.
export type ProposalEdit = {
  budgets?: Record<string, number>;
  goalAmount?: number;
  words?: string;
};

export type AcceptResult = "accepted" | "not open" | { refused: string };

// The Edit's own refusal for this Proposal, or undefined when it fits: it changes only what the
// Proposal's kind holds.
function editRefusal(row: ProposalRow, edit: ProposalEdit): string | undefined {
  const wrong = "This Edit does not fit this Proposal.";
  if (row.kind !== "Budget change" && edit.budgets !== undefined) return wrong;
  if (row.kind !== "Goal amount" && edit.goalAmount !== undefined) return wrong;
  if (row.kind !== "new Goal" && edit.words !== undefined) return wrong;
  const categories = new Set(row.budgets.map((line) => line.category));
  if (Object.keys(edit.budgets ?? {}).some((category) => !categories.has(category))) return wrong;
  return undefined;
}

// A Member accepts an open Proposal, with their Edit when they used "Save and accept" (spec 05,
// What accepting a Proposal changes). The app records who accepted it and when.
// - A Budget change: each new Budget takes effect in the current month, or the current year for a
//   yearly Budget, with the source "Proposal".
// - A Goal amount: the Goal amount is set, and progress starts that day.
// - A new Goal: an active Goal is created, with the accepting Member as its author.
// It makes no AI call. "not open" when no open Proposal has the ID; a refusal changes nothing.
export async function acceptProposal(
  database: Database,
  accept: { id: string; memberId: string; edit?: ProposalEdit },
  now = new Date(),
): Promise<AcceptResult | undefined> {
  const { id, memberId, edit = {} } = accept;
  await expire(database, now);
  const row = await readProposal(database, id);
  if (row === undefined) return undefined;
  if (row.status !== "open") return "not open";
  const refusal = editRefusal(row, edit);
  if (refusal !== undefined) return { refused: refusal };
  const today = await householdDay(database, now);

  if (row.kind === "Budget change") {
    const amounts = new Map(row.budgets.map((line) => [line.category, line.amount]));
    for (const [category, amount] of Object.entries(edit.budgets ?? {}))
      amounts.set(category, amount);
    const periods = new Map(
      row.budgets.map((line) => [
        line.category,
        YEARLY_CATEGORIES.includes(line.category as Category) ? "yearly" : "monthly",
      ]),
    ) as Map<string, StoredBudget["period"]>;
    const accepted = await storeBudgetChangeAccept(database, {
      id,
      month: today.slice(0, 7),
      amounts,
      periods,
      memberId,
      at: now,
    });
    if (!accepted) return "not open";
  } else if (row.kind === "new Goal") {
    const goalId = await storeNewGoalAccept(database, {
      id,
      at: now,
      goal: {
        words: edit.words ?? row.words ?? "",
        authorId: memberId,
        date: today,
        target: null,
        change: null,
        deadline: null,
      },
    });
    if (goalId === undefined) return "not open";
  } else {
    const refused = await acceptGoalAmount(database, row, memberId, edit.goalAmount, now);
    if (refused !== undefined) return refused;
  }
  // A new Goal, or a Goal amount, is in the next Writer use's Household summary at once.
  if (row.kind !== "Budget change") await dropHouseholdSummary(database);
  log.info("A Member accepted a Proposal", {
    kind: row.kind,
    edited: Object.keys(edit).length > 0,
  });
  return "accepted";
}

const GOAL_START_REFUSAL = "This Goal cannot take a Goal amount now.";

// Sets a Goal amount through the goals module, once the Proposal is claimed. When the goals module
// refuses, or a step fails, the Goal gets back what it held, the Proposal opens again, and nothing
// stays changed.
async function acceptGoalAmount(
  database: Database,
  row: ProposalRow,
  memberId: string,
  edited: number | undefined,
  now: Date,
): Promise<"not open" | { refused: string } | undefined> {
  const goalAmount = edited ?? row.goalAmount;
  if (row.goalId === null || goalAmount === null) return { refused: GOAL_START_REFUSAL };
  const before = await readGoal(database, row.goalId);
  if (before === undefined || before.status !== "active") return { refused: GOAL_START_REFUSAL };
  if (!(await claimGoalAmount(database, { id: row.id, memberId, at: now }))) return "not open";
  const goal = {
    id: row.goalId,
    before: {
      goalAmount: before.goalAmount,
      startsOn: before.startsOn,
      startBalance: before.startBalance,
      baseline: before.baseline,
    },
  };
  try {
    const started = await startGoal(database, row.goalId, { goalAmount, now });
    if (typeof started === "string") {
      await reopenProposal(database, row.id);
      return { refused: GOAL_START_REFUSAL };
    }
    const applied: AppliedGoalChange = {
      goalAmount: started.goalAmount,
      startsOn: started.startsOn,
      before: goal.before,
    };
    await storeGoalAmountApplied(database, row.id, applied);
    return undefined;
  } catch (error) {
    await reopenProposal(database, row.id, goal);
    throw error;
  }
}

// A Member skips an open Proposal: it closes, and nothing changes. It makes no AI call. False when
// no open Proposal has the ID.
export async function skipProposal(
  database: Database,
  skip: { id: string; memberId: string },
  now = new Date(),
): Promise<boolean> {
  await expire(database, now);
  const skipped = await storeProposalSkip(database, { ...skip, at: now });
  if (skipped) log.info("A Member skipped a Proposal");
  return skipped;
}

// A Member undoes an accepted Proposal, while Undo is offered (spec 08, Lifecycle): it puts back
// the Budget amount the Proposal replaced, puts back what a Goal held before its Goal amount, or
// marks the new Goal dropped. It makes no AI call.
export async function undoProposal(
  database: Database,
  undo: { id: string; memberId: string },
  now = new Date(),
): Promise<"undone" | "not found" | "already undone" | "not offered"> {
  const today = await householdDay(database, now);
  const row = await readProposal(database, undo.id);
  const undone = await storeProposalUndo(database, {
    ...undo,
    month: today.slice(0, 7),
    today,
    at: now,
  });
  if (undone !== "undone") return undone;
  // A dropped new Goal, or a Goal's amount put back, is in the next Writer use's summary at once.
  if (row?.kind !== "Budget change") await dropHouseholdSummary(database);
  log.info("A Member undid a Proposal");
  return undone;
}

// A Chat Proposal as its thread shows it: its card, the run that made it, and its status.
export type ChatProposal = Proposal & { runId: string; status: ProposalStatus };

// The Proposals of the Chat runs whose IDs start with `runPrefix`, such as one thread's, oldest
// first, whatever their status (spec 08, Proposals: where it shows). Expired ones close first.
export async function chatProposals(
  database: Database,
  runPrefix: string,
  now = new Date(),
): Promise<ChatProposal[]> {
  await expire(database, now);
  const month = (await householdDay(database, now)).slice(0, 7);
  const rows = await listChatProposals(database, runPrefix);
  const cards = await cardsOf(database, rows, month);
  return rows.flatMap((row, index) => {
    const card = cards[index];
    return card === undefined ? [] : [{ ...card, runId: row.runId, status: row.status }];
  });
}
