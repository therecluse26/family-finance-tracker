import type { Database } from "../db/index.ts";
import { type HouseholdFacts, readHouseholdFacts, saveHouseholdFacts } from "../household/index.ts";
import type { HouseholdFactsView, HouseholdRoutes } from "./household-views.ts";

// The Household facts routes, through the household module. Only the Members' own pages get the
// facts; no AI provider ever does.
export function householdRoutes(database: Database): HouseholdRoutes {
  const view = (facts: HouseholdFacts): HouseholdFactsView => ({
    zipCode: facts.zipCode,
    ages: facts.ages,
    rentOrOwn: facts.rentOrOwn,
    state: facts.state,
    timeZone: facts.timeZone,
    updatedAt: facts.updatedAt.toISOString(),
  });

  return {
    async facts() {
      const facts = await readHouseholdFacts(database);
      return facts === undefined ? null : view(facts);
    },

    async save(body, memberId) {
      const result = await saveHouseholdFacts(database, body, memberId);
      return result === "unknown zip code" ? result : view(result.saved);
    },
  };
}
