import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { type RedraftInputs, recordClosedRedrafts } from "./budget-tailoring.ts";
import { listBudgetsInEffect, type StoredBudget } from "./budgets.ts";
import type { Database, Queries } from "./client.ts";
import type { GoalStart, NewGoal, StoredGoal } from "./goals.ts";
import {
  budgets,
  connections,
  goals,
  householdAccounts,
  proposalBudgets,
  proposals,
  redraftProposals,
} from "./schema.ts";

// Proposals in app.db (spec 08, Proposals): each Proposal, its Categories, what accepting it
// changed, and its Undo. The proposals module checks the guardrails and decides; these functions
// store and read. Each write that claims a Proposal changes it only from the status it expects, so
// two taps at once change it once.

export type StoredProposal = typeof proposals.$inferSelect;
export type ProposalKind = StoredProposal["kind"];
export type ProposalSource = StoredProposal["source"];
export type ProposalStatus = StoredProposal["status"];
export type StoredProposalBudget = typeof proposalBudgets.$inferSelect;

// A Proposal with its Categories, in the order they were proposed. Only a Budget change has any.
export type ProposalRow = StoredProposal & { budgets: ProposalBudgetRow[] };

// A Category of a Budget change, with the amount of the Budget it replaced, once accepted.
export type ProposalBudgetRow = StoredProposalBudget & { replacedAmount: number | null };

export type NewProposal = Pick<
  StoredProposal,
  "kind" | "source" | "runId" | "reason" | "goalId" | "goalAmount" | "words" | "createdAt"
> & {
  budgets: { category: string; amount: number; reason?: string | null }[];
  // A redraft's inputs, which its close records.
  redraft?: RedraftInputs;
};

// What accepting a Goal Proposal set, for Undo: a Goal amount and its start, with what the Goal held
// before; or the words of the new Goal it created.
export type AppliedGoalChange =
  | { goalAmount: number; startsOn: string; before: GoalStart }
  | { words: string };

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

// The Household's banks and lenders, as their names: each Connection's bank, and each Account's
// institution, which for a Manual loan is its lender. Each name once.
export async function listBankNames(database: Database): Promise<string[]> {
  const banks = await database.selectDistinct({ name: connections.bankName }).from(connections);
  const institutions = await database
    .selectDistinct({ name: householdAccounts.institutionName })
    .from(householdAccounts)
    .where(isNotNull(householdAccounts.institutionName));
  return [
    ...new Set([...banks, ...institutions].flatMap(({ name }) => (name === null ? [] : [name]))),
  ];
}

// Stores a new open Proposal and its Categories in one write, unless its run already made
// `perRun`. A newer Budget change drops each of its Categories from every older open Budget
// change, and an older one left with no Category closes as "replaced" (spec 08, Lifecycle). Goal
// Proposals never replace each other. Returns the new ID and the IDs it replaced, or "run full"
// with nothing written.
export async function storeProposal(
  database: Database,
  proposal: NewProposal,
  perRun: number,
): Promise<{ id: string; replaced: string[] } | "run full"> {
  const { budgets: lines, redraft, ...fields } = proposal;
  return database.transaction(async (tx) => {
    const [made] = await tx
      .select({ count: count() })
      .from(proposals)
      .where(and(eq(proposals.source, fields.source), eq(proposals.runId, fields.runId)));
    if ((made?.count ?? 0) >= perRun) return "run full";
    const id = crypto.randomUUID();
    await tx.insert(proposals).values({ id, ...fields, status: "open" });
    if (redraft !== undefined) {
      await tx.insert(redraftProposals).values({ proposalId: id, ...redraft });
    }
    if (lines.length === 0) return { id, replaced: [] };
    await tx.insert(proposalBudgets).values(lines.map((line) => ({ proposalId: id, ...line })));
    const older = tx
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.status, "open"),
          eq(proposals.kind, "Budget change"),
          sql`${proposals.id} <> ${id}`,
        ),
      );
    await tx.delete(proposalBudgets).where(
      and(
        inArray(
          proposalBudgets.category,
          lines.map((line) => line.category),
        ),
        inArray(proposalBudgets.proposalId, older),
      ),
    );
    const replaced = await tx
      .update(proposals)
      .set({ status: "replaced", closedAt: fields.createdAt })
      .where(
        and(
          eq(proposals.status, "open"),
          eq(proposals.kind, "Budget change"),
          notExists(
            tx
              .select({ id: proposalBudgets.proposalId })
              .from(proposalBudgets)
              .where(eq(proposalBudgets.proposalId, proposals.id)),
          ),
        ),
      )
      .returning({ id: proposals.id });
    await recordClosedRedrafts(
      tx,
      replaced.map((row) => row.id),
    );
    return { id, replaced: replaced.map((row) => row.id) };
  });
}

