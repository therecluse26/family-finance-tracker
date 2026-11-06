import { expect } from "vitest";
import type { ConnectionView } from "../../server/bank-views.ts";
import { timedCase } from "../index.ts";

// Settings → Banks' Connection list, with whether the fake adapter runs, over the whole history.
timedCase("the Connection list", async (history, time) => {
  const listed = (await time.request("GET /api/connections (Connection list)", () =>
    history.browser.get("/api/connections"),
  )) as { connections: ConnectionView[]; fakeBank: boolean };

  expect(listed.connections.length).toBeGreaterThan(0);
  expect(typeof listed.fakeBank).toBe("boolean");
});
