import type { Database } from "../db/index.ts";
import { comingUp } from "../recurring/index.ts";
import type { ComingUpRoutes, ComingUpView } from "./coming-up-views.ts";

// "Coming up" on the dashboard (spec 07, 6. Coming up), as the recurring module finds it. The rows
// go to the browser without the Account IDs, which only the Household summary reads.
export function comingUpRoutes(database: Database): ComingUpRoutes {
  return {
    async view(now = new Date()): Promise<ComingUpView> {
      const found = await comingUp(database, now);
      return { ...found, rows: found.rows.map(({ accountId: _, ...row }) => row) };
    },
  };
}