// The open Proposals created at `before` or earlier, which are due to expire. A read: reading the
// AI box takes no write lock when none is due.
export async function listDueProposals(database: Database, before: Date): Promise<string[]> {
  const rows = await database
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.status, "open"), lte(proposals.createdAt, before)));
  return rows.map((row) => row.id);
}

// Closes these Proposals as "expired", each only while it is still open, in one write with the
// inputs of an expired redraft. Returns the IDs it closed.
export async function expireProposals(
  database: Database,
  ids: readonly string[],
  at: Date,
): Promise<string[]> {
  return database.transaction(async (tx) => {
    const closed: string[] = [];
    for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
      const rows = await tx
        .update(proposals)
        .set({ status: "expired", closedAt: at })
        .where(
          and(
            inArray(proposals.id, ids.slice(start, start + IDS_PER_QUERY)),
            eq(proposals.status, "open"),
          ),
        )
        .returning({ id: proposals.id });
      const expired = rows.map((row) => row.id);
      await recordClosedRedrafts(tx, expired);
      closed.push(...expired);
    }
    return closed;
  });
}

async function withBudgets(database: Queries, rows: StoredProposal[]): Promise<ProposalRow[]> {
  const ids = rows.filter((row) => row.kind === "Budget change").map((row) => row.id);
  const byProposal = new Map<string, ProposalBudgetRow[]>();
  for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
    const lines = await database
      .select({ line: proposalBudgets, replacedAmount: budgets.amount })
      .from(proposalBudgets)
      .leftJoin(budgets, eq(budgets.id, proposalBudgets.replacedBudgetId))
      .where(inArray(proposalBudgets.proposalId, ids.slice(start, start + IDS_PER_QUERY)))
      .orderBy(asc(sql`${proposalBudgets}.rowid`));
    for (const { line, replacedAmount } of lines) {
      const list = byProposal.get(line.proposalId) ?? [];
      list.push({ ...line, replacedAmount });
      byProposal.set(line.proposalId, list);
    }
  }
  return rows.map((row) => ({ ...row, budgets: byProposal.get(row.id) ?? [] }));
}

// The open Proposals, oldest first.
export async function listOpenProposals(database: Database): Promise<ProposalRow[]> {
  const rows = await database
    .select()
    .from(proposals)
    .where(eq(proposals.status, "open"))
    .orderBy(asc(proposals.createdAt), asc(sql`rowid`));
  return withBudgets(database, rows);
}

// The Proposals a Member accepted or skipped after `since`, or ever with no `since`, in the order
// they closed.
export async function listProposalsClosedSince(
  database: Database,
  since: Date | undefined,
): Promise<ProposalRow[]> {
  const rows = await database
    .select()
    .from(proposals)
    .where(
      and(
        inArray(proposals.status, ["accepted", "skipped"]),
        since === undefined ? undefined : gt(proposals.closedAt, since),
      ),
    )
    .orderBy(asc(proposals.closedAt), asc(sql`rowid`));
  return withBudgets(database, rows);
}

export async function readProposal(
  database: Queries,
  id: string,
): Promise<ProposalRow | undefined> {
  const [row] = await database.select().from(proposals).where(eq(proposals.id, id));
  if (row === undefined) return undefined;
  const [found] = await withBudgets(database, [row]);
  return found;
}

