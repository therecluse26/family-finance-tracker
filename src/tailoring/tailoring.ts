import * as z from "zod";
import {
  type AiReply,
  type HouseholdAi,
  type SummaryPart,
  type TypedValue,
  typedAmount,
} from "../ai/index.ts";
import { type CategoryBenchmark, categoryBenchmarks } from "../benchmarks/index.ts";
import {
  budgetsForMonth,
  type DraftedBudget,
  draftBudgets,
  fitToIncome,
  readDraftTerms,
} from "../budgets/index.ts";
import { CATEGORIES, type Category, categoryGroupOf } from "../categories/index.ts";
import type { Database } from "../db/index.ts";
import { householdSummary } from "../summary/index.ts";

// Budget tailoring (spec 05, The AI's part in a draft; spec 08, Alert advice, Budget tailoring,
// and reading a Goal): one Writer call that adjusts the flexible Budgets for the active Goals, with
// a one-sentence reason per Category. It reads the Household summary, the draft or current
// Budgets, the formula's figures, the Benchmarks, and the CE note on Housing and Car. It never
// reads the ZIP code or the ages: the Benchmarks come as amounts only. Every number the app made
// goes as a typed value, so the privacy filter never takes one for a last 4. The call has no cache
// mark and at most 1,500 reply tokens (src/ai/prompt.ts sets both for this use).

// The longest reason the app keeps: one sentence.
const MAX_REASON = 300;
// The largest figure the reply may hold, in dollars: under a typed amount's cap.
const MAX_DOLLARS = 1_000_000_000;

const CATEGORY_NAMES = CATEGORIES.map(({ name }) => name) as [Category, ...Category[]];

// The reply. A Category outside the fixed list fails it. Bills lines pass it, and the app drops
// them: tailoring never changes a Bills Budget.
export const tailoringReply = z.object({
  reason: z.string().min(1).max(MAX_REASON),
  budgets: z
    .array(
      z.object({
        category: z.enum(CATEGORY_NAMES),
        amount: z.number().min(0).max(MAX_DOLLARS),
        reason: z.string().min(1).max(MAX_REASON),
      }),
    )
    .max(CATEGORIES.length),
  goalAmount: z.number().min(0).max(MAX_DOLLARS).nullable(),
  goalReason: z.string().min(1).max(MAX_REASON).nullable(),
});

export type TailoringReply = z.infer<typeof tailoringReply>;

// The task: the same words on every call. Which run it is comes with the facts.
export const TAILORING_TASK = [
  "Task: Budget tailoring. Adjust the flexible Budgets for the Household's active Goals.",
  "- The facts after this task name the run: the first draft, a Tailoring run, a redraft, or a Goal run. They list each flexible Category's Budget and the formula's figure, with its Benchmark or no good Benchmark, and the Bills Budgets.",
  "- Give an amount in whole dollars and a one-sentence reason for each flexible Category you change. Leave out a Category you keep as it is.",
  "- Keep each amount from 50% to 150% of the formula's figure. The app moves any amount outside to the nearer end.",
  "- Never change a Bills Budget or the Interest and fees Budget.",
  "- For a Category with no good Benchmark whose Budget looks high, say so in its reason.",
  "- In a Goal run, change only the flexible Categories that Goal touches. Give `goalAmount` when the facts ask for one: for a spend less Goal, a monthly Spending amount below its baseline; for a save Goal, a balance above its balance now. Give `goalReason` as one sentence for it. Otherwise both are null.",
  "- In a redraft, the formula's figure is the new draft. For a Category you leave out, the app proposes the formula's figure.",
  "- `reason` is one sentence on the whole change.",
  "- Name no bank, card issuer, lender, or other company.",
].join("\n");

// The run a call is for.
export type TailoringRun =
  | { kind: "first draft" }
  | { kind: "Tailoring" }
  | { kind: "Redraft" }
  | { kind: "Goal"; words: string; goal: GoalFacts };

// What a Goal run's facts say about its Goal: a spend less Goal's baseline, or a save Goal's
// balance now, and whether the app wants the AI's Goal amount.
export type GoalFacts =
  | { kind: "spend less"; baseline: number; asksAmount: boolean }
  | { kind: "save toward an amount"; balance: number; asksAmount: boolean }
  | { kind: "other" };

// One Category's line: its Budget now (the draft's, in the first draft), and the formula's
// figure, each in whole cents, per month or per year.
export type CategoryFigure = {
  category: Category;
  budget: number | null;
  formula: number | null;
  period: "monthly" | "yearly";
};

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// Text a Member wrote, such as a Goal's words, as one plain line, so it cannot start a line of its
// own. It is app-built text after that, and the privacy filter reads it in full.
const plain = (text: string) =>
  text.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

const isBills = (category: Category) => categoryGroupOf(category) === "Bills";

