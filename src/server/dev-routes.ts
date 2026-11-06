import { Hono } from "hono";
import { DEMO_BANKS } from "../bank/demo.ts";
import { bankConnecting } from "../bank/index.ts";
import { type Database, listConnections } from "../db/index.ts";
import { jsonOnly } from "./app.ts";
import type { ServerEnv } from "./env.ts";

// `pnpm dev` only: routes the built app never has. Only createDevApp mounts them, under /api/dev,
// behind the same session, Origin, and JSON checks as every other write.
export function devRoutes(database: Database) {
  const linking = bankConnecting("fake");
  return (
    new Hono<ServerEnv>()
      // "Link a fake bank (dev only)": links the next demo bank that has no Connection through the
      // fake adapter, by the same link path as Plaid's, so its first sync, history load, and
      // follow-up jobs run as for a real bank. The bank comes from the demo data, never from the
      // request.
      .post("/fake-bank", jsonOnly, async (c) => {
        const live = (await listConnections(database)).filter(
          (connection) => connection.removedAt === null,
        );
        const next = DEMO_BANKS.find(
          (demo) => !live.some((connection) => connection.bankId === demo.bankId),
        );
        if (next === undefined) return c.json({ error: "Every fake bank is linked." }, 409);
        const started = await linking.startLink({});
        if (started.outcome !== "ready") {
          return c.json({ error: "The fake bank did not start a link." }, 502);
        }
        const linked = await linking.finishLink(
          {
            publicToken: started.linkToken,
            bankId: next.bankId,
            bankName: next.bankName,
            accounts: next.accounts.map(({ name, type, subtype, mask }) => ({
              name,
              type,
              subtype,
              mask,
            })),
          },
          {},
        );
        if (linked.outcome === "linked") {
          return c.json(
            { connection: { id: linked.connectionId, bankName: linked.bankName } },
            200,
          );
        }
        if (linked.outcome === "duplicate") {
          return c.json({ error: `${linked.coveredBy.bankName} is already linked.` }, 409);
        }
        return c.json({ error: "The fake bank was not linked." }, 409);
      })
  );
}
