import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  min,
  ne,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  budgetInputs,
  budgetTailoringRuns,
  goals,
  proposals,
  redraftProposals,
  transactions,
} from "./schema.ts";

// Budget tailoring runs in app.db (spec 05, Which Proposals exist). The tailoring module decides
// when a run is due and what it makes; these functions store and read.

export type StoredTailoringRun = typeof budgetTailoringRuns.$inferSelect;

export type TailoringRunRequest =
  | { kind: "Tailoring" }
  | { kind: "Goal"; goalId: string }
  | { kind: "Redraft" };

// The inputs a redraft drafts at: I, in whole cents per month, and the shipped CE data year.
export type RedraftInputs = Omit<typeof redraftProposals.$inferSelect, "proposalId">;

// Stores a run that waits for its AI call. The Tailoring run is stored once ever: never again once
// one waits or ended. A Goal run is stored once per waiting Goal, and only for a Goal app.db has. A
// redraft is stored once while one waits, so triggers close together make one run. True when this
// call stored it.
export async function requestTailoringRun(
  database: Database,
  run: TailoringRunRequest,
  at: Date,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const goalId = run.kind === "Goal" ? run.goalId : null;
    if (goalId !== null) {
      const [goal] = await tx.select({ id: goals.id }).from(goals).where(eq(goals.id, goalId));
      if (goal === undefined) return false;
    }
    const [found] = await tx
      .select({ id: budgetTailoringRuns.id, requestedAt: budgetTailoringRuns.requestedAt })
      .from(budgetTailoringRuns)
      .where(
        goalId === null
          ? eq(budgetTailoringRuns.kind, run.kind)
          : and(
              eq(budgetTailoringRuns.kind, "Goal"),
              eq(budgetTailoringRuns.goalId, goalId),
              isNull(budgetTailoringRuns.endedAt),
            ),
      );
    if (found !== undefined) {
      // A redraft asked for again: its stamp moves later, so a run whose AI call is under way
      // runs once more (endRedraftRun).
      if (run.kind === "Redraft") {
        const later = Math.max(at.getTime(), found.requestedAt.getTime() + 1);
        await tx
          .update(budgetTailoringRuns)
          .set({ requestedAt: new Date(later) })
          .where(eq(budgetTailoringRuns.id, found.id));
      }
      return false;
    }
    // The unique indexes hold the Tailoring run, and the waiting redraft, to one row each.
    const stored = await tx
      .insert(budgetTailoringRuns)
      .values({ kind: run.kind, goalId, requestedAt: at })
      .onConflictDoNothing()
      .returning({ id: budgetTailoringRuns.id });
    return stored.length > 0;
  });
}

// The run ID a Goal run's Proposals carry: the run, then its Goal. The run row is deleted when it
// ends, so new words find the Proposals made for the old ones by this ID.
export const goalRunProposalsId = (runId: number, goalId: string) =>
  `Goal run ${runId} of Goal ${goalId}`;

// Whether a Proposal's run ID is a Goal run's for this Goal, in SQL.
export const isGoalRunOf = (runId: SQLWrapper, goalId: string) => {
  const suffix = ` of Goal ${goalId}`;
  return sql`(${runId} LIKE 'Goal run %' AND substr(${runId}, ${-suffix.length}) = ${suffix})`;
};

// The runs that wait for their AI call, oldest first.
export function listWaitingTailoringRuns(database: Database): Promise<StoredTailoringRun[]> {
  return database
    .select()
    .from(budgetTailoringRuns)
    .where(isNull(budgetTailoringRuns.endedAt))
    .orderBy(asc(budgetTailoringRuns.id));
}

// The run's AI call answered: a Goal run or a redraft is deleted, and the Tailoring run is kept as
// ended, so it never runs again.
export async function endTailoringRun(database: Database, id: number, at: Date): Promise<void> {
  await database
    .delete(budgetTailoringRuns)
    .where(and(eq(budgetTailoringRuns.id, id), ne(budgetTailoringRuns.kind, "Tailoring")));
  await database
    .update(budgetTailoringRuns)
    .set({ endedAt: at })
    .where(and(eq(budgetTailoringRuns.id, id), eq(budgetTailoringRuns.kind, "Tailoring")));
}

// A redraft ended. It is deleted unless a trigger asked for it again after `readAt`, the stamp
// the run read before it read its figures: then it stays waiting, to run once more. True when it
// stays.
export async function endRedraftRun(
  database: Database,
  id: number,
  readAt: Date,
): Promise<boolean> {
  const deleted = await database
    .delete(budgetTailoringRuns)
    .where(
      and(
        eq(budgetTailoringRuns.id, id),
        eq(budgetTailoringRuns.kind, "Redraft"),
        lte(budgetTailoringRuns.requestedAt, readAt),
      ),
    )
    .returning({ id: budgetTailoringRuns.id });
  if (deleted.length > 0) return false;
  const [kept] = await database
    .select({ id: budgetTailoringRuns.id })
    .from(budgetTailoringRuns)
    .where(eq(budgetTailoringRuns.id, id));
  return kept !== undefined;
}

