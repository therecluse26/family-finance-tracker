import type { Database } from "../db/index.ts";
import { listGoalsWithProgress, markGoal } from "../goals/index.ts";
import type { GoalRoutes } from "./goals-views.ts";

// The Goal routes (spec 05, Goals): every Goal with its progress, and a Member's mark of done or
// dropped, through the goals module.
export function goalRoutes(database: Database): GoalRoutes {
  return {
    list: () => listGoalsWithProgress(database),
    async mark(id, status, memberId) {
      const marked = await markGoal(database, id, status, memberId);
      if (marked !== "marked") return marked;
      return (await listGoalsWithProgress(database)).find((goal) => goal.id === id);
    },
  };
}