// The facts of one call, as pieces: each amount the app made is a typed value.
export function tailoringFacts(input: {
  run: TailoringRun;
  figures: readonly CategoryFigure[];
  benchmarks: ReadonlyMap<Category, CategoryBenchmark>;
}): SummaryPart[] {
  const { run, figures, benchmarks } = input;
  const parts: SummaryPart[] = [];
  const add = (...pieces: (string | TypedValue)[]) => parts.push(...pieces);
  const amount = (cents: number, period: CategoryFigure["period"]) =>
    period === "yearly" ? [typedAmount(cents), " a year"] : [typedAmount(cents)];

  add(
    run.kind === "first draft"
      ? "## This run: the first draft. Its figures take effect at once.\n"
      : run.kind === "Tailoring"
        ? "## This run: a Tailoring run. Its figures become one Proposal.\n"
        : run.kind === "Redraft"
          ? "## This run: a redraft of the flexible Budgets. Its figures become one Proposal.\n"
          : "## This run: a Goal run. Its figures become a Proposal.\n",
  );
  if (run.kind === "Goal") {
    add(`## The Goal of this run\n- "${plain(run.words)}": `);
    const { goal } = run;
    if (goal.kind === "spend less") {
      add("spend less; baseline ", typedAmount(goal.baseline), " a month.");
    } else if (goal.kind === "save toward an amount") {
      add("save toward an amount; balance now ", typedAmount(goal.balance), ".");
    } else {
      add("no Goal amount for this kind.");
    }
    const asks = goal.kind !== "other" && goal.asksAmount;
    add(asks ? " Give its goalAmount.\n" : " goalAmount is null.\n");
  }

  const line = (figure: CategoryFigure) => {
    const { category, budget, formula, period } = figure;
    add(`- ${category}: `);
    // In the first draft, the formula's figure is the draft.
    if (run.kind === "first draft") add("the formula's figure ", ...amount(formula ?? 0, period));
    else if (budget === null) add("no Budget");
    else add("Budget ", ...amount(budget, period));
    if (run.kind !== "first draft" && formula !== null && !isBills(category)) {
      add("; the formula's figure ", ...amount(formula, period));
    }
    const benchmark = benchmarks.get(category);
    if (benchmark?.amount != null) add("; Benchmark ", typedAmount(benchmark.amount), " a month");
    else if (!isBills(category)) add("; no good Benchmark");
    if (benchmark?.ceNote != null) add(`. ${benchmark.ceNote}`);
    add("\n");
  };
  add("## Flexible Budgets\n");
  for (const figure of figures) if (!isBills(figure.category)) line(figure);
  add("## Bills Budgets, never changed\n");
  for (const figure of figures) if (isBills(figure.category)) line(figure);
  return parts;
}

// What one Budget tailoring call needs from app.db, for the Household's month: the formula's
// figures after the "must fit" step, at `income`, the I they used.
export async function readTailoringFacts(
  database: Database,
  month: string,
  now: Date,
  today: string,
): Promise<{
  formula: DraftedBudget[];
  income: number;
  budgets: Map<Category, { amount: number; period: "monthly" | "yearly" }>;
  benchmarks: Map<Category, CategoryBenchmark>;
}> {
  const terms = await readDraftTerms(database, month, now, today);
  const formula = fitToIncome(draftBudgets(terms), terms).budgets;
  const budgets = new Map(
    (await budgetsForMonth(database, month)).budgets.map((budget) => [
      budget.category,
      { amount: budget.amount, period: budget.period },
    ]),
  );
  return {
    formula,
    income: terms.income,
    budgets,
    benchmarks: await benchmarksOf(database, now),
  };
}

// Each Category's Benchmark, as the AI reads it: amounts only, never the facts behind them.
export async function benchmarksOf(
  database: Database,
  now: Date,
): Promise<Map<Category, CategoryBenchmark>> {
  const found = await categoryBenchmarks(database, now);
  return new Map((found?.categories ?? []).map((each) => [each.category, each]));
}

// The figures a call lists, in Category list order: each Category with a Budget or a formula
// figure.
export function figuresOf(
  formula: readonly DraftedBudget[],
  budgets: ReadonlyMap<Category, { amount: number; period: "monthly" | "yearly" }>,
): CategoryFigure[] {
  const drafted = new Map(formula.map((each) => [each.category, each]));
  return CATEGORY_NAMES.flatMap((category): CategoryFigure[] => {
    const draft = drafted.get(category);
    const budget = budgets.get(category);
    if (draft === undefined && budget === undefined) return [];
    return [
      {
        category,
        budget: budget?.amount ?? null,
        formula: draft?.amount ?? null,
        period: budget?.period ?? draft?.period ?? "monthly",
      },
    ];
  });
}

// The one Budget tailoring call.
export async function askTailoring(input: {
  database: Database;
  ai: HouseholdAi;
  now: () => Date;
  run: TailoringRun;
  figures: readonly CategoryFigure[];
  benchmarks: ReadonlyMap<Category, CategoryBenchmark>;
}): Promise<AiReply<TailoringReply>> {
  const { database, ai, now } = input;
  const summary = await householdSummary({ database, ai, now }).today();
  return ai.generate({
    use: "budget tailoring",
    summary: summary.parts,
    task: TAILORING_TASK,
    facts: tailoringFacts(input),
    output: tailoringReply,
  });
}

// A figure from the reply, in whole cents: whole dollars.
export const centsOf = (dollars: number) => Math.round(dollars) * 100;

// The AI's figure in whole cents and its reason as the screen shows it, for each listed Category it
// gives one for: the first line for a Category counts. The caller keeps each figure in its range
// and drops Bills, where it writes.
export async function aiFigures(
  ai: Pick<HouseholdAi, "forScreen">,
  reply: TailoringReply,
  listed: ReadonlySet<Category>,
): Promise<Map<Category, { amount: number; reason: string }>> {
  const figures = new Map<Category, { amount: number; reason: string }>();
  for (const line of reply.budgets) {
    if (!listed.has(line.category) || figures.has(line.category)) continue;
    const reason = await screenText(ai, line.reason);
    if (reason !== "") figures.set(line.category, { amount: centsOf(line.amount), reason });
  }
  return figures;
}

// AI text as the screen shows it, on one line.
export async function screenText(
  ai: Pick<HouseholdAi, "forScreen">,
  text: string,
): Promise<string> {
  return (await ai.forScreen(text)).replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}
