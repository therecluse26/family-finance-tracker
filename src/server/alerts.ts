import { markNotAProblem, mergedAlertList, setWeeklyCap, weeklyCap } from "../anomalies/index.ts";
import type { Database } from "../db/index.ts";
import type { AlertRoutes } from "./alerts-views.ts";

// The Alert list and Settings, Alerts routes, through the anomalies module.
export function alertRoutes(database: Database): AlertRoutes {
  return {
    async list() {
      return (await mergedAlertList(database)).map((alert) => ({
        id: alert.id,
        kind: alert.kind,
        createdAt: alert.createdAt.toISOString(),
        heading: alert.heading,
        parts: alert.parts.map((part) => ({
          id: part.id,
          createdAt: part.createdAt.toISOString(),
          text: part.text,
          facts: part.facts,
          transactionIds: part.transactionIds,
          category: part.category,
          advice: part.advice,
          notAProblem: part.notAProblem.map((press) => ({
            memberId: press.memberId,
            pressedAt: press.pressedAt.toISOString(),
          })),
        })),
        state: alert.state,
      }));
    },

    async notAProblem(alertId, memberId) {
      const presses = await markNotAProblem(database, alertId, memberId);
      return presses?.map((press) => ({
        memberId: press.memberId,
        pressedAt: press.pressedAt.toISOString(),
      }));
    },

    async settings() {
      return { weeklyCap: await weeklyCap(database) };
    },

    async setWeeklyCap(cap) {
      return { weeklyCap: await setWeeklyCap(database, cap) };
    },
  };
}
