// What the System notice routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

export type NoticeView = {
  id: string;
  text: string;
  raisedAt: string;
  // True for an event notice, which a Member closes. A condition notice stays until it ends.
  closable: boolean;
};

export type NoticeRoutes = {
  // Every open System notice, newest first.
  open(): Promise<NoticeView[]>;
  // Closes an open event notice for every Member.
  close(id: string, memberId: string): Promise<"closed" | "not open" | "condition">;
};
