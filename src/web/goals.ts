import { dateLabel, type StatusWord, wholeDollars } from "../format.ts";
import type { GoalProgressView, GoalReadingView, GoalView } from "../server/goals-views.ts";
import { api } from "./api.ts";

// Goals on the dashboard and the Goals page (spec 07, 3. Goals; Goals page). The app computes
// every number; these words come from the Goal routes' answers.

// `waitsForHistory` is true while every AI use waits for the first history load (spec 08, When AI
// does not run): no Goal is added or read until then.
export type GoalsAnswer = { goals: GoalView[]; aiProvider: boolean; waitsForHistory: boolean };

export const NEEDS_AI = "Goals need an AI provider";
export const AI_SETTINGS = "/settings/ai";
export const WAITS_FOR_HISTORY = "Goals open when your history has loaded.";
// The Goals page with the "Add a Goal" form open, as the dashboard's "Add a Goal" opens it.
export const ADD_GOAL_PATH = "/goals?add=1";
// The longest Goal a Member may write, as the goals module checks it.
export const GOAL_WORDS_LENGTH = 300;

// Whether a Member may add a Goal or edit its words now: with an AI provider, once history has
// loaded.
export const mayWriteGoals = (answer: Pick<GoalsAnswer, "aiProvider" | "waitsForHistory">) =>
  answer.aiProvider && !answer.waitsForHistory;

// A Goal's status: "◆ Behind", "✓ On track", or "✓ Done". None before the Goal amount is set, or
// for a save or loan Goal with no deadline, which shows its percentage only.
export type GoalStatusShown =
  | { tone: "serious"; word: StatusWord<"serious"> }
  | { tone: "good"; word: StatusWord<"good"> };

export function goalStatus(progress: GoalProgressView): GoalStatusShown | undefined {
  switch (progress.state) {
    case "Behind":
      return { tone: "serious", word: "Behind" };
    case "On track":
      return { tone: "good", word: "On track" };
    case "Done":
      return { tone: "good", word: "Done" };
    case null:
      return undefined;
  }
}

// The dashboard's boxes: the active Goals, which hold a done Goal for one month.
export const activeGoals = (goals: readonly GoalView[]) =>
  goals.filter((goal) => goal.list === "active");

// "2 of 3 on track". A Goal shown as Done counts as on track.
export function onTrackLine(active: readonly GoalView[]): string {
  const onTrack = active.filter(
    (goal) => goal.progress?.state === "On track" || goal.progress?.state === "Done",
  ).length;
  return `${onTrack} of ${active.length} on track`;
}

// The Member who wrote it.
export const authorOf = (goal: Pick<GoalView, "author">) => goal.author ?? "A removed Member";

// The AI's reading (spec 05, What the app stores): the target, the change, and the deadline. A
// field the words do not say reads "not said". `accountNames` names the Accounts by ID.
export function readingParts(
  reading: GoalReadingView,
  accountNames: ReadonlyMap<string, string>,
  today: string,
): { target: string; change: string; deadline: string } {
  const account = (id: string) => accountNames.get(id) ?? "an Account no longer here";
  const target = reading.target;
  const named =
    target === null
      ? "not said"
      : target.kind === "Category"
        ? target.category
        : target.kind === "Merchant"
          ? target.merchant.name
          : target.kind === "Saving"
            ? "Saving"
            : target.kind === "Accounts"
              ? target.accountIds.map(account).join(", ")
              : account(target.accountId);
  const change =
    reading.change === null
      ? "not said"
      : "amount" in reading.change
        ? wholeDollars(reading.change.amount)
        : `${reading.change.percent}%`;
  return {
    target: named,
    change,
    deadline: reading.deadline === null ? "not said" : dateLabel(reading.deadline, today),
  };
}

// --- Requests ----------------------------------------------------------------------------------

export async function loadGoals(): Promise<GoalsAnswer> {
  const res = await api.goals.$get();
  if (!res.ok) throw new Error(`The Goals request answered ${res.status}.`);
  return (await res.json()) as GoalsAnswer;
}

// Why a save stored nothing: its words, whether it asks "Send anyway?" at the AI cost cap, and
// whether the reading failed, which the page offers to try again. Nothing retries by itself.
export type GoalProblem = { error: string; sendAnyway: boolean; tryAgain: boolean };

// A save route's refusal as a problem.
export async function goalProblemOf(res: Response): Promise<GoalProblem> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    pause?: unknown;
    tryAgain?: unknown;
  };
  return {
    error: typeof body.error === "string" ? body.error : "That did not work.",
    sendAnyway: body.pause === "send anyway?",
    tryAgain: body.tryAgain === true,
  };
}

// "Add a Goal", with no Goal ID, or "Edit the words" of an active Goal. Undefined when it saved,
// else what went wrong. `sendAnyway` is the Member's yes to "Send anyway?".
export async function saveGoal(
  goalId: string | null,
  words: string,
  sendAnyway: boolean,
): Promise<GoalProblem | undefined> {
  let res: Response;
  try {
    // The routes read their JSON body themselves, so the typed client does not list `json`.
    const add = { json: { words, sendAnyway } };
    const edit = { param: { id: goalId ?? "" }, ...add };
    res = goalId === null ? await api.goals.$post(add) : await api.goals[":id"].words.$post(edit);
  } catch {
    return { error: "The server did not answer.", sendAnyway: false, tryAgain: true };
  }
  if (res.ok) return undefined;
  return goalProblemOf(res);
}

// A Member marks an active Goal done or dropped. Undefined when it worked, else what went wrong.
export async function markGoal(
  id: string,
  status: "done" | "dropped",
): Promise<string | undefined> {
  let res: Response;
  try {
    // The route reads its JSON body itself, so the typed client does not list `json`.
    const mark = { param: { id }, json: { status } };
    res = await api.goals[":id"].status.$post(mark);
  } catch {
    return "The server did not answer.";
  }
  if (res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}
