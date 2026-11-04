import { expect } from "vitest";
import type { RecurringChargeView } from "../../server/recurring-views.ts";
import { timedCase } from "../index.ts";

// The Recurring charges page, and a Member marking one ended.
timedCase("Recurring charges", async (history, time) => {
  const { charges } = (await time.request("GET /api/recurring-charges", () =>
    history.browser.get("/api/recurring-charges"),
  )) as { charges: RecurringChargeView[] };
  const streaming = charges.find(
    (charge) => charge.merchantName === "Streamflix" && charge.status === "active",
  );
  if (streaming === undefined) throw new Error("The history has no active Streamflix charge.");

  const { charge } = (await time.request("POST /api/recurring-charges/:id/end", () =>
    history.browser.post(`/api/recurring-charges/${streaming.id}/end`, {}),
  )) as { charge: RecurringChargeView };
  expect(charge.status).toBe("ended");
});
