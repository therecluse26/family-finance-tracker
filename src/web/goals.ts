import { dateLabel, type StatusWord, wholeDollars } from "../format.ts";
import type { GoalProgressView, GoalReadingView, GoalView } from "../server/goals-views.ts";
import { api } from "./api.ts";

// Goals on the dashboard and the Goals page (spec 07, 3. Goals; Goals page). The app computes
// every number; these words come from the Goal routes' answers.

export type GoalsAnswer = { goals: GoalView[]; aiProvider: boolean };

export const NEEDS_AI = "Goals need an AI provider";
export const AI_SETTINGS = "/settings/ai";

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
