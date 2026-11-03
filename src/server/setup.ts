import { type Database, hasMember, readSetupSteps } from "../db/index.ts";

// The first-run wizard's progress (spec 12, The first-run wizard). Until steps 1 to 4 are done,
// every page leads to the wizard. The next visit opens the first step that is neither done nor
// skipped.

// The required steps, in order. Steps 1 and 2 are done once a Member exists; the others are done
// when their step marks them in app.db. The optional steps come with their own ticket.
export const REQUIRED_SETUP_STEPS = [
  "setup link",
  "first member",
  "master key",
  "household facts",
] as const;

export type SetupStep = (typeof REQUIRED_SETUP_STEPS)[number];

export type SetupState = {
  // The step the wizard opens, or null when every step is done or skipped.
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
