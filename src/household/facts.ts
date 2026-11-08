import {
  type Database,
  readHouseholdFacts as readStoredFacts,
  storeHouseholdFacts,
} from "../db/index.ts";
import { log } from "../log.ts";
import { lookUpZipCode } from "./zip-table.ts";

// The Household facts (spec 05, Household facts): the ZIP code, each person's age, and whether the
// Household rents or owns. The wizard's step 4 records them, and any Member edits them in
// Settings, Household. The ZIP code sets the Household time zone.

export type RentOrOwn = "rent" | "own";

// The facts a Member enters. People without a login count, such as children. No one is asked
// their sex.
export type HouseholdFactsInput = { zipCode: string; ages: number[]; rentOrOwn: RentOrOwn };

export type HouseholdFacts = HouseholdFactsInput & {
  // From the ZIP table.
  state: string;
  // The Household time zone, an IANA name such as America/New_York.
  timeZone: string;
  updatedAt: Date;
};

export async function readHouseholdFacts(database: Database): Promise<HouseholdFacts | undefined> {
  const stored = await readStoredFacts(database);
  if (stored === undefined) return undefined;
  const { zipCode, ages, rentOrOwn, state, timeZone, updatedAt } = stored;
  return { zipCode, ages, rentOrOwn, state, timeZone, updatedAt };
}

// The Household time zone, or undefined until the wizard's step 4 is done.
export async function householdTimeZone(database: Database): Promise<string | undefined> {
  return (await readStoredFacts(database))?.timeZone;
}

// Whether the runtime knows the IANA time zone. A saved zone it does not know would make the
// scheduler tick fail, and the app would then refuse to start.
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// An edit of the facts that changed at least one of them. The Facts redraft (T90) listens.
export type HouseholdFactsEdit = {
  previous: HouseholdFacts;
  facts: HouseholdFacts;
  memberId: string;
};

type EditListener = (edit: HouseholdFactsEdit) => Promise<void> | void;

const listeners = new Set<EditListener>();

// The facts-edited hook. It fires after each saved edit that changes a fact, never for the first
// facts the wizard records. Returns a function that removes the listener again.
export function onHouseholdFactsEdited(listener: EditListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sameFacts(a: HouseholdFactsInput, b: HouseholdFactsInput): boolean {
  return (
    a.zipCode === b.zipCode &&
    a.rentOrOwn === b.rentOrOwn &&
    a.ages.length === b.ages.length &&
    a.ages.every((age, index) => age === b.ages[index])
  );
}

export type SaveFactsResult = { saved: HouseholdFacts } | "unknown zip code";

// Saves the facts, which changes the Household time zone at once: the scheduler's next tick moves
// each task's next run to the new zone. The first save also marks the wizard's step 4 done.
export async function saveHouseholdFacts(
  database: Database,
  input: HouseholdFactsInput,
  memberId: string,
  at = new Date(),
): Promise<SaveFactsResult> {
  const place = lookUpZipCode(input.zipCode);
  if (place === undefined) return "unknown zip code";
  if (!isKnownTimeZone(place.timeZone)) {
    throw new Error(`The ZIP table gives a time zone this runtime does not know.`);
  }
  const previous = await readHouseholdFacts(database);
  const facts: HouseholdFacts = {
    zipCode: input.zipCode,
    ages: [...input.ages],
    rentOrOwn: input.rentOrOwn,
    state: place.state,
    timeZone: place.timeZone,
    updatedAt: at,
  };
  await storeHouseholdFacts(database, { ...facts, updatedBy: memberId });
  if (previous !== undefined && !sameFacts(previous, facts)) {
    log.info("A Member edited the Household facts");
    for (const listener of listeners) {
      try {
        await listener({ previous, facts: { ...facts }, memberId });
      } catch (error) {
        // The error's name only: its message or stack can repeat a value from the listener.
        log.error("A Household facts listener failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
  return { saved: facts };
}
