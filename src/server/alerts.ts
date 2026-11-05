import { alertList } from "../anomalies/index.ts";
import type { Database } from "../db/index.ts";
import type { AlertRoutes } from "./alerts-views.ts";

// The Alert list route, through the anomalies module.
export function alertRoutes(database: Database): AlertRoutes {
  return {
    async list() {
      return (await alertList(database)).map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        createdAt: alert.createdAt.toISOString(),
        text: alert.text,
        facts: alert.facts,
        transactionIds: alert.transactionIds,
        category: alert.category,
        advice: alert.advice,
        notAProblem: alert.notAProblem.map((press) => ({
          memberId: press.memberId,
          pressedAt: press.pressedAt.toISOString(),
        })),
        state: alert.state,
      }));
    },
  };
}
