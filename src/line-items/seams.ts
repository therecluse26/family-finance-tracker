import type { Database } from "../db/index.ts";
import type { Logger } from "../log.ts";

// The work that follows an import and "Delete all Amazon data" (spec 14). Other modules register
// it here, as follow-up steps register with registerFollowUpStep: linking registers "linking", and
// Line item Categories and splits register "Categories". The steps run in this order, one at a
// time, after the import's or the delete's transaction commits. Until a step registers, it is a
// no-op.
export const LINE_ITEM_STEPS = ["linking", "Categories"] as const;

export type LineItemStepName = (typeof LINE_ITEM_STEPS)[number];

// A step gets app.db and the Transactions the change touched:
// - after an import, those linked to a Line item whose file fields changed;
// - after Delete all, those that had a Line item linked, which go back to the cascade.
export type LineItemStep = (database: Database, transactionIds: readonly string[]) => Promise<void>;

const afterImport = new Map<LineItemStepName, LineItemStep>();
const afterRemoval = new Map<LineItemStepName, LineItemStep>();

function register(
  steps: Map<LineItemStepName, LineItemStep>,
  name: LineItemStepName,
  step: LineItemStep,
  what: string,
): () => void {
  if (steps.has(name)) throw new Error(`The ${what} step "${name}" is already registered.`);
  steps.set(name, step);
  return () => {
    if (steps.get(name) === step) steps.delete(name);
  };
}

// Registers work after each import. Returns a function that removes it again.
export function registerLineItemsImported(name: LineItemStepName, step: LineItemStep): () => void {
  return register(afterImport, name, step, "after-import");
}

// Registers work after "Delete all Amazon data". Returns a function that removes it again.
export function registerLineItemsRemoved(name: LineItemStepName, step: LineItemStep): () => void {
  return register(afterRemoval, name, step, "after-removal");
}

// Runs each registered step in order. A step that throws is logged by its name and error type
// only, since an error can quote a row, and the next step still runs: the import or the delete has
// already committed.
async function run(
  steps: Map<LineItemStepName, LineItemStep>,
  what: string,
  database: Database,
  transactionIds: readonly string[],
  logger: Logger,
): Promise<void> {
  for (const name of LINE_ITEM_STEPS) {
    const step = steps.get(name);
    if (step === undefined) continue;
    try {
      await step(database, transactionIds);
    } catch (error) {
      logger.error(`A Line item step failed ${what}`, {
        step: name,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

export function lineItemsImported(
  database: Database,
  transactionIds: readonly string[],
  logger: Logger,
): Promise<void> {
  return run(afterImport, "after an import", database, transactionIds, logger);
}

export function lineItemsRemoved(
  database: Database,
  transactionIds: readonly string[],
  logger: Logger,
): Promise<void> {
  return run(afterRemoval, "after Delete all", database, transactionIds, logger);
}
