import {
  type Database,
  hasMember,
  markSetupStep,
  markSetupStepsDone,
  readFirstMemberId,
  readSetupFacts,
  readSetupSteps,
  skipSetupStep,
} from "../db/index.ts";
import {
  FINISH_SETUP_ITEMS,
  type SetupProgressView,
  type SetupRefusal,
  type SetupRoutes,
  type SkippableSetupStep,
} from "./setup-views.ts";

// The first-run wizard's progress (spec 12, The first-run wizard). Its 6 steps are the setup link,
// the first Member's login, the Master key, the Household, Banks, and Finish. Until steps 1 to 4
// are done, every page leads to the wizard. The next visit opens the first step that is neither
// done nor skipped.

// The required steps, in order. Steps 1 and 2 are done once a Member exists; the others are done
// when their step marks them in app.db.
export const REQUIRED_SETUP_STEPS = [
  "setup link",
  "first member",
  "master key",
  "household facts",
] as const;

export type SetupStep = (typeof REQUIRED_SETUP_STEPS)[number];

export type SetupState = {
  // The required step the wizard opens, or null once steps 1 to 4 are done.
  next: SetupStep | null;
  // True until steps 1 to 4 are done. Every page then leads to the wizard.
  wizard: boolean;
};

export async function readSetupState(database: Database): Promise<SetupState> {
  if (!(await hasMember(database))) return { next: "setup link", wizard: true };
  const steps = await readSetupSteps(database);
  const next = REQUIRED_SETUP_STEPS.slice(2).find((step) => steps.get(step) === undefined) ?? null;
  return { next, wizard: next !== null };
}

// Step 6, Finish, is done once the first Member opens the dashboard from it.
const FINISH = "finish";

// Steps 5 and 6, for the first Member only, and the "Finish setup" list (spec 12, Order and resume
// rules). An item is done only on what the server knows: Banks once app.db holds a Connection; AI
// once an AI provider is set; Alerts once a test email went out; Invite Members once an invite link
// is made. A done item stays done, so an extra leaves the "Finish setup" list for good, wherever it
// was done. Banks is listed while app.db holds no Connection that is not removed, even once its step
// is done.
export function setupRoutes(database: Database): SetupRoutes {
  async function progress(memberId: string): Promise<SetupProgressView> {
    const [state, steps, facts, firstMemberId] = await Promise.all([
      readSetupState(database),
      readSetupSteps(database),
      readSetupFacts(database),
      readFirstMemberId(database),
    ]);
    const newlyDone = (["banks", "ai"] as const).filter(
      (step) => facts[step] && steps.get(step) !== "done",
    );
    await markSetupStepsDone(database, newlyDone);
    for (const step of newlyDone) steps.set(step, "done");

    const status = Object.fromEntries(
      FINISH_SETUP_ITEMS.map((item) => [item, steps.get(item) ?? null]),
    ) as SetupProgressView["steps"];
    // Banks waits until it is done or skipped; the optional extras never hold the wizard up.
    const wizardStep =
      status.banks === null ? "banks" : steps.get(FINISH) === "done" ? null : FINISH;
    return {
      next: !state.wizard && memberId === firstMemberId ? wizardStep : null,
      steps: status,
      // Banks stays in the list while no Connection exists now, even once the step is done.
      finishSetup: state.wizard
        ? []
        : FINISH_SETUP_ITEMS.filter((item) =>
            item === "banks" ? !facts.banks : status[item] !== "done",
          ),
      connections: facts.connections,
    };
  }

  // Why the Member cannot change the wizard's steps, if they cannot.
  async function refusal(memberId: string): Promise<SetupRefusal | undefined> {
    if ((await readSetupState(database)).wizard) return "setup not done";
    if ((await readFirstMemberId(database)) !== memberId) return "not the first member";
    return undefined;
  }

  return {
    progress,

    async skip(memberId: string, step: SkippableSetupStep) {
      const refused = await refusal(memberId);
      if (refused !== undefined) return refused;
      await skipSetupStep(database, step);
      return progress(memberId);
    },

    async finish(memberId: string) {
      const refused = await refusal(memberId);
      if (refused !== undefined) return refused;
      const before = await progress(memberId);
      if (before.next === null) return before;
      if (before.next !== FINISH) return "steps left";
      await markSetupStep(database, FINISH, "done");
      return progress(memberId);
    },

    async done(step) {
      await markSetupStepsDone(database, [step]);
    },
  };
}
