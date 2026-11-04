// What the Review list routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

export type ReviewChoiceView = { value: string; label: string };

export type ReviewItemView = {
  id: string;
  kind: string;
  subject: { type: "transactions"; transactionIds: string[] } | { type: "loan"; accountId: string };
  decided: string;
  bestAnswer: ReviewChoiceView;
  createdAt: string;
  // The AI decides it once AI is back.
  needsAi: boolean;
};

export type ReviewRoutes = {
  // Every open item, newest first.
  open(): Promise<ReviewItemView[]>;
  count(): Promise<number>;
  // The choices behind "Not this". Undefined when no open item has this ID.
  otherChoices(id: string): Promise<ReviewChoiceView[] | undefined>;
  answer(
    id: string,
    value: string,
    memberId: string,
  ): Promise<"answered" | "not open" | "not a choice">;
};
