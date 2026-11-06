import type { HouseholdAi } from "../ai/index.ts";
import { registerBankAddedLaterHook } from "../bank/index.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { historyWindow } from "../budgets/index.ts";
import {
  type Database,
  listConnectionTransactionIds,
  listPostedParts,
  markBenchmarkRedraft,
  readHistoryStart,
  readHistoryStartWithout,
  readRedraftBase,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone, onHouseholdFactsEdited } from "../household/index.ts";
import { log } from "../log.ts";
import { monthOf } from "../money-movement/index.ts";
import { steadyIncome } from "../recurring/index.ts";
import { requestRedraft } from "./runs.ts";

// Redraft triggers (spec 05, Which Proposals exist). Each one asks for one redraft, a Budget
// tailoring run (src/tailoring/runs.ts), only from the event that makes it due:
// - Income redraft: the follow-up job after a sync, or a Member typing Steady Income, finds that I
//   differs by more than 10% from the I behind the current Budgets.
// - Benchmark redraft: the app starts with a release whose CE data year is newer than the one
//   behind the current Budgets. At most one a year.
// - New bank redraft: a bank added later loads its history (spec 02, A bank added later), and any
//   Category's 12-month average moves more than 10% with it.
// - Facts redraft: a Member edits the Household facts.
// A trigger compares against the inputs of a redraft Proposal still open, when it is newer than
// the recorded ones: that redraft covers them. A redraft already waiting takes any trigger, and a
// Facts or New bank trigger during its run makes it run once more, since that run read its figures
// before the change. Before the first draft, and with no AI provider, no trigger asks for one:
// redrafts need an AI provider.

export type RedraftTrigger = "Income" | "Benchmark" | "New bank" | "Facts";

// An Income or 12-month average move above this share, in percent, is due.
const MOVE_PERCENT = 10;
// There is at most one Benchmark redraft in this time.
const BENCHMARK_REDRAFT_MS = 365 * 24 * 60 * 60 * 1000;

// The parts that count as Spending: Spending, and the Refunds and Reimbursements that reduce it.
const SPENDING_TYPES = new Set(["Spending", "Refund", "Reimbursement"]);

type Services = { database: Database; ai: HouseholdAi; now: () => Date };

let services: Services | undefined;

function running(): Services {
  if (services === undefined) throw new Error("Redrafts are not running.");
  return services;
}

// True when `to` differs from `from` by more than 10% of `from`.
const movedFrom = (from: number, to: number) =>
  Math.abs(to - from) * 100 > Math.abs(from) * MOVE_PERCENT;

// True after "no AI provider" was logged, until a redraft is asked for again: an Income move with
// no AI provider is found on every sync, and is logged once.
let noProviderLogged = false;

// Asks for a redraft when an AI provider is set up. "asked" when this trigger stored it, "waits"
// when one already waits, and undefined with no AI provider.
async function ask(trigger: RedraftTrigger): Promise<"asked" | "waits" | undefined> {
  if ((await running().ai.pauseFor("budget tailoring")) === "no AI provider") {
    if (!noProviderLogged) log.info("A redraft is due, but there is no AI provider", { trigger });
    noProviderLogged = true;
    return undefined;
  }
  noProviderLogged = false;
  return (await requestRedraft(trigger)) ? "asked" : "waits";
}

// The Income redraft check. True when it asked for a redraft.
export async function checkIncomeRedraft(): Promise<boolean> {
  const { database, now } = running();
  const base = await readRedraftBase(database);
  if (base === undefined || base.redraftWaits) return false;
  const income = (await steadyIncome(database, now())).amount;
  if (!movedFrom(base.pending.steadyIncome, income)) return false;
  return (await ask("Income")) === "asked";
}

// The Benchmark redraft check, as the app starts. True when it asked for a redraft.
export async function checkBenchmarkRedraft(): Promise<boolean> {
  const { database, now } = running();
  const base = await readRedraftBase(database);
  if (base === undefined) return false;
  if (benchmarkSnapshot().ce.dataYear <= base.pending.ceDataYear) return false;
  const at = now();
  const last = base.benchmarkRedraftAt;
  if (last !== null && at.getTime() - last.getTime() < BENCHMARK_REDRAFT_MS) return false;
  const asked = await ask("Benchmark");
  // A redraft already waiting drafts with the new Benchmarks, so it counts as this year's.
  if (asked !== undefined) await markBenchmarkRedraft(database, at);
  return asked === "asked";
}

