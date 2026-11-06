// What the first-run wizard's optional steps answer (spec 12, The first-run wizard; spec 07, Header
// and status lines). This file imports nothing, so the web app's type check can follow it through
// api.ts.

// Steps 5 to 8, in order. Each one has Skip.
export const OPTIONAL_SETUP_STEPS = ["banks", "ai", "alerts", "invite members"] as const;

export type OptionalSetupStep = (typeof OPTIONAL_SETUP_STEPS)[number];

export type SetupProgressView = {
  // The step the wizard opens for the signed-in Member: the first optional step neither done nor
  // skipped, then step 9, Finish. Null when the wizard has nothing more for them, and always for a
  // Member other than the first.
  next: OptionalSetupStep | "finish" | null;
  // Each optional step: done, skipped, or neither yet.
  steps: Record<OptionalSetupStep, "done" | "skipped" | null>;
  // The dashboard's "Finish setup" list: each skipped step not yet done, in wizard order.
  finishSetup: OptionalSetupStep[];
  // The Household's Connections, not counting removed ones. The Finish step says when there are
  // none.
  connections: number;
};

export type SetupRefusal = "setup not done" | "not the first member" | "steps left";

export type SetupRoutes = {
  progress(memberId: string): Promise<SetupProgressView>;
  // Skip on an optional step: only the first Member, once steps 1 to 4 are done. A step already
  // done stays done.
  skip(memberId: string, step: OptionalSetupStep): Promise<SetupProgressView | SetupRefusal>;
  // Step 9's "Open the dashboard": only the first Member, once every optional step is done or
  // skipped.
  finish(memberId: string): Promise<SetupProgressView | SetupRefusal>;
  // A step whose work only the server sees: Alerts once a test email went out, Invite Members
  // once an invite link is made.
  done(step: "alerts" | "invite members"): Promise<void>;
};
