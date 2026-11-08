import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { findRecurringCharges } from "../../recurring/index.ts";
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

// A Member's edits to a Recurring charge (spec 06, Member edits). Each request runs the checks on
// the charge's Merchant; then the follow-up job runs the cascade and the checks on the whole
// history, which keep every edit.
timedCase("Member edits to a Recurring charge", async (history, time) => {
  const { charges } = (await (await history.browser.get("/api/recurring-charges")).json()) as {
    charges: RecurringChargeView[];
  };
  const streaming = charges.find(
    (charge) => charge.merchantName === "Streamflix" && charge.status === "active",
  );
  if (streaming === undefined) throw new Error("The history has no active Streamflix charge.");
  const path = `/api/recurring-charges/${streaming.id}`;
  const candidatesOf = async (id: string) =>
    (
      (await (await history.browser.get(`/api/recurring-charges/${id}/candidates`)).json()) as {
        candidates: { transactionId: string }[];
      }
    ).candidates;

  const named = (await time.request("PUT /api/recurring-charges/:id", () =>
    history.browser.send("PUT", path, {
      name: "Movie nights",
      category: "Entertainment",
      priceBand: 5,
    }),
  )) as { charge: RecurringChargeView };
  expect(named.charge.name).toBe("Movie nights");

  const priced = (await time.request("POST /api/recurring-charges/:id/price-changes", () =>
    history.browser.send("POST", `${path}/price-changes`, {
      fromDate: streaming.nextExpectedDate,
      amount: streaming.latestAmount + 200,
    }),
  )) as { charge: RecurringChargeView };
  const [change] = priced.charge.priceChanges.filter((each) => each.byHand);

  const { candidates } = (await time.request("GET /api/recurring-charges/:id/candidates", () =>
    history.browser.get(`${path}/candidates`),
  )) as { candidates: { transactionId: string }[] };
  // An add, on the first Recurring charge whose Merchant has posted Spending outside it.
  let adding: { id: string; transactionId: string } | undefined;
  for (const each of [streaming, ...charges]) {
    const found = each === streaming ? candidates : await candidatesOf(each.id);
    const [candidate] = found;
    if (each.status !== "ended" && candidate !== undefined) {
      adding = { id: each.id, transactionId: candidate.transactionId };
      break;
    }
  }
  if (adding === undefined) throw new Error("No Recurring charge has a Transaction to add.");
  const { id, transactionId } = adding;
  await time.request("POST /api/recurring-charges/:id/transactions", () =>
    history.browser.send("POST", `/api/recurring-charges/${id}/transactions`, { transactionId }),
  );
  const [first] = priced.charge.priceHistory;
  await time.request("DELETE /api/recurring-charges/:id/transactions/:transactionId", () =>
    history.browser.send("DELETE", `${path}/transactions/${first?.transactionId ?? ""}`),
  );
  await time.request("DELETE /api/recurring-charges/:id/price-changes/:changeId", () =>
    history.browser.send("DELETE", `${path}/price-changes/${change?.id ?? ""}`),
  );

  await time.job("Follow-up after a Recurring charge's edits", 20_000, () => runFollowUp());
  await time.job("Recurring charge checks with an edited one", 20_000, () =>
    findRecurringCharges(history.database, new Date()),
  );
  const { transactions } = (await time.request("GET /api/transactions with a named charge", () =>
    history.browser.get("/api/transactions?merchant=Streamflix"),
  )) as { transactions: { recurringChargeName: string | null }[] };
  expect(transactions.some((txn) => txn.recurringChargeName === "Movie nights")).toBe(true);
});
