// AI work on your Transactions, as Settings → AI sees it (spec 08, AI work on your Transactions):
// "Finish AI work now", "Run AI on all history", the status line of the AI's work, and the live AI
// status (spec 08, Live AI status). This file imports only a type from src/ai/ai-view.ts, which
// imports nothing, so the web app's type check can follow it.

import type { ModelUse } from "../ai/ai-view.ts";

// The two runs a Member starts.
// - "finish": the redo of no-AI work at once, for every marked item, and the first AI run if it is
//   not done.
// - "all history": the AI decides again each Category of the last 18 months that no hand edit,
//   Category rule, or Money movement set, past the provider's category and Merchant history.
export const AI_WORK_KINDS = ["finish", "all history"] as const;

export type AiWorkKind = (typeof AI_WORK_KINDS)[number];

// How many months back "Run AI on all history" looks, by posted date: the history the first AI
// run covers.
export const ALL_HISTORY_MONTHS = 18;

// The step a running redo is on. "starting" covers a Member's run before its job starts, and
// between its job's attempts.
export type AiWorkStep =
  | "starting"
  | "Merchant names"
  | "Money movement"
  | "Categories"
  | "Insight cards";

// Why AI work waits now: the pause every Quick-tier use takes, or a retry wait, while a use the
// run calls waits for its retry after a failed call.
export type AiWorkWait =
  | "no AI provider"
  | "key rejected"
  | "cost cap"
  | "waits for history"
  | "no price"
  | "retry wait";

export type AiWorkView = {
  // A run waiting or running, with a Member's kind, or null for a redo that AI's return started.
  running: { kind: AiWorkKind | null; step: AiWorkStep } | null;
  // Why AI work waits, or null when it may run.
  waits: AiWorkWait | null;
  // With a retry wait, the time the AI tries again, as an ISO moment; otherwise null.
  retryAt: string | null;
  // The marked items that wait for the AI.
  waiting: number;
  // The last redo that ended, its time as an ISO moment: the marked items it decided, and how many
  // Transactions' Categories the AI answered.
  lastRun: {
    at: string;
    items: number;
    aiCategories: number;
    outcome: "finished" | "stopped";
  } | null;
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
  // With no time known. A press names the time: retryWaitRefusal.
  "retry wait": "The AI tries again soon. Press again after that.",
  "nothing waits": "Nothing waits for the AI.",
};

// A press refused during a retry wait, with the time in Household time, such as "2:41 PM".
export const retryWaitRefusal = (time: string) =>
  `AI tries again at ${time}. Press again after that.`;

// The status line during a retry wait, with the time in Household time.
export const retryWaitLine = (time: string) => `AI work waits: AI tries again at ${time}`;

// The status line's words while AI work waits.
export const AI_WORK_WAIT_LINES: Record<AiWorkWait, string> = {
  "no AI provider": "AI work waits: no AI provider",
  "key rejected": "AI work waits: the AI provider rejected the key",
  "cost cap": "AI work waits: AI cost cap reached",
  "waits for history": "AI work waits for history to load",
  "no price": "AI work waits: the Quick model has no price",
  "retry wait": "AI work waits: AI tries again soon",
};

// What a press answers: the run started, with the status line, or why not.
export type AiWorkPress =
  | { started: true; work: AiWorkView }
  | { started: false; refusal: Exclude<AiWorkRefusal, "retry wait"> }
  | { started: false; refusal: "retry wait"; retryAt: string };

// A background AI use: every use but Chat and reading a Goal, which a Member starts and watches.
export type AiActivityUse = Exclude<ModelUse, "chat" | "reading a goal">;

// The background AI work running now, as the live AI status sees it (spec 08, Live AI status):
// a run of the redo of no-AI work with its kind and step, and each background use with a call in
// progress, in the order their calls started, with how many calls each has. Only names and
// counts: never a Transaction, a Merchant name, an amount, a prompt, or a Member name.
export type AiActivityView = {
  run: { kind: AiWorkKind | null; step: AiWorkStep } | null;
  uses: { use: AiActivityUse; calls: number }[];
};

// The live AI status's feed. `watch` calls `changed` with each new view, and `ended` once, when
// the app stops; it returns the function that stops watching. `stop` ends every watch.
export type AiActivityFeed = {
  now(): AiActivityView;
  watch(changed: (view: AiActivityView) => void, ended: () => void): () => void;
  stop(): void;
};

// Settings, AI's routes for the AI's work (src/redo/redo.ts), and the live AI status's feed.
export type AiWork = {
  view(): Promise<AiWorkView>;
  press(kind: AiWorkKind): Promise<AiWorkPress>;
  activity: AiActivityFeed;
};