// True when any Category's 12-month average moves more than 10% with the Connection's
// Transactions (spec 05, Formula terms): Spending ÷ n over the history window for this month. Each
// side has its own window, since the bank can move the history start earlier, and so n.
async function averagesMoved(
  database: Database,
  connectionId: string,
  now: Date,
): Promise<boolean> {
  const month = calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC").slice(0, 7);
  const allWindow = new Set(historyWindow(month, await readHistoryStart(database)));
  const withoutWindow = new Set(
    historyWindow(month, await readHistoryStartWithout(database, connectionId)),
  );
  const fromBank = new Set(await listConnectionTransactionIds(database, connectionId));
  const without = new Map<string, number>();
  const all = new Map<string, number>();
  for (const part of await listPostedParts(database)) {
    if (!SPENDING_TYPES.has(part.type) || part.category === null) continue;
    const partMonth = monthOf(part);
    const spent = -part.amount;
    if (allWindow.has(partMonth)) all.set(part.category, (all.get(part.category) ?? 0) + spent);
    if (withoutWindow.has(partMonth) && !fromBank.has(part.transactionId)) {
      without.set(part.category, (without.get(part.category) ?? 0) + spent);
    }
  }
  const average = (sum: number | undefined, n: number) => (n === 0 ? 0 : (sum ?? 0) / n);
  return [...new Set([...all.keys(), ...without.keys()])].some((category) =>
    movedFrom(
      average(without.get(category), withoutWindow.size),
      average(all.get(category), allWindow.size),
    ),
  );
}

// The New bank redraft check, as a bank added later finishes its history load. True when it
// asked for a redraft. A redraft that waits, or runs, takes it: the hook runs once per bank.
export async function checkNewBankRedraft(connectionId: string): Promise<boolean> {
  const { database, now } = running();
  const base = await readRedraftBase(database);
  if (base === undefined) return false;
  if (!(await averagesMoved(database, connectionId, now()))) return false;
  return (await ask("New bank")) === "asked";
}

// The Facts redraft: every edit of the Household facts asks for one, once the first draft is
// stored. True when it asked for a redraft. A redraft that waits, or runs, takes it: no later check
// would find the edit.
export async function factsRedraft(): Promise<boolean> {
  const { database } = running();
  const base = await readRedraftBase(database);
  if (base === undefined) return false;
  return (await ask("Facts")) === "asked";
}

// A Member typed or cleared Steady Income: the Income redraft check runs. It never fails the
// Member's save; with redrafts not running, it does nothing.
export async function afterSteadyIncomeTyped(): Promise<void> {
  if (services === undefined) return;
  try {
    await checkIncomeRedraft();
  } catch (error) {
    log.error("The Income redraft check failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Gives the redraft triggers app.db and the Household AI, and hooks them to their events. Budget
// tailoring must be running too: it runs each redraft. The start calls it before jobs run, and
// calls `atStart` once jobs run.
export function startRedrafts(options: { database: Database; ai: HouseholdAi; now?: () => Date }): {
  atStart(): Promise<void>;
  stop(): void;
} {
  if (services !== undefined) throw new Error("Redrafts are already running.");
  const started: Services = {
    database: options.database,
    ai: options.ai,
    now: options.now ?? (() => new Date()),
  };
  services = started;
  noProviderLogged = false;
  const stops = [
    registerFollowUpStep("redraft check", async () => {
      await checkIncomeRedraft();
      return undefined;
    }),
    registerBankAddedLaterHook(async (connectionId) => {
      await checkNewBankRedraft(connectionId);
    }),
    onHouseholdFactsEdited(async () => {
      await factsRedraft();
    }),
  ];
  return {
    async atStart() {
      try {
        await checkBenchmarkRedraft();
      } catch (error) {
        log.error("The Benchmark redraft check failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
    stop() {
      for (const stop of stops.reverse()) stop();
      if (services === started) services = undefined;
    },
  };
}