// The run took its no-AI path: it is deleted, so a later AI provider can ask for a Tailoring run
// again.
export async function dropTailoringRun(database: Database, id: number): Promise<void> {
  await database.delete(budgetTailoringRuns).where(eq(budgetTailoringRuns.id, id));
}

// One more run of this one that threw. Returns its count of failed tries.
export async function countTailoringRunFailure(database: Database, id: number): Promise<number> {
  const [row] = await database
    .update(budgetTailoringRuns)
    .set({ failedTries: sql`${budgetTailoringRuns.failedTries} + 1` })
    .where(eq(budgetTailoringRuns.id, id))
    .returning({ failedTries: budgetTailoringRuns.failedTries });
  return row?.failedTries ?? 0;
}

// The ID of the one row of budget_inputs.
const BUDGET_INPUTS_ROW = 1;

const inputsOf = ({
  steadyIncome,
  ceDataYear,
  sampleBenchmarks,
}: RedraftInputs): RedraftInputs => ({
  steadyIncome,
  ceDataYear,
  sampleBenchmarks,
});

// Records a handled redraft's inputs as the ones behind the current Budgets (spec 05, What
// accepting a Proposal changes), unless a newer redraft's are recorded. `draftedAt` is when the
// redraft drafted. False when nothing changed: no first draft, or newer inputs.
export async function recordRedraftInputs(
  database: Queries,
  inputs: RedraftInputs,
  draftedAt: Date,
): Promise<boolean> {
  const rows = await database
    .update(budgetInputs)
    .set({ ...inputsOf(inputs), redraftedAt: draftedAt })
    .where(
      and(
        eq(budgetInputs.id, BUDGET_INPUTS_ROW),
        or(isNull(budgetInputs.redraftedAt), lt(budgetInputs.redraftedAt, draftedAt)),
      ),
    )
    .returning({ id: budgetInputs.id });
  return rows.length > 0;
}

// Records the inputs of the newest redraft among these Proposals, which just closed: accepted,
// skipped, replaced or expired. Each write that closes a Proposal calls it in the same transaction,
// with the IDs it closed.
export async function recordClosedRedrafts(
  database: Queries,
  proposalIds: readonly string[],
): Promise<void> {
  if (proposalIds.length === 0) return;
  const [newest] = await database
    .select({ inputs: redraftProposals, draftedAt: proposals.createdAt })
    .from(redraftProposals)
    .innerJoin(proposals, eq(proposals.id, redraftProposals.proposalId))
    .where(inArray(redraftProposals.proposalId, proposalIds))
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  if (newest !== undefined) await recordRedraftInputs(database, newest.inputs, newest.draftedAt);
}

// What the redraft triggers compare against, or undefined before the first draft: the inputs of the
// newest open redraft Proposal when it is newer than the recorded ones, else the recorded inputs.
// An open redraft already covers its inputs, so they start no second one.
export type RedraftBase = {
  pending: RedraftInputs;
  benchmarkRedraftAt: Date | null;
  redraftWaits: boolean;
};

export async function readRedraftBase(database: Database): Promise<RedraftBase | undefined> {
  const [recorded] = await database
    .select()
    .from(budgetInputs)
    .where(eq(budgetInputs.id, BUDGET_INPUTS_ROW));
  if (recorded === undefined) return undefined;
  const [open] = await database
    .select({ inputs: redraftProposals, draftedAt: proposals.createdAt })
    .from(redraftProposals)
    .innerJoin(proposals, eq(proposals.id, redraftProposals.proposalId))
    .where(eq(proposals.status, "open"))
    .orderBy(desc(proposals.createdAt))
    .limit(1);
  const [waiting] = await database
    .select({ id: budgetTailoringRuns.id })
    .from(budgetTailoringRuns)
    .where(eq(budgetTailoringRuns.kind, "Redraft"));
  const openIsNewer =
    open !== undefined && (recorded.redraftedAt === null || open.draftedAt > recorded.redraftedAt);
  return {
    pending: inputsOf(openIsNewer ? open.inputs : recorded),
    benchmarkRedraftAt: recorded.benchmarkRedraftAt,
    redraftWaits: waiting !== undefined,
  };
}

// A Benchmark redraft started at `at`.
export async function markBenchmarkRedraft(database: Database, at: Date): Promise<void> {
  await database
    .update(budgetInputs)
    .set({ benchmarkRedraftAt: at })
    .where(eq(budgetInputs.id, BUDGET_INPUTS_ROW));
}

// The history start (src/db/budgets.ts, readHistoryStart) as it was without a Connection's
// Transactions: the earliest posted date of every other shown, posted Transaction.
export async function readHistoryStartWithout(
  database: Database,
  connectionId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ first: min(transactions.postedDate) })
    .from(transactions)
    .where(
      and(
        isNull(transactions.hiddenReason),
        eq(transactions.pending, false),
        or(isNull(transactions.connectionId), ne(transactions.connectionId, connectionId)),
      ),
    );
  return row?.first ?? undefined;
}

// The IDs of every Transaction a Connection brought, for a bank added later.
export async function listConnectionTransactionIds(
  database: Database,
  connectionId: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.connectionId, connectionId));
  return rows.map((row) => row.id);
}
