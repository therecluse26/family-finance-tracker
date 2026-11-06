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
  OPTIONAL_SETUP_STEPS,
  type OptionalSetupStep,
  type SetupProgressView,
  type SetupRefusal,
  type SetupRoutes,
} from "./setup-views.ts";

// The first-run wizard's progress (spec 12, The first-run wizard). Until steps 1 to 4 are done,
// every page leads to the wizard. The next visit opens the first step that is neither done nor
// skipped.

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

// Step 9, Finish, is done once the first Member opens the dashboard from it.
const FINISH = "finish";

// Steps 5 to 9, for the first Member only (spec 12, Order and resume rules). A step is done only on
// what the server knows: Banks once app.db holds a Connection, an Unconnected account, or a Manual
// loan; AI once an AI provider is set; Alerts once a test email went out; Invite Members once an
// invite link is made. A done step stays done, so a skipped one leaves the "Finish setup" list for
// good, wherever it was done.
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
      OPTIONAL_SETUP_STEPS.map((step) => [step, steps.get(step) ?? null]),
    ) as SetupProgressView["steps"];
    const open = OPTIONAL_SETUP_STEPS.find((step) => status[step] === null);
    const wizardStep = open ?? (steps.get(FINISH) === "done" ? null : FINISH);
    return {
      next: !state.wizard && memberId === firstMemberId ? wizardStep : null,
      steps: status,
      finishSetup: OPTIONAL_SETUP_STEPS.filter((step) => status[step] === "skipped"),
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

    async skip(memberId: string, step: OptionalSetupStep) {
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
