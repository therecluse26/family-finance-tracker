import type { ReviewItemView } from "../server/review-views.ts";
import { api } from "./api.ts";
import { transactionRequests } from "./transactions.ts";

// The Review list page's requests (spec 07, Review list page). Every kind answers through the same
// route: its best answer's value, or one of the other choices' values. The answer route reads its
// body itself, so the typed client does not name it, and the body goes in through a separate
// object.

export const reviewListRequests = {
  open: () => api["review-list"].$get(),
  count: () => api["review-list"].count.$get(),
  // The choices behind "Not this".
  choices: (id: string) => api["review-list"][":id"].choices.$get({ param: { id } }),
  answer: (id: string, value: string) => {
    const answer = { param: { id }, json: { value } };
    return api["review-list"][":id"].answer.$post(answer);
  },
};

// The kind whose best answer opens the Manual loan form, with the lender filled in, as the
// money-movement module names it (spec 03, Review list items). The form adds the loan, and the item
// closes once its payout links to it.
export const UNTRACKED_LOAN_KIND = "untracked loan";

// Only a path to the Manual loan form in Settings, Banks opens from an item.
const MANUAL_LOAN_FORM = /^\/settings\/banks(?:[?#]|$)/;

// What the button that accepts the app's best answer does: answer the item, or open the Manual
// loan form.
export type Accept = { label: string } & (
  | { does: "answer"; value: string }
  | { does: "open"; path: string }
);

export function acceptOf(item: Pick<ReviewItemView, "kind" | "bestAnswer">): Accept {
  const { value, label } = item.bestAnswer;
  if (item.kind === UNTRACKED_LOAN_KIND && MANUAL_LOAN_FORM.test(value)) {
    return { does: "open", path: value, label };
  }
  return { does: "answer", value, label };
}

// The main menu's count of open items, or undefined when the server did not answer it.
export async function readOpenCount(): Promise<number | undefined> {
  try {
    const res = await reviewListRequests.count();
    return res.ok ? (await res.json()).open : undefined;
  } catch {
    return undefined;
  }
}

export type AnswerOutcome =
  | { answered: true; openCount: number | undefined }
  // `stillOpen` is false when the item had closed already, such as when a later event settled it.
  | { answered: false; error: string; stillOpen: boolean };

// Sends a Member's answer, then reads the open count again for the main menu. An answer that is no
// longer a choice keeps the item open, with the server's words.
export async function answerItem(id: string, value: string): Promise<AnswerOutcome> {
  let res: Response;
  try {
    res = await reviewListRequests.answer(id, value);
  } catch {
    return { answered: false, error: "The server did not answer.", stillOpen: true };
  }
  if (res.ok) return { answered: true, openCount: await readOpenCount() };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return {
    answered: false,
    error: typeof body.error === "string" ? body.error : "That did not work.",
    stillOpen: res.status !== 404,
  };
}

// "Change" on a row of a Category card: sets that Transaction's Category alone, with no Category
// rule, so it leaves the card (spec 04, Review list items). Resolves with the server's words when
// it did not work.
export async function changeOneCategory(
  transactionId: string,
  category: string,
): Promise<string | undefined> {
  try {
    const res = await transactionRequests.setCategory(transactionId, category, true);
    if (res.ok) return undefined;
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return typeof body.error === "string" ? body.error : "That did not work.";
  } catch {
    return "The server did not answer.";
  }
}
