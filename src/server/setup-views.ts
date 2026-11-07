// What the first-run wizard's last steps and the dashboard's "Finish setup" list answer (spec 12,
// The first-run wizard; spec 07, Header and status lines). This file imports nothing, so the web
// app's type check can follow it through api.ts.

// The optional extras: not wizard steps, but items of the "Finish setup" list. The Finish step
// lists them too.
export const SETUP_EXTRAS = ["ai", "alerts", "invite members"] as const;

export type SetupExtra = (typeof SETUP_EXTRAS)[number];

// Step 5, Banks, then the optional extras, in the order the "Finish setup" list shows them.
export const FINISH_SETUP_ITEMS = ["banks", ...SETUP_EXTRAS] as const;

export type FinishSetupItem = (typeof FINISH_SETUP_ITEMS)[number];

// The one wizard step with "Skip for now".
export const SKIPPABLE_SETUP_STEPS = ["banks"] as const;

export type SkippableSetupStep = (typeof SKIPPABLE_SETUP_STEPS)[number];

export type SetupProgressView = {
  // The step the wizard opens for the signed-in Member once steps 1 to 4 are done: step 5, Banks,
  // until it is done or skipped, then step 6, Finish. Null when the wizard has nothing more for
  // them, and always for a Member other than the first.
  next: "banks" | "finish" | null;
  // Banks and each optional extra: done, skipped, or neither yet.
  steps: Record<FinishSetupItem, "done" | "skipped" | null>;
  // The dashboard's "Finish setup" list: each item not yet done, in order. Empty until steps 1 to
  // 4 are done.
  finishSetup: FinishSetupItem[];
  // The Household's Connections, not counting removed ones. Banks is done once there is one.
  connections: number;
};

export type SetupRefusal = "setup not done" | "not the first member" | "steps left";

export type SetupRoutes = {
  progress(memberId: string): Promise<SetupProgressView>;
  // "Skip for now" on step 5, Banks: only the first Member, once steps 1 to 4 are done. A step
  // already done stays done.
  skip(memberId: string, step: SkippableSetupStep): Promise<SetupProgressView | SetupRefusal>;
  // Step 6's "Open the dashboard": only the first Member, once Banks is done or skipped.
  finish(memberId: string): Promise<SetupProgressView | SetupRefusal>;
  // An extra whose work only the server sees: Alerts once a test email went out, Invite Members
  // once an invite link is made.
  done(step: "alerts" | "invite members"): Promise<void>;
};
