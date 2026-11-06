// What the Members routes answer (spec 09, Members; Invites). This file imports nothing, so the web
// app's type check can follow it through api.ts.

export type MemberView = {
  id: string;
  name: string;
  email: string;
  // When they joined, as an ISO 8601 time.
  joinedAt: string;
  // True for the Member signed in on the request.
  you: boolean;
};

// An open invite link. The app keeps only its token's hash, so the link itself is shown once, as
// it is made.
export type InviteView = {
  id: string;
  // The name of the Member who made it. Removing a Member deletes their links.
  madeBy: string;
  createdAt: string;
  expiresAt: string;
};

export type MemberRemovalResult = "removed" | "no such Member" | "last Member";

export type MemberRoutes = {
  // Settings, Members: every Member in the order they joined, and the open invite links.
  members(you: string): Promise<{ members: MemberView[]; invites: InviteView[] }>;
  // "Make an invite link": the link, <APP_URL>/join#token=…, and when it stops working. Refused
  // until the first-run wizard's required steps are done, so a Member who joins never sees it.
  makeInvite(madeBy: string): Promise<{ link: string; expiresAt: string } | "wizard not done">;
  // Cancel. False, with nothing changed, when no open link has the ID.
  cancelInvite(id: string): Promise<boolean>;
  // Removes a Member, after the route has checked a fresh code.
  remove(id: string): Promise<MemberRemovalResult>;
  // "Reset login" on another Member, after the route has checked a fresh code and refused the
  // Member's own login (spec 09, Login reset): the link, <APP_URL>/reset#token=…, and when it
  // stops working.
  resetLogin(id: string): Promise<{ link: string; expiresAt: string } | "no such Member">;
};
