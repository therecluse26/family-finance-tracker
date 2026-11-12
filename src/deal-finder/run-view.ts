// What the page shows of a plan run (spec 15, The Shopping plan): the cost to confirm before a full
// search, and each Store's progress while the job works. The server and the browser both import
// these, so they hold no code that needs the server.

// Each Store's progress in a plan run.
// - waiting: its turn has not come.
// - reading: its reader is working.
// - read: it read every price it needed.
// - stored prices: nothing was due, as every price was read in the last 24 hours, so it keeps its
//   stored prices.
// - skipped: it was not read, with the reason, such as "Needs your ZIP code".
// - failed: it could not be read after one retry, with the reason.
export type PlanRunStoreState =
  | "waiting"
  | "reading"
  | "read"
  | "stored prices"
  | "skipped"
  | "failed";

export type PlanRunStoreProgress = {
  storeId: string;
  name: string;
  state: PlanRunStoreState;
  reason: string | null;
};

// reading: the Stores are read; matching: the AI matches List items to Products; building: app code
// builds the plan; done or failed: the run ended.
export type PlanRunPhase = "reading" | "matching" | "building" | "done" | "failed";

export type PlanRunView = {
  planId: string;
  running: boolean;
  phase: PlanRunPhase;
  startedAt: string;
  finishedAt: string | null;
  stores: PlanRunStoreProgress[];
};

// The expected cost of a plan run, from the measured prices (spec 15, Cost and limits). In
// billionths of a dollar, as the month's cost is.
export type PlanRunCost = {
  // Whether the run holds a full search at a Store that charges. Only then does it wait for a
  // Member to confirm.
  fullSearch: boolean;
  costNanos: number;
  monthCostNanos: number;
  capCents: number;
};

export type PlanRunStart =
  | { outcome: "started" | "joined"; run: PlanRunView }
  | { outcome: "confirm"; cost: PlanRunCost }
  | { outcome: "no items" }
  | { outcome: "no stores" };

// The reasons a Store shows when it was not read.
export const NEEDS_ZIP = "Needs your ZIP code";
export const FIND_STORES_AGAIN = "Its Home store is made up. Find Stores near us again";
export const COULD_NOT_READ = "Could not read this store";
export const COST_CAP_REACHED =
  "The Price source cost cap is reached. Stored prices until the 1st.";
export const SOURCE_REASONS = {
  apify: {
    "refused key": "Apify refused the token",
    "usage limit": "Apify usage limit reached",
    "no key": "Save the Apify token on the Price sources page",
  },
  kroger: {
    "refused key": "Kroger refused the keys",
    "usage limit": "Kroger usage limit reached",
    "no key": "Save the Kroger keys on the Price sources page",
  },
} as const;
