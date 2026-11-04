import {
  addAiCall,
  claimCapNotice,
  type Database,
  listMonthAiCalls,
  readCostCap,
  readMonthCost,
  readMonthCostByUse,
  storeCostCap,
} from "../db/index.ts";
import { calendarDateIn, dateLabel } from "../format.ts";
import { type Logger, log } from "../log.ts";
import { type NewNotice, raiseNotice } from "../notify/index.ts";
import {
  type AiProviderName,
  type AiUsageView,
  type AiUse,
  DEFAULT_COST_CAP_CENTS,
  MAX_COST_CAP_CENTS,
} from "./ai-view.ts";
import type { CallTokens } from "./prices.ts";
import { atCap, capLine, firstOfNextMonth, monthOf, nearCap } from "./usage-view.ts";

// The month's AI cost and the AI cost cap (spec 08, Counting cost and The AI cost cap). A month is
// a calendar month in the Household time zone. The cap is per Household, so switching AI provider
// keeps the month's total.

// One counted call: metadata only, never prompt text or reply text.
export type CountedCall = CallTokens & {
  use: AiUse;
  provider: AiProviderName;
  model: string;
  costNanos: number;
};

export type AiCost = {
  // The date background AI starts again, YYYY-MM-DD, while the month's total is at the cap.
  pausedUntil(): Promise<string | undefined>;
  // Stores the call, then sends the 80% and 100% System notices, each once a month. A notice that
  // fails is logged, and the call's own result stands.
  record(call: CountedCall): Promise<void>;
  // A cap above the month's total starts background AI again at once.
  setCap(capCents: number): Promise<void>;
  usage(): Promise<AiUsageView>;
};

// The calls the AI usage page lists: this month's, newest first.
const LISTED_CALLS = 500;

export function aiCost(options: {
  database: Database;
  // The Household time zone, or undefined until the wizard's step 4. UTC until then.
  timeZone?: () => Promise<string | undefined>;
  raiseNotice?: (notice: NewNotice) => Promise<unknown>;
  logger?: Logger;
}): AiCost {
  const { database, logger = log } = options;
  const timeZone = options.timeZone ?? (async () => undefined);
  const raise = options.raiseNotice ?? raiseNotice;

  async function today(): Promise<string> {
    return calendarDateIn(new Date(), (await timeZone()) ?? "UTC");
  }

  async function month() {
    const date = await today();
    const current = monthOf(date);
    const [totalNanos, capCents] = await Promise.all([
      readMonthCost(database, current),
      readCostCap(database),
    ]);
    return { date, month: current, totalNanos, capCents: capCents ?? DEFAULT_COST_CAP_CENTS };
  }

  // A call that jumps past both marks sends only the 100% notice.
  async function sendNotices(): Promise<void> {
    const now = await month();
    if (!nearCap(now.totalNanos, now.capCents)) return;
    const line = capLine(now.totalNanos, now.capCents);
    const warned = await claimCapNotice(database, "80%", now.month);
    if (atCap(now.totalNanos, now.capCents)) {
      if (await claimCapNotice(database, "100%", now.month)) {
        const until = dateLabel(firstOfNextMonth(now.month), now.date);
        await raise({
          kind: "event",
          text: `AI cost cap reached: ${line} this month. Background AI is paused until ${until}. Chat and Goals ask before each call.`,
        });
      }
      return;
    }
    if (warned) {
      await raise({
        kind: "event",
        text: `AI cost this month is ${line}, 80% of the AI cost cap. At the cap, background AI pauses until the 1st.`,
      });
    }
  }

  // A failed notice never fails the AI call or the cap's save that led to it.
  async function trySendNotices(): Promise<void> {
    try {
      await sendNotices();
    } catch (error) {
      logger.warn("An AI cost cap System notice could not be raised", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    async pausedUntil() {
      const now = await month();
      return atCap(now.totalNanos, now.capCents) ? firstOfNextMonth(now.month) : undefined;
    },

    async record(call) {
      await addAiCall(database, {
        ...call,
        at: new Date(),
        month: monthOf(await today()),
      });
      await trySendNotices();
    },

    async setCap(capCents) {
      if (!Number.isSafeInteger(capCents) || capCents < 0 || capCents > MAX_COST_CAP_CENTS) {
        throw new RangeError("The AI cost cap must be whole cents from $0 to $10,000.");
      }
      await storeCostCap(database, capCents);
      await trySendNotices();
    },

    async usage() {
      const now = await month();
      const [byUse, calls] = await Promise.all([
        readMonthCostByUse(database, now.month),
        listMonthAiCalls(database, now.month, LISTED_CALLS),
      ]);
      return {
        month: now.month,
        totalNanos: now.totalNanos,
        capCents: now.capCents,
        pausedUntil: atCap(now.totalNanos, now.capCents) ? firstOfNextMonth(now.month) : null,
        byUse,
        calls: calls.map(({ month: _month, provider: _provider, at, ...call }) => ({
          ...call,
          at: at.toISOString(),
        })),
      };
    },
  };
}
