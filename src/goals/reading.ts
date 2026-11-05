import * as z from "zod";
import {
  type AiFailure,
  type AiPause,
  type AiReply,
  type HouseholdAi,
  PrivacyRefusal,
  type SummaryPart,
  typedDate,
} from "../ai/index.ts";
import { CATEGORIES, type Category } from "../categories/index.ts";
import {
  addGoal,
  type Database,
  dropHouseholdSummary,
  listAccounts,
  readGoal,
  storeGoalWords,
} from "../db/index.ts";
import { log } from "../log.ts";
import { type GoalReading, householdDay, startGoal } from "./goals.ts";

// Adding a Goal and editing its words (spec 05, Rules; spec 08, Every AI use, reading a Goal). A
// Member writes a Goal in plain words. One Quick-tier call per save reads them into a target, a
// change, and a deadline, each null when the words do not say. The app stores the reading, sets the
// Goal amount when the change gives it, and asks for the Goal's Budget tailoring run at once, which
// makes its Proposals. Goals need an AI provider: with none, nothing is stored. At the AI cost cap,
// the save asks "Send anyway?" first. A failed reading stores nothing and never retries by itself:
// the page shows the error with "Try again". The AI only reads the words it is sent: it cannot
// edit or delete a Goal.

// The longest Goal a Member may write.
export const GOAL_WORDS_LENGTH = 300;
// The most readings one Member may start in an hour, so a loop in a page cannot run up the AI bill
// before the AI cost cap stops it.
export const READINGS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

// The largest change the reply may hold, in dollars: under a whole-cents amount's safe range.
const MAX_DOLLARS = 1_000_000_000;
// The most Accounts and loans the call lists.
const MAX_ACCOUNTS = 200;

const CATEGORY_NAMES = CATEGORIES.map(({ name }) => name) as [Category, ...Category[]];

export const GOAL_READING_TASK = [
  "Task: read a Household Member's Goal. The last message is the Goal, in the Member's own words. Read it into three fields. Set a field to null when the words do not say it. Never guess.",
  "- `target`: what the Goal is about. Its `kind` is one of these:",
  "- `Category`: Spending of one kind. Give `category`, exactly one name from the Category list.",
  "- `Merchant`: Spending at one shop or company. Give `merchant`, its name as the words write it.",
  "- `Saving`: saving money, with no Account named.",
  "- `Accounts`: saving in Accounts the facts list. Give `accounts`, their row numbers.",
  "- `loan`: paying down one loan the facts list. Give `accounts`, its one row number.",
  "- Set each target field its kind does not use to null.",
  "- `change`: how much. Give `amount` in dollars, or `percent` from 1 to 100, and set the other to null.",
  "- `deadline`: the date the Goal should be met by, written YYYY-MM-DD. A month alone means its last day, and a year alone means December 31. A date with no year means its next one from today's date in the facts.",
  `Categories: ${CATEGORY_NAMES.join("; ")}.`,
].join("\n");

// One Account or loan the call lists, by its row number.
type ListedAccount = { id: string; label: string; loan: boolean };