// Marks an open Proposal of this kind accepted by `memberId` at `at`. False, with nothing changed,
// when no open Proposal of this kind has the ID.
async function claim(
  database: Queries,
  id: string,
  kind: ProposalKind,
  memberId: string,
  at: Date,
): Promise<boolean> {
  const rows = await database
    .update(proposals)
    .set({ status: "accepted", closedAt: at, closedBy: memberId })
    .where(and(eq(proposals.id, id), eq(proposals.kind, kind), eq(proposals.status, "open")))
    .returning({ id: proposals.id });
  return rows.length === 1;
}

// The month or year a Budget written in `month` takes effect: a yearly Budget the whole year.
const takesEffectIn = (period: StoredBudget["period"], month: string) =>
  period === "yearly" ? month.slice(0, 4) : month;

// Accepts an open Budget change in one write (spec 05, What accepting a Proposal changes): each of
// its Categories gets a new Budget in `month`, with the source "Proposal", set by the Member. A
// yearly Budget takes effect for the whole year. A Category with no Budget gets one of the period
// `periods` gives it. `amounts` holds each Category's amount, which a Member's Edit may change.
// False, with nothing changed, when no open Budget change has the ID.
export async function storeBudgetChangeAccept(
  database: Database,
  accept: {
    id: string;
    month: string;
    amounts: ReadonlyMap<string, number>;
    periods: ReadonlyMap<string, StoredBudget["period"]>;
    memberId: string;
    at: Date;
  },
): Promise<boolean> {
  const { id, month, memberId, at } = accept;
  return database.transaction(async (tx) => {
    if (!(await claim(tx, id, "Budget change", memberId, at))) return false;
    // Accepting a redraft also records its inputs (spec 05, What accepting a Proposal changes).
    await recordClosedRedrafts(tx, [id]);
    const lines = await tx.select().from(proposalBudgets).where(eq(proposalBudgets.proposalId, id));
    const inEffect = new Map(
      (await listBudgetsInEffect(tx, month)).map((row) => [row.category, row]),
    );
    for (const line of lines) {
      const current = inEffect.get(line.category);
      const period = current?.period ?? accept.periods.get(line.category) ?? "monthly";
      const [applied] = await tx
        .insert(budgets)
        .values({
          category: line.category,
          amount: accept.amounts.get(line.category) ?? line.amount,
          period,
          takesEffect: takesEffectIn(period, month),
          source: "Proposal",
          setBy: memberId,
          pinned: null,
          setAt: at,
        })
        .returning({ id: budgets.id });
      await tx
        .update(proposalBudgets)
        .set({ appliedBudgetId: applied?.id ?? null, replacedBudgetId: current?.id ?? null })
        .where(
          and(eq(proposalBudgets.proposalId, id), eq(proposalBudgets.category, line.category)),
        );
    }
    return true;
  });
}

// Accepts an open new Goal in one write: an active Goal is created, with the accepting Member as
// its author. Returns the Goal's ID, or undefined, with nothing changed, when no open new Goal has
// the ID.
export async function storeNewGoalAccept(
  database: Database,
  accept: { id: string; goal: NewGoal; at: Date },
): Promise<string | undefined> {
  const { id, goal, at } = accept;
  if (goal.authorId === null) return undefined;
  const authorId = goal.authorId;
  return database.transaction(async (tx) => {
    if (!(await claim(tx, id, "new Goal", authorId, at))) return undefined;
    const goalId = crypto.randomUUID();
    await tx.insert(goals).values({ id: goalId, ...goal, status: "active" });
    const applied: AppliedGoalChange = { words: goal.words };
    await tx.update(proposals).set({ goalId, applied }).where(eq(proposals.id, id));
    return goalId;
  });
}

// Marks an open Goal amount accepted. False when no open Goal amount has the ID. Accept runs it in
// one transaction with the Goal amount's start and storeGoalAmountApplied.
export function claimGoalAmount(
  database: Queries,
  accept: { id: string; memberId: string; at: Date },
): Promise<boolean> {
  return claim(database, accept.id, "Goal amount", accept.memberId, accept.at);
}

// Records what accepting a Goal amount set.
export async function storeGoalAmountApplied(
  database: Queries,
  id: string,
  applied: AppliedGoalChange,
): Promise<void> {
  await database.update(proposals).set({ applied }).where(eq(proposals.id, id));
}

