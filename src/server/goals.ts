import { type Database, listMemberNamesById, readAiSettings } from "../db/index.ts";
import { listGoalsWithProgress, markGoal } from "../goals/index.ts";
import type { GoalRoutes, GoalView } from "./goals-views.ts";

// The Goal routes (spec 05, Goals): every Goal with its progress and its author's name, and a
// Member's mark of done or dropped, through the goals module.
export function goalRoutes(database: Database): GoalRoutes {
  async function list(): Promise<GoalView[]> {
    const goals = await listGoalsWithProgress(database);
    const names = new Map((await listMemberNamesById(database)).map(({ id, name }) => [id, name]));
    return goals.map((goal) => ({
      ...goal,
      author: goal.authorId === null ? null : (names.get(goal.authorId) ?? null),
    }));
  }

  return {
    list,
    async aiProvider() {
      return (await readAiSettings(database)) !== undefined;
    },
    async mark(id, status, memberId) {
      const marked = await markGoal(database, id, status, memberId);
      if (marked !== "marked") return marked;
      return (await list()).find((goal) => goal.id === id);
    },
  };
}