const isRealDate = (date: string) => {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

// The reply. It holds no field the schema does not name. A target must name what its kind needs
// and nothing else, an Accounts or loan target must name rows the call listed, a change holds an
// amount or a percent from 1 to 100, and a deadline is a real date. Any other reply fails it, which
// is an AI error.
export function goalReadingReply(accounts: readonly Pick<ListedAccount, "loan">[]) {
  const row = z.number().int().min(1).max(Math.max(1, accounts.length));
  return z
    .object({
      target: z
        .object({
          kind: z.enum(["Category", "Merchant", "Saving", "Accounts", "loan"]),
          category: z.enum(CATEGORY_NAMES).nullable(),
          merchant: z.string().trim().min(1).max(100).nullable(),
          accounts: z.array(row).min(1).max(MAX_ACCOUNTS).nullable(),
        })
        .strict()
        .nullable(),
      change: z
        .object({
          amount: z.number().positive().max(MAX_DOLLARS).nullable(),
          percent: z.number().min(1).max(100).nullable(),
        })
        .strict()
        .nullable(),
      deadline: z
        .string()
        .regex(/^2\d{3}-\d{2}-\d{2}$/)
        .refine(isRealDate)
        .nullable(),
    })
    .strict()
    .superRefine((reply, context) => {
      const wrong = (message: string) => context.addIssue({ code: "custom", message });
      const { target, change } = reply;
      if (change !== null && (change.amount === null) === (change.percent === null)) {
        wrong("A change holds an amount or a percent.");
      }
      if (target === null) return;
      const uses = {
        category: target.kind === "Category",
        merchant: target.kind === "Merchant",
        accounts: target.kind === "Accounts" || target.kind === "loan",
      };
      for (const field of ["category", "merchant", "accounts"] as const) {
        if ((target[field] !== null) !== uses[field]) wrong(`The target's ${field} is wrong.`);
      }
      const rows = (target.accounts ?? []).map((each) => accounts[each - 1]);
      if (rows.some((each) => each === undefined)) wrong("A row is not listed.");
      if (target.kind === "loan" && (rows.length !== 1 || rows[0]?.loan !== true)) {
        wrong("A loan target names one loan.");
      }
      if (target.kind === "Accounts" && rows.some((each) => each?.loan !== false)) {
        wrong("An Accounts target names no loan.");
      }
    });
}

type ReadingReply = z.infer<ReturnType<typeof goalReadingReply>>;

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// A Goal's words as stored and sent: one well-formed line, with a space for each control character,
// so the privacy filter reads the characters the AI reads. Empty when the Member wrote nothing.
export const goalWords = (words: string) =>
  words.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

// Why a save stored nothing.
export type GoalSaveRefusal =
  | { refused: "empty" | "not found" | "not active" | "busy" | "rate cap" }
  // The words give a deadline before today, so nothing is stored: the Member writes a later one.
  | { refused: "past deadline" }
  | { refused: "paused"; pause: AiPause }
  | { refused: "failed"; failure: AiFailure | "privacy" };

export type GoalWriting = {
  // Why a reading would pause now, such as "no AI provider" or "waits for history", or undefined.
  // It makes no call.
  pause(): Promise<AiPause | undefined>;
  // A new active Goal by `memberId`, with the AI's reading of its words.
  add(
    memberId: string,
    input: { words: string; sendAnyway: boolean },
  ): Promise<{ goalId: string } | GoalSaveRefusal>;
  // New words for an active Goal, with the AI's reading of them. The same words make no call.
  edit(
    memberId: string,
    goalId: string,
    input: { words: string; sendAnyway: boolean },
  ): Promise<{ goalId: string } | GoalSaveRefusal>;
};

export type GoalWritingOptions = {
  database: Database;
  ai: Pick<HouseholdAi, "generate" | "pauseFor" | "accountLabels" | "forScreen">;
  // Budget tailoring's Goal run for the Goal (src/tailoring, requestGoalTailoring), which makes the
  // Goal's Proposals.
  requestGoalRun: (goalId: string) => Promise<unknown>;
  now?: () => Date;
};

export function goalWriting(options: GoalWritingOptions): GoalWriting {
  const { database, ai, requestGoalRun, now = () => new Date() } = options;
  // Each Member's readings in the last hour, and the Goals being read now. Both live in memory.
  const started = new Map<string, number[]>();
  const reading = new Set<string>();

  const recent = (memberId: string, at: number) =>
    (started.get(memberId) ?? []).filter((time) => time > at - HOUR_MS);

  // A place among the Member's readings this hour, taken in the same step as the check, before
  // any wait, so saves sent together cannot all pass the count. Undefined at the cap.
  function reserve(memberId: string): number | undefined {
    const at = now().getTime();
    const times = recent(memberId, at);
    if (times.length >= READINGS_PER_HOUR) return undefined;
    started.set(memberId, [...times, at]);
    return at;
  }

  // Gives the place back when no call went out.
  function release(memberId: string, at: number) {
    const times = started.get(memberId) ?? [];
    const index = times.indexOf(at);
    if (index >= 0) started.set(memberId, times.toSpliced(index, 1));
  }

  // The Accounts and loans the call lists, open ones only, each by its label, such as "Ally
  // checking": never its name, which may name a Member.
  async function listed(): Promise<ListedAccount[]> {
    const labels = await ai.accountLabels();
    return (await listAccounts(database))
      .filter((account) => account.closedAt === null)
      .slice(0, MAX_ACCOUNTS)
      .map((account) => ({
        id: account.id,
        label: labels.get(account.id) ?? "Account",
        loan: account.kind === "loan",
      }));
  }

  // The reading as the app stores it: the Category, the Merchant's name as the screen shows it,
  // or the Accounts by ID; the change in whole cents or a percent; and the deadline.
  async function readingOf(reply: ReadingReply, accounts: ListedAccount[]): Promise<GoalReading> {
    const { target, change, deadline } = reply;
    const ids = (target?.accounts ?? []).map((row) => accounts[row - 1]?.id ?? "");
    let shown: GoalReading["target"] = null;
    if (target?.kind === "Category" && target.category !== null) {
      shown = { kind: "Category", category: target.category };
    } else if (target?.kind === "Merchant" && target.merchant !== null) {
      shown = {
        kind: "Merchant",
        merchant: { id: null, name: await ai.forScreen(target.merchant) },
      };
    } else if (target?.kind === "Saving") {
      shown = { kind: "Saving" };
    } else if (target?.kind === "Accounts") {
      shown = { kind: "Accounts", accountIds: [...new Set(ids)] };
    } else if (target?.kind === "loan" && ids[0] !== undefined) {
      shown = { kind: "loan", accountId: ids[0] };
    }
    return {
      target: shown,
      change:
        change === null
          ? null
          : change.amount !== null
            ? { amount: Math.round(change.amount * 100) }
            : { percent: change.percent ?? 0 },
      deadline,
    };
  }

  // The one Quick-tier call: today's date and the Accounts and loans as app-built facts, with the
  // date as a typed value, then the Member's words as typed text.
  async function read(
    words: string,
    sendAnyway: boolean,
  ): Promise<{ reading: GoalReading } | GoalSaveRefusal> {
    const today = await householdDay(database, now());
    const accounts = await listed();
    const facts: SummaryPart[] = [
      "Today is ",
      typedDate(today),
      ".\nThe Household's Accounts and loans, by row number:",
      ...(accounts.length === 0
        ? ["\n- None."]
        : accounts.map(
            (account, index) => `\n${index + 1}. ${account.label}${account.loan ? " (loan)" : ""}`,
          )),
    ];
    let reply: AiReply<ReadingReply>;
    try {
      reply = await ai.generate(
        {
          use: "reading a goal",
          task: GOAL_READING_TASK,
          changes: [
            { role: "user", parts: facts },
            { role: "user", text: words, typed: true },
          ],
          output: goalReadingReply(accounts),
        },
        { sendAnyway },
      );
    } catch (error) {
      if (!(error instanceof PrivacyRefusal)) throw error;
      log.warn("The privacy filter refused a Goal's reading");
      return { refused: "failed", failure: "privacy" };
    }
    if (reply.ready) {
      const { deadline } = reply.output;
      if (deadline !== null && deadline < today) return { refused: "past deadline" };
      return { reading: await readingOf(reply.output, accounts) };
    }
    if ("pause" in reply) return { refused: "paused", pause: reply.pause };
    // Reading a Goal never waits for a retry: the page offers "Try again".
    return { refused: "failed", failure: "failed" in reply ? reply.failed : "server error" };
  }

  // After a save: the Goal amount when the change gives it, today, then the Goal's run. The
  // summary is built again for the next Writer use, so the Goal is in it at once. The Goal stays
  // saved when its run cannot be asked for: saving it again would only add it twice.
  async function afterSave(goalId: string): Promise<void> {
    await startGoal(database, goalId, { now: now() });
    await dropHouseholdSummary(database);
    try {
      await requestGoalRun(goalId);
    } catch (error) {
      log.error("The Goal's Budget tailoring run could not be asked for", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // Reads the words with the Member's place taken, then stores them. The place goes back when no
  // call went out: a pause before the call, or the privacy filter's refusal. A "key rejected" pause
  // is the provider's answer to a call, unless the key was rejected before this save.
  async function readAndStore(
    memberId: string,
    place: number,
    words: string,
    sendAnyway: boolean,
    store: (reading: GoalReading) => Promise<string | GoalSaveRefusal>,
  ): Promise<{ goalId: string } | GoalSaveRefusal> {
    const rejectedBefore = (await ai.pauseFor("reading a goal")) === "key rejected";
    const found = await read(words, sendAnyway);
    if ("refused" in found) {
      const sent =
        found.refused === "paused"
          ? found.pause === "key rejected" && !rejectedBefore
          : !("failure" in found && found.failure === "privacy");
      if (!sent) release(memberId, place);
      if (found.refused === "failed") log.info("A Goal's reading failed", { why: found.failure });
      return found;
    }
    const stored = await store(found.reading);
    if (typeof stored !== "string") return stored;
    await afterSave(stored);
    log.info("A Member saved a Goal", { target: found.reading.target?.kind ?? null });
    return { goalId: stored };
  }

  return {
    pause: () => ai.pauseFor("reading a goal"),

    async add(memberId, input) {
      const words = goalWords(input.words);
      if (words === "" || words.length > GOAL_WORDS_LENGTH) return { refused: "empty" };
      const place = reserve(memberId);
      if (place === undefined) return { refused: "rate cap" };
      return readAndStore(memberId, place, words, input.sendAnyway, async (reading) =>
        addGoal(database, {
          words,
          authorId: memberId,
          date: await householdDay(database, now()),
          ...reading,
        }),
      );
    },

    async edit(memberId, goalId, input) {
      const words = goalWords(input.words);
      if (words === "" || words.length > GOAL_WORDS_LENGTH) return { refused: "empty" };
      // Taken before any wait, so the same Goal saved twice at once makes one call.
      if (reading.has(goalId)) return { refused: "busy" };
      const place = reserve(memberId);
      if (place === undefined) return { refused: "rate cap" };
      reading.add(goalId);
      try {
        const goal = await readGoal(database, goalId);
        const refusal: GoalSaveRefusal | undefined =
          goal === undefined
            ? { refused: "not found" }
            : goal.status !== "active"
              ? { refused: "not active" }
              : undefined;
        if (refusal !== undefined || goal?.words === words) {
          release(memberId, place);
          return refusal ?? { goalId };
        }
        return await readAndStore(memberId, place, words, input.sendAnyway, async (found) =>
          (await storeGoalWords(database, goalId, { words, ...found }, now()))
            ? goalId
            : { refused: "not active" },
        );
      } finally {
        reading.delete(goalId);
      }
    },
  };
}
