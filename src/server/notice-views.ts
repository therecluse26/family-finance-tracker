// What the System notice routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

export type NoticeView = {
  id: string;
  text: string;
  raisedAt: string;
  // True for an event notice, which a Member closes. A condition notice stays until it ends.
  closable: boolean;
  // The Connection whose Repair button the notice shows, while it needs a Member or is Broken.
  repairConnectionId: string | null;
  // True when the notice is about a stopped First run or bank-added-later job. Its Retry button
  // posts to /api/history-jobs/retry.
  retryHistoryJob: boolean;
};

export type NoticeRoutes = {
  // Every open System notice, newest first.
  open(): Promise<NoticeView[]>;
  // Closes an open event notice for every Member.
  close(id: string, memberId: string): Promise<"closed" | "not open" | "condition">;
};