// Skips an open Proposal: it closes, with the Member and the time. A skipped redraft still records
// its inputs, in the same write. False, with nothing changed, when no open Proposal has the ID.
export async function storeProposalSkip(
  database: Database,
  skip: { id: string; memberId: string; at: Date },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .update(proposals)
      .set({ status: "skipped", closedAt: skip.at, closedBy: skip.memberId })
      .where(and(eq(proposals.id, skip.id), eq(proposals.status, "open")))
      .returning({ id: proposals.id });
    await recordClosedRedrafts(
      tx,
      rows.map((row) => row.id),
    );
    return rows.length === 1;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function appliedOf(row: StoredProposal): AppliedGoalChange | undefined {
  const { applied } = row;
  if (!isRecord(applied)) return undefined;
  if (typeof applied.words === "string") return { words: applied.words };
  const { goalAmount, startsOn, before } = applied;
  if (typeof goalAmount !== "number" || typeof startsOn !== "string" || !isRecord(before)) {
    return undefined;
  }
  return { goalAmount, startsOn, before: before as GoalStart };
}

// What Undo reads: the Budgets in effect this month, the Goals, and the accepted Goal Proposals
// that Undo has not undone.
type UndoFacts = {
  inEffect: Map<string, StoredBudget>;
  goals: Map<string, StoredGoal>;
  acceptedGoalChanges: StoredProposal[];
};

async function undoFacts(database: Queries, month: string): Promise<UndoFacts> {
  const inEffect = new Map(
    (await listBudgetsInEffect(database, month)).map((row) => [row.category, row]),
  );
  const accepted = await database
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.status, "accepted"),
        isNull(proposals.undoneAt),
        isNotNull(proposals.goalId),
      ),
    );
  const goalIds = [
    ...new Set(accepted.flatMap((row) => (row.goalId === null ? [] : [row.goalId]))),
  ];
  const found = new Map<string, StoredGoal>();
  for (let start = 0; start < goalIds.length; start += IDS_PER_QUERY) {
    const rows = await database
      .select()
      .from(goals)
      .where(inArray(goals.id, goalIds.slice(start, start + IDS_PER_QUERY)));
    for (const row of rows) found.set(row.id, row);
  }
  return { inEffect, goals: found, acceptedGoalChanges: accepted };
}

// True while Undo is offered (spec 08, Lifecycle): the Proposal is accepted and not undone, and no
// later change touched the same Budget or Goal. A Budget change's Budgets must each still be the
// one in effect. A Goal must still be active, with what the Proposal set, and no Goal Proposal
// accepted after it.
function undoOffered(row: ProposalRow, facts: UndoFacts): boolean {
  if (row.status !== "accepted" || row.undoneAt !== null) return false;
  if (row.kind === "Budget change") {
    return (
      row.budgets.length > 0 &&
      row.budgets.every(
        (line) =>
          line.appliedBudgetId !== null &&
          facts.inEffect.get(line.category)?.id === line.appliedBudgetId,
      )
    );
  }
  const applied = appliedOf(row);
  const goal = row.goalId === null ? undefined : facts.goals.get(row.goalId);
  if (applied === undefined || goal === undefined || goal.status !== "active") return false;
  const laterOnGoal = facts.acceptedGoalChanges.some(
    (other) =>
      other.id !== row.id &&
      other.goalId === row.goalId &&
      other.closedAt !== null &&
      row.closedAt !== null &&
      other.closedAt > row.closedAt,
  );
  if (laterOnGoal) return false;
  if ("words" in applied) return goal.words === applied.words;
  return goal.goalAmount === applied.goalAmount && goal.startsOn === applied.startsOn;
}

// The accepted Proposals whose Undo is still offered in `month`, newest first.
export async function listUndoableProposals(
  database: Database,
  month: string,
): Promise<ProposalRow[]> {
  const facts = await undoFacts(database, month);
  const rows = await database
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, "accepted"), isNull(proposals.undoneAt)))
    .orderBy(sql`${proposals.closedAt} DESC`, sql`rowid DESC`);
  return (await withBudgets(database, rows)).filter((row) => undoOffered(row, facts));
}

