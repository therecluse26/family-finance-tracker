// AI work on your Transactions, as Settings → AI sees it (spec 08, AI work on your Transactions):
// "Finish AI work now", "Run AI on all history", and the status line of the AI's work. This file
// imports nothing, so the web app's type check can follow it.

// The two runs a Member starts.
// - "finish": the redo of no-AI work at once, for every marked item, and the first AI run if it is
//   not done.
// - "all history": the first AI run's work again on the last 18 months.
export const AI_WORK_KINDS = ["finish", "all history"] as const;

export type AiWorkKind = (typeof AI_WORK_KINDS)[number];

// How many months back "Run AI on all history" looks, by posted date: the history the first AI
// run covers.
export const ALL_HISTORY_MONTHS = 18;

// The step a running redo is on. "starting" covers a Member's run before its job starts, and
// between its job's attempts.
export type AiWorkStep =
  | "starting"
  | "marking history"
  | "Merchant names"
  | "Money movement"
  | "Categories"
  | "Insight cards";

// Why AI work waits now: the pause every Quick-tier use takes.
export type AiWorkWait =
  | "no AI provider"
  | "key rejected"
  | "cost cap"
  | "waits for history"
  | "no price";

export type AiWorkView = {
  // A run waiting or running, with a Member's kind, or null for a redo that AI's return started.
  running: { kind: AiWorkKind | null; step: AiWorkStep } | null;
  // Why AI work waits, or null when it may run.
  waits: AiWorkWait | null;
  // The marked items that wait for the AI.
  waiting: number;
  // The last redo that ended, its time as an ISO moment.
  lastRun: { at: string; items: number; outcome: "finished" | "stopped" } | null;
};

// Why a press started no run. Each one makes no AI call.
export type AiWorkRefusal = "running" | AiWorkWait | "nothing waits";

export const AI_WORK_REFUSALS: Record<AiWorkRefusal, string> = {
  running: "AI work is running. Wait for it to finish.",
  "no AI provider": "Set up an AI provider first.",
  "key rejected": "The AI provider rejected the key. Enter a new key, then save.",
  "cost cap": "The AI cost cap is reached. Raise the cap, or wait for the 1st.",
  "waits for history": "AI work waits for your history to load.",
  "no price": "The app has no price for the Quick model. Enter its prices, then save.",
  "nothing waits": "Nothing waits for the AI.",
};

// The status line's words while AI work waits.
export const AI_WORK_WAIT_LINES: Record<AiWorkWait, string> = {
  "no AI provider": "AI work waits: no AI provider",
  "key rejected": "AI work waits: the AI provider rejected the key",
  "cost cap": "AI work waits: AI cost cap reached",
  "waits for history": "AI work waits for history to load",
  "no price": "AI work waits: the Quick model has no price",
};

// What a press answers: the run started, with the status line, or why not.
export type AiWorkPress =
  | { started: true; work: AiWorkView }
  | { started: false; refusal: AiWorkRefusal };

// Settings, AI's routes for the AI's work (src/redo/redo.ts).
export type AiWork = {
  view(): Promise<AiWorkView>;
  press(kind: AiWorkKind): Promise<AiWorkPress>;
};
