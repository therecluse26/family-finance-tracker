// What the Household facts routes answer. This file imports nothing, so the web app's type check
// can follow it through api.ts.

export type HouseholdFactsView = {
  zipCode: string;
  // Each person's age in years, people without a login included.
  ages: number[];
  rentOrOwn: "rent" | "own";
  state: string;
  // The Household time zone, an IANA name such as America/New_York.
  timeZone: string;
  updatedAt: string;
};

export type HouseholdFactsBody = {
  zipCode: string;
  ages: number[];
  rentOrOwn: "rent" | "own";
};

export type HouseholdRoutes = {
  // Null until the wizard's step 4 is done.
  facts(): Promise<HouseholdFactsView | null>;
  save(
    body: HouseholdFactsBody,
    memberId: string,
  ): Promise<HouseholdFactsView | "unknown zip code">;
};
