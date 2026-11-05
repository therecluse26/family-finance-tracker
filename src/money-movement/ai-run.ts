// One Matching run's state for the AI's link decisions (spec 03, AI decisions and the no-AI path;
// spec 08, Failures). The judges of Unclear links and the Reimbursement picker share it within a
// run.

// The AI uses that decide links: Unclear Transfer pairs and Manual loan payments, and
// Reimbursements.
export type LinkAiUse = "unclear transfer" | "reimbursement linking";

export type AiRun = {
  // Each use that stopped asking in this run, so a later batch never starts a new cycle of retries:
  // - "no AI" after a pause, such as the AI cost cap, or a failed call with no retry left. Its
  //   questions take the no-AI path.
  // - "retry" after a failed call whose retry is still to come. Its questions wait for the retry.
  readonly stopped: Map<LinkAiUse, "no AI" | "retry">;
  // The earliest retry time, when a use waits for one.
  retryAt?: Date;
  // The Transactions whose questions wait for that retry. The Matching step leaves them for the
  // follow-up job the retry starts.
  readonly waiting: Set<string>;
};

export const newAiRun = (): AiRun => ({ stopped: new Map(), waiting: new Set() });
