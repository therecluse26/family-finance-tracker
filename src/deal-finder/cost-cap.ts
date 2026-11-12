import { addPriceSourceCost, type Database, readPriceSourceCost } from "../db/index.ts";

// The Price source cost cap, held before each Actor run (spec 15, Cost and limits). Every Actor run
// sets `maxTotalChargeUsd=1.00`, so one run can cost up to $1.00. Before a run starts, it takes its
// place under the cap: the month's cost, plus the places runs in flight hold, plus its own $1.00,
// must be at or below the cap. With a $5.00 cap, runs stop starting once the month's cost passes
// $4.00. The check and the place are taken in one synchronous step, so runs fired in parallel never
// pass the cap together (K18). When the run ends, its cost counts toward the month and its place is
// given back, in that order, so no other run's check sees neither.
//
// A run of the Scraping service is one adapter call: each call starts at most one Actor run, and
// Find Stores near us starts at most FIND_STORES_RUNS.

// One Actor run's worst case, its `maxTotalChargeUsd`, in billionths of a dollar.
export const RUN_WORST_NANOS = 1_000_000_000;
// The Actor runs one Find Stores near us starts: Target's, Costco's and the weekly ads' lookups.
export const FIND_STORES_RUNS = 3;

// A run's place under the cap. `end` counts what the run cost, from its result or its error, and
// gives the place back. It runs once; a later call does nothing.
export type CapPlace = { end(costNanos: number | null | undefined): Promise<void> };

export type PriceSourceCostCap = {
  // Takes `runs` places under the cap for this month, YYYY-MM, or answers null when they do not
  // fit. The cap is in cents.
  hold(month: string, capCents: number, runs?: number): Promise<CapPlace | null>;
  // A place for a free call, such as the Kroger API's: it holds nothing, and counts any cost.
  free(month: string): CapPlace;
};

// One cap for each database, shared by the plan run and Find Stores near us, so neither can pass
// the cap while the other holds places.
const caps = new WeakMap<Database, PriceSourceCostCap>();

export function priceSourceCostCap(database: Database): PriceSourceCostCap {
  const known = caps.get(database);
  if (known !== undefined) return known;
  // The places runs in flight hold, and the cost this cap counted, in billionths of a dollar.
  let held = 0;
  let added = 0;

  const place = (month: string, holds: number): CapPlace => {
    let ended = false;
    return {
      async end(costNanos) {
        if (ended) return;
        ended = true;
        try {
          if (typeof costNanos === "number" && costNanos > 0) {
            await addPriceSourceCost(database, month, costNanos);
            added += costNanos;
          }
        } finally {
          held -= holds;
        }
      },
    };
  };

  const cap: PriceSourceCostCap = {
    async hold(month, capCents, runs = 1) {
      const worst = runs * RUN_WORST_NANOS;
      // A cost counted while the month's cost was read counts too.
      const addedBefore = added;
      const spent = (await readPriceSourceCost(database, month)) + (added - addedBefore);
      if (spent + held + worst > capCents * 10_000_000) return null;
      held += worst;
      return place(month, worst);
    },
    free: (month) => place(month, 0),
  };
  caps.set(database, cap);
  return cap;
}

// Thrown inside the plan run when an Actor run did not fit under the cap. It never leaves the plan
// run: the Store's read ends with "cost cap reached".
export class CostCapReached extends Error {
  override name = "CostCapReached";
}
