import { expect } from "vitest";
import { fakeTxn } from "../../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../../bank/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { addMonths, findRecurringCharges } from "../../recurring/index.ts";
import type {
  RecurringChargeCandidatesView,
  RecurringChargeView,
} from "../../server/recurring-views.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");

// A masked Merchant on top of the full history: 5 years of Privacy.com lines on a credit card, 3
// monthly subscriptions, one with a price change, and about 1,800 one-off purchases at many
// amounts. The follow-up job decides them (Categorization, with no Merchant history) and replays
// the Merchant's Recurring charges, whose continuing looks ahead for a price change.
timedCase("a masked Merchant's 5 years", async (history, time) => {
  const bank = history.generated.banks.find((each) =>
    each.accounts.some((account) => account.type === "credit"),
  );
  const card = bank?.accounts.find((account) => account.type === "credit");
  if (bank === undefined || card === undefined) throw new Error("The history has no card.");
  const line = (id: string, postedDate: string, spent: number, description: string): TxnRecord =>
    fakeTxn({
      id: `lh-masked-${id}`,
      accountId: card.id,
      amount: -spent,
      postedDate,
      description,
      merchantName: null,
      category: null,
    });
  const added: TxnRecord[] = [];
  for (let month = 0; month < 60; month += 1) {
    added.push(
      line(`a-${month}`, addMonths("2021-11-03", month), 999, "PWP*PRIVACY.COM"),
      line(`b-${month}`, addMonths("2021-11-12", month), month < 40 ? 1_549 : 1_799, "PRIVACY.COM"),
      line(`c-${month}`, addMonths("2021-11-20", month), 5_400, "PRIVACYCOM*SHOP"),
    );
  }
  // One-offs: one about every day, from $3 to $200, seeded so each run is the same.
  let seed = 7;
  const next = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  for (let day = 0; day < 1_800; day += 1) {
    const date = new Date(Date.UTC(2021, 10, 1 + day)).toISOString().slice(0, 10);
    added.push(line(`one-${day}`, date, 300 + Math.floor(next() * 19_700), "PWP*PRIVACY.COM"));
  }
  history.fake.addPages(bank.bankId, { added });

  const connectionId = history.connectionIds.get(bank.bankId) ?? "";
  await time.job("Sync of 1,980 Privacy.com lines", 5_000, () => syncConnection(connectionId, NOW));
  await time.job("Follow-up after 1,980 Privacy.com lines", 20_000, () => runFollowUp(NOW));

  // The Recurring charge checks alone, again, on the whole history, with the build's limit for them.
  await time.job("Recurring charge checks with a masked Merchant", 20_000, () =>
    findRecurringCharges(history.database, NOW()),
  );

  const named = await history.database.$client.execute(
    "SELECT count(*) AS n FROM transactions WHERE merchant_clean_name = 'Privacy.com'",
  );
  expect(Number(named.rows[0]?.n)).toBe(added.length);

  // A Member names the $17.99 one. The checks then continue it as an edited one, beside the
  // Merchant's other series, and a Member looks for an old one-off at one exact amount.
  const { charges } = (await (await history.browser.get("/api/recurring-charges")).json()) as {
    charges: RecurringChargeView[];
  };
  const kept = charges.find(
    (charge) => charge.merchantName === "Privacy.com" && charge.latestAmount === 1_799,
  );
  if (kept === undefined) throw new Error("No $17.99 Privacy.com Recurring charge.");
  const path = `/api/recurring-charges/${kept.id}`;
  await history.browser.send("PUT", path, { name: "Streaming" });
  await time.job("Recurring charge checks with a named masked Merchant", 20_000, () =>
    findRecurringCharges(history.database, NOW()),
  );
  const oneOff = added.find((txn) => txn.id === "lh-masked-one-90");
  const amount = -(oneOff?.amount ?? 0);
  const page = (await time.request(
    "GET /api/recurring-charges/:id/candidates?amount= (masked Merchant)",
    () => history.browser.get(`${path}/candidates?amount=${amount}`),
  )) as RecurringChargeCandidatesView;
  expect(page.candidates.length).toBeGreaterThan(0);
  expect(page.candidates.every((each) => each.amount === amount)).toBe(true);
  const newest = (await (
    await history.browser.get(`${path}/candidates`)
  ).json()) as RecurringChargeCandidatesView;
  expect(newest.more).toBe(true);
  const older = (await time.request(
    "GET /api/recurring-charges/:id/candidates?before= (masked Merchant)",
    () =>
      history.browser.get(`${path}/candidates?before=${newest.candidates.at(-1)?.transactionId}`),
  )) as RecurringChargeCandidatesView;
  expect(older.candidates).toHaveLength(50);
});
