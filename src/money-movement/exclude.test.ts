import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, demoRecords, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { linkTransferByHand, listConnections, setHandSetFields } from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import { openReviewItems } from "../review/index.ts";
import {
  type MonthTotals,
  readTransactionDecision,
  startMoneyMovement,
  switchExclude,
  totalsByMonth,
} from "./index.ts";

// The Exclude switch (spec 02, Exclude; spec 03, Transaction types), on the demo Household,
// through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const accountOf = (bankId: string, index = 0) =>
  DEMO_BANKS.find((demo) => demo.bankId === bankId)?.accounts[index]?.id ?? "";
const CHASE_CARD = accountOf("fake-chase");
const CHECKING = accountOf("fake-ally");
const SAVINGS = accountOf("fake-ally", 1);

describe("the Exclude switch", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const accountIdOf = async (providerAccountId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerAccountId],
    });
    return String(rows.rows[0]?.id);
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const exclude = async (providerAccountId: string, excluded: boolean) => {
    expect(await switchExclude(bank.database, await accountIdOf(providerAccountId), excluded)).toBe(
      true,
    );
    await runFollowUp(NOW);
  };
  const assignedTo = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT account_id FROM unconnected_assignments WHERE transaction_id = ?",
      args: [await idOf(providerId)],
    });
    return rows.rows[0] === undefined ? null : String(rows.rows[0].account_id);
  };
  const month = (totals: MonthTotals[], name: string) => totals.find((t) => t.month === name);
  const syncMore = async (bankId: string, page: FakePage) => {
    bank.fake.addPages(bankId, page);
    const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
    await syncConnection(connection?.id ?? "", NOW);
    await runFollowUp(NOW);
  };
  // The demo's posted records on an Account.
  const linesOn = (accountId: string) =>
    demoRecords().filter((record) => record.accountId === accountId && !record.pending);

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await seedDemoHousehold(bank.database, bank.fake, NOW);
    await runFollowUp(NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("takes an excluded card's purchases out of every total, and turning it off restores them", async () => {
    const before = await totalsByMonth(bank.database);
    const purchases = linesOn(CHASE_CARD).filter(
      (line) => line.amount < 0 && line.postedDate.startsWith("2026-09"),
    );
    expect(purchases.length).toBeGreaterThan(0);
    const spentOnCard = purchases.reduce((sum, line) => sum - line.amount, 0);
    const shownOnCard = async () =>
      Number(
        (
          await bank.database.$client.execute({
            sql: "SELECT count(*) AS n FROM transactions WHERE account_id = ? AND hidden_reason IS NULL",
            args: [await accountIdOf(CHASE_CARD)],
          })
        ).rows[0]?.n,
      );
    const shownBefore = await shownOnCard();

    await exclude(CHASE_CARD, true);

    const excluded = await totalsByMonth(bank.database);
    expect(month(excluded, "2026-09")?.spending).toBe(
      (month(before, "2026-09")?.spending ?? 0) - spentOnCard,
    );
    for (const line of linesOn(CHASE_CARD)) {
      expect((await decisionOf(line.id))?.parts.map((part) => part.type)).toEqual(["Transfer"]);
    }
    // The app keeps them.
    expect(await shownOnCard()).toBe(shownBefore);

    await exclude(CHASE_CARD, false);

    expect(await totalsByMonth(bank.database)).toEqual(before);
  });

  it("makes a payment from Ally to an excluded card a Transfer", async () => {
    const payments = demoRecords().filter((line) =>
      line.description.startsWith("PAYMENT TO CHASE CARD"),
    );
    expect(payments.length).toBeGreaterThan(0);

    await exclude(CHASE_CARD, true);

    for (const line of payments) {
      expect((await decisionOf(line.id))?.parts).toEqual([
        { type: "Transfer", amount: line.amount, category: null },
      ]);
    }
    // A payment that arrives later is a Transfer too, and the card still syncs.
    await syncMore("fake-chase", {
      added: [
        fakeTxn({
          id: "new-purchase",
          accountId: CHASE_CARD,
          amount: -7_700,
          postedDate: "2026-10-30",
          description: "TST* LATE DINNER",
        }),
      ],
    });
    expect((await decisionOf("new-purchase"))?.parts).toEqual([
      { type: "Transfer", amount: -7_700, category: null },
    ]);
  });

  it("makes money to an excluded savings Account a Transfer, and drops its own Income", async () => {
    const before = await totalsByMonth(bank.database);
    const interest = linesOn(SAVINGS).filter(
      (line) => line.description === "Interest Paid" && line.postedDate.startsWith("2026-09"),
    );
    const toSavings = demoRecords().filter((line) =>
      line.description.startsWith("Internet transfer to Online Savings"),
    );

    await exclude(SAVINGS, true);

    const after = await totalsByMonth(bank.database);
    expect(month(after, "2026-09")?.income).toBe(
      (month(before, "2026-09")?.income ?? 0) -
        interest.reduce((sum, line) => sum + line.amount, 0),
    );
    // Each keeps its pair with the excluded Account's side.
    for (const line of toSavings) {
      expect(await decisionOf(line.id)).toMatchObject({
        step: "3",
        parts: [{ type: "Transfer", amount: line.amount, category: null }],
      });
      expect(await assignedTo(line.id)).toBeNull();
    }
    expect(month(after, "2026-09")?.saving).toBe(month(before, "2026-09")?.saving);

    // One with no pair names the excluded Account by its last 4 digits, so it is tied to it, with
    // no item.
    await syncMore("fake-ally", {
      added: [
        fakeTxn({
          id: "lone-to-savings",
          accountId: CHECKING,
          amount: -31_700,
          postedDate: "2026-10-28",
          description: "Internet transfer to Online Savings account XXXXXX8802",
          category: {
            name: "TRANSFER_OUT_ACCOUNT_TRANSFER",
            confidence: "VERY_HIGH",
            version: "v2",
            mcc: null,
          },
        }),
      ],
    });
    expect((await decisionOf("lone-to-savings"))?.parts).toEqual([
      { type: "Transfer", amount: -31_700, category: null },
    ]);
    expect(await assignedTo("lone-to-savings")).toBe(await accountIdOf(SAVINGS));
    const asked = new Set(
      (await openReviewItems(bank.database)).flatMap((item) =>
        item.subject.type === "transactions" ? item.subject.transactionIds : [],
      ),
    );
    expect(asked.has(await idOf("lone-to-savings"))).toBe(false);
  });

  // Spec 03, Undo and hand links: re-matching never ends a hand-made link (K12). Neither pair has
  // transfer wording or a Plaid code, so only its link makes it a Transfer.
  it("keeps a hand link and an app link to an excluded card, and the totals with them", async () => {
    await exclude(CHASE_CARD, true);
    const excludedAlone = await totalsByMonth(bank.database);
    await exclude(CHASE_CARD, false);

    await syncMore("fake-ally", {
      added: [
        fakeTxn({
          id: "hand-out",
          accountId: CHECKING,
          amount: -12_345,
          postedDate: "2026-10-27",
          description: "MISC DEBIT 0099",
        }),
        fakeTxn({
          id: "app-out",
          accountId: CHECKING,
          amount: -45_600,
          postedDate: "2026-10-27",
          description: "ONLINE PMT 7731",
        }),
      ],
    });
    await syncMore("fake-chase", {
      added: [
        fakeTxn({
          id: "hand-in",
          accountId: CHASE_CARD,
          amount: 12_345,
          postedDate: "2026-10-28",
          description: "ONLINE CREDIT",
        }),
        fakeTxn({
          id: "app-in",
          accountId: CHASE_CARD,
          amount: 45_600,
          postedDate: "2026-10-28",
          description: "ONLINE CREDIT THANK YOU",
        }),
      ],
    });
    // The Accounts' earlier card payments make both pairs Strong, so the app links them. A Member
    // then links the first one by hand, as accepting a Review list item does.
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    const hand = {
      outTransactionId: await idOf("hand-out"),
      inTransactionId: await idOf("hand-in"),
    };
    await linkTransferByHand(bank.database, hand, { memberId: "member-1", at: NOW() });
    await followUpAgain(bank.database, [hand.outTransactionId, hand.inTransactionId]);
    await runFollowUp(NOW);
    const links = async () =>
      (
        await bank.database.$client.execute(
          `SELECT o.provider_transaction_id AS out_id, l.made_by FROM transfer_links l
           JOIN transactions o ON o.id = l.out_transaction_id
           WHERE o.provider_transaction_id IN ('hand-out', 'app-out')
           ORDER BY o.provider_transaction_id`,
        )
      ).rows.map((row) => `${row.out_id} ${row.made_by}`);
    const linked = ["app-out app", "hand-out Member"];
    expect(await links()).toEqual(linked);
    const before = await totalsByMonth(bank.database);
    const outSides = async () =>
      Promise.all(["hand-out", "app-out"].map(async (id) => (await decisionOf(id))?.parts));
    const transfers = [
      [{ type: "Transfer", amount: -12_345, category: null }],
      [{ type: "Transfer", amount: -45_600, category: null }],
    ];
    expect(await outSides()).toEqual(transfers);

    await exclude(CHASE_CARD, true);

    expect(await links()).toEqual(linked);
    expect(await outSides()).toEqual(transfers);
    expect(await totalsByMonth(bank.database)).toEqual(excludedAlone);

    await exclude(CHASE_CARD, false);

    expect(await links()).toEqual(linked);
    expect(await outSides()).toEqual(transfers);
    expect(await totalsByMonth(bank.database)).toEqual(before);
  });

  it("keeps a hand-set type out of the totals while the switch is on, and back once it is off", async () => {
    const [dinner] = linesOn(CHASE_CARD).filter((line) => line.amount < 0);
    const id = await idOf(dinner?.id ?? "");
    await setHandSetFields(bank.database, id, { type: "Spending" });
    await followUpAgain(bank.database, [id]);
    await runFollowUp(NOW);
    expect((await decisionOf(dinner?.id ?? ""))?.step).toBe("1");

    await exclude(CHASE_CARD, true);
    expect((await decisionOf(dinner?.id ?? ""))?.parts[0]?.type).toBe("Transfer");

    await exclude(CHASE_CARD, false);
    expect((await decisionOf(dinner?.id ?? ""))?.step).toBe("1");
  });

  it("does nothing for an unknown Account, or a switch already in place", async () => {
    expect(await switchExclude(bank.database, "no-such-account", true)).toBe(false);
    const asked = bank.followUpsAsked();
    expect(await switchExclude(bank.database, await accountIdOf(CHASE_CARD), false)).toBe(true);
    expect(bank.followUpsAsked()).toBe(asked);
  });
});