// Undoes an accepted Proposal in one write, while Undo is offered (spec 08, Lifecycle):
// - A Budget change puts back each Budget it replaced. A Budget it wrote this month, or this year
//   for a yearly Budget, is removed, so the one before is in effect again. Past months keep their
//   Budgets (spec 05, Stored Budgets): from `month`, a Budget it wrote earlier gives way to a copy
//   of the one it replaced. For a Category that had none, either one gives way to a row that ends
//   its Budget, so the Category stays without one until a Member sets one. The Member who undid it
//   set the copy or the row, as a Member edit.
// - A Goal amount puts back what the Goal held before.
// - A new Goal is marked dropped on `today`, by the Member.
// Returns "undone", "not found", "already undone", or "not offered", with nothing changed.
export async function storeProposalUndo(
  database: Database,
  undo: { id: string; month: string; today: string; memberId: string; at: Date },
): Promise<"undone" | "not found" | "already undone" | "not offered"> {
  const { id, month, today, memberId, at } = undo;
  return database.transaction(async (tx) => {
    const row = await readProposal(tx, id);
    if (row === undefined) return "not found";
    if (row.status === "accepted" && row.undoneAt !== null) return "already undone";
    const facts = await undoFacts(tx, month);
    if (!undoOffered(row, facts)) return "not offered";
    if (row.kind === "Budget change") {
      const byMember = { source: "Member edit" as const, setBy: memberId, setAt: at };
      for (const line of row.budgets) {
        const applied = facts.inEffect.get(line.category);
        if (applied === undefined) continue;
        const from = takesEffectIn(applied.period, month);
        if (applied.takesEffect === from) {
          await tx.delete(budgets).where(eq(budgets.id, applied.id));
          // A first Budget still gives way to a row that ends the Category's Budget, so no later
          // 1st gives it a first Budget again (spec 05, When the app drafts: an undone first
          // Budget).
          if (line.replacedBudgetId !== null) continue;
        }
        const replaced =
          line.replacedBudgetId === null
            ? undefined
            : (await tx.select().from(budgets).where(eq(budgets.id, line.replacedBudgetId)))[0];
        if (replaced === undefined) {
          await tx.insert(budgets).values({
            category: line.category,
            amount: 0,
            period: applied.period,
            takesEffect: from,
            pinned: null,
            noBudget: true,
            ...byMember,
          });
          continue;
        }
        const { id: _, ...before } = replaced;
        await tx.insert(budgets).values({
          ...before,
          takesEffect: takesEffectIn(before.period, month),
          ...byMember,
        });
      }
    } else {
      const applied = appliedOf(row);
      if (applied === undefined || row.goalId === null) return "not offered";
      const goal = and(eq(goals.id, row.goalId), eq(goals.status, "active"));
      if ("words" in applied) {
        await tx
          .update(goals)
          .set({ status: "dropped", endedOn: today, endedBy: memberId })
          .where(goal);
      } else {
        await tx.update(goals).set(applied.before).where(goal);
      }
    }
    await tx
      .update(proposals)
      .set({ undoneAt: at, undoneBy: memberId })
      .where(and(eq(proposals.id, id), isNull(proposals.undoneAt)));
    return "undone";
  });
}

// The Proposals of the Chat runs whose IDs start with `prefix`, such as a thread's ID and "/",
// oldest first, whatever their status. It reads the range of IDs, so the run index serves it.
export async function listChatProposals(
  database: Database,
  prefix: string,
): Promise<ProposalRow[]> {
  if (prefix === "") throw new RangeError("A Chat run prefix is never empty.");
  const last = prefix.at(-1) ?? "";
  const after = prefix.slice(0, -1) + String.fromCodePoint((last.codePointAt(0) ?? 0) + 1);
  const rows = await database
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.source, "Chat"), gte(proposals.runId, prefix), lt(proposals.runId, after)),
    )
    .orderBy(asc(proposals.createdAt), asc(sql`rowid`));
  return withBudgets(database, rows);
}
