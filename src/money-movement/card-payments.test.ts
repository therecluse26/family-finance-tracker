import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BANKS, DEMO_PINECREST, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { CATEGORY_GROUPS } from "../categories/index.ts";
import { linkTransferByHand, listConnections, markConnectionRemoved } from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { openReviewItems } from "../review/index.ts";
import {
  decideProvisionalAgain,
  readTransactionDecision,
  runMatching,
  startMoneyMovement,
  totalsByMonth,
} from "./index.ts";

// Card payments with no pair and card rewards (spec 03, One side missing, Card rewards), on the
// demo Household, through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const at = (date: string) => () => new Date(`${date}T15:00:00.000Z`);
const accountOf = (bankId: string) =>
  DEMO_BANKS.find((demo) => demo.bankId === bankId)?.accounts[0]?.id ?? "";
const CHECKING = accountOf("fake-ally");
const CHASE_CARD = accountOf("fake-chase");
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

describe("card payments and card rewards", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const assignedTo = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT account_id FROM unconnected_assignments WHERE transaction_id = ?",
      args: [await idOf(providerId)],
    });
    return rows.rows[0] === undefined ? null : String(rows.rows[0].account_id);
  };
  const itemOf = async (providerId: string) => {
    const id = await idOf(providerId);
    return (await openReviewItems(bank.database)).find(
      (item) => item.subject.type === "transactions" && item.subject.transactionIds.includes(id),
    );
  };
  // Syncs one more page into a demo bank. The follow-up job runs unless `match` is false.
  const syncMore = async (bankId: string, page: FakePage, now = NOW, match = true) => {
    bank.fake.addPages(bankId, page);
    const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
    await syncConnection(connection?.id ?? "", now);
    if (match) await runFollowUp(now);
  };
  const payment = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount,
      postedDate,
      description,
      category: { name: CARD_PAYMENT, confidence: "VERY_HIGH", version: "v2", mcc: null },
    });
  const onCard = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({ id, accountId: CHASE_CARD, amount, postedDate, description });
  const transfer = (amount: number) => [{ type: "Transfer", amount, category: null }];

  beforeEach(async () => {
    // The follow-up job reads the clock for the Household's date.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW());
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await seedDemoHousehold(bank.database, bank.fake, NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
    vi.useRealTimers();
  });

  describe("a payment to a card the app tracks", () => {
    it("is a Transfer to the card its last 4 digits name", async () => {
      await syncMore("fake-ally", {
        added: [payment("to-chase", -12_345, "2026-10-28", "PAYMENT TO CHASE CARD ENDING IN 7731")],
      });

      expect(await decisionOf("to-chase")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: transfer(-12_345),
      });
    });

    it("is a Transfer to a card at the institution it names, when it holds no last 4 digits", async () => {
      await syncMore("fake-ally", {
        added: [payment("to-capital-one", -23_456, "2026-10-28", "CAPITAL ONE MOBILE PMT")],
      });

      expect(await decisionOf("to-capital-one")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: transfer(-23_456),
      });
    });

    it("still counts as tracked when the card's Connection is broken", async () => {
      await bank.database.$client.execute(
        "UPDATE connections SET health = 'broken' WHERE bank_id = 'fake-chase'",
      );
      await syncMore("fake-ally", {
        added: [
          payment("to-broken", -34_567, "2026-10-28", "PAYMENT TO CHASE CARD ENDING IN 7731"),
        ],
      });

      expect(await decisionOf("to-broken")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: transfer(-34_567),
      });
    });
  });

  describe("a payment to a card the app does not track", () => {
    it("is a Transfer for 4 business days, then Spending in Miscellaneous", async () => {
      // Monday, Oct 26. Its fourth business day is Friday, Oct 30.
      const posted = "2026-10-26";
      await syncMore(
        "fake-ally",
        {
          added: [
            payment("discover", -45_678, posted, "DISCOVER E-PAYMENT 9912"),
            // Last 4 digits that match no card: the institution alone does not make it tracked.
            payment("other-capital-one", -5_678, posted, "CAPITAL ONE PAYMENT ENDING 0000"),
          ],
        },
        at(posted),
        false,
      );
      const ids = [await idOf("discover"), await idOf("other-capital-one")];

      for (const day of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) {
        await runMatching(bank.database, ids, at(day)());
        expect(await decisionOf("discover")).toEqual({
          step: "5.1",
          provisionalUntil: "2026-10-30",
          parts: transfer(-45_678),
        });
        expect((await decisionOf("other-capital-one"))?.provisionalUntil).toBe("2026-10-30");
      }

      expect(await decideProvisionalAgain(bank.database, at("2026-10-31")())).toBe(2);
      expect(await decisionOf("discover")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: [{ type: "Spending", amount: -45_678, category: "Miscellaneous" }],
      });
      expect((await decisionOf("other-capital-one"))?.parts).toEqual([
        { type: "Spending", amount: -5_678, category: "Miscellaneous" },
      ]);
    });

    it("is replaced by a pair found inside the 4 business days", async () => {
      const posted = "2026-10-26";
      await syncMore(
        "fake-ally",
        { added: [payment("late-pair", -56_789, posted, "CARD PAYMENT WEB")] },
        at(posted),
      );
      expect((await decisionOf("late-pair"))?.step).toBe("5.1");

      await syncMore(
        "fake-chase",
        {
          added: [
            {
              ...onCard("card-side", 56_789, "2026-10-28", "PAYMENT THANK YOU"),
              category: { name: CARD_PAYMENT, confidence: "HIGH", version: "v2", mcc: null },
            },
          ],
        },
        at("2026-10-28"),
      );

      expect(await decisionOf("late-pair")).toMatchObject({ step: "3", provisionalUntil: null });
    });
  });

  // Spec 03, One side missing: a run of 4 digits is a card's last 4 only right after a card word.
  // The Chase card's last 4 are 4821 here.
  describe("the last 4 digits a card payment names", () => {
    beforeEach(async () => {
      await bank.database.$client.execute(
        "UPDATE household_accounts SET mask = '4821' WHERE mask = '7731'",
      );
    });

    const TRACKED = "to a card the app tracks";
    const UNTRACKED = "to a card the app does not track";
    // Each description, and where its payment goes.
    const descriptions: Record<string, string> = {
      // A card word, then the last 4.
      "CHASE CARD ENDING IN 4821": TRACKED,
      "Payment to card 4821": TRACKED,
      "AUTOPAY CARD-4821": TRACKED,
      "online payment ending in #4821": TRACKED,
      "AUTOPAY XXXX4821": TRACKED,
      XXXX4821: TRACKED,
      "AUTOPAY x4821": TRACKED,
      "ONLINE PMT *4821": TRACKED,
      // No card word right before the digits, and no institution: no card is named.
      "BOX 4821": UNTRACKED,
      "XBOX 4821": UNTRACKED,
      "PAYMENT ID 4821": UNTRACKED,
      "STORE 4821 PAYMENT": UNTRACKED,
      // No last 4, so the institution rule decides.
      "CHASE ONLINE PAYMENT 2026 THANK YOU": TRACKED,
      "CHASE BOX 4820": TRACKED,
      "CHASE PAYMENT ID 9541": TRACKED,
      "CHASE STORE 0412 PAYMENT": TRACKED,
      "CHASE PURCHASE 1005 BLUEBIRD BOOKS": TRACKED,
      "CHASE BEST BUY CO": TRACKED,
      "CHASE REF#12345678": TRACKED,
      "CHASE (800) 555-1212": TRACKED,
      "CHASE VENMO PAYMENT 1234567890 WEB ID": TRACKED,
      "CHASE ZELLE PAYMENT TO 5551234": TRACKED,
      "CHASE PAYPAL *INST XFER": TRACKED,
      "CHASE CASH APP*SENT": TRACKED,
      "CHASE VENMO CASHOUT": TRACKED,
      "CHASE VENMO *MORGAN LEE": TRACKED,
      "CHASE ZELLE PAYMENT TO JOHN SMITH": TRACKED,
      "CHASE PAYPAL *ETSY SHOP": TRACKED,
      "CHASE CASH APP*JOHN SMITH": TRACKED,
      // Last 4 digits that match no card: the institution alone does not make it tracked.
      "CHASE CARD ENDING 0000": UNTRACKED,
      "PURCHASE 1005 BLUEBIRD BOOKS": UNTRACKED,
    };

    it("reads them only right after a card word, and leaves the rest to the institution rule", async () => {
      const lines = Object.keys(descriptions);
      await syncMore("fake-ally", {
        added: lines.map((line, n) => payment(`named-${n}`, -(1_001 + n), "2026-10-28", line)),
      });

      const read: Record<string, string> = {};
      for (const [n, line] of lines.entries()) {
        const decision = await decisionOf(`named-${n}`);
        expect(decision?.step).toBe("5.1");
        read[line] = decision?.provisionalUntil === null ? TRACKED : UNTRACKED;
      }
      expect(read).toEqual(descriptions);
    });
  });

  // Spec 03, One side missing: a card Closed because its Connection was removed stays tracked for
  // 90 days after the removal, in Household time.
  describe("a card whose Connection was removed", () => {
    // 02:00 UTC on July 1 is still June 30 in the Household's New York time zone, so day 90 is
    // Monday, Sep 28.
    const REMOVED = new Date("2026-07-01T02:00:00.000Z");
    const DAY_90 = "2026-09-28";
    // A Tuesday. Its fourth business day is Monday, Oct 5.
    const DAY_91 = "2026-09-29";
    const toChase = (id: string, amount: number, postedDate: string) =>
      payment(id, amount, postedDate, "PAYMENT TO CHASE CARD ENDING IN 7731");
    const connectionOf = async (bankId: string) =>
      (await listConnections(bank.database)).find((c) => c.bankId === bankId)?.id ?? "";
    const closeCards = async (reason: string) =>
      bank.database.$client.execute({
        sql: `UPDATE household_accounts SET closed_at = ?, closed_reason = ?
              WHERE mask IN ('7731', '3391')`,
        args: [REMOVED.toISOString(), reason],
      });

    beforeEach(async () => {
      await bank.database.$client.execute(
        `INSERT INTO members (id, name, email, created_at, updated_at)
         VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-06-01T00:00:00.000Z',
           '2026-06-01T00:00:00.000Z')`,
      );
      // ZIP 18950 is in New York's time zone.
      const facts = await saveHouseholdFacts(
        bank.database,
        { zipCode: "18950", ages: [41], rentOrOwn: "rent" },
        "member-1",
        REMOVED,
      );
      expect(facts).toMatchObject({ saved: { timeZone: "America/New_York" } });
    });

    it("stays tracked on day 90, and is a card the app does not track from day 91", async () => {
      expect(
        await markConnectionRemoved(bank.database, await connectionOf("fake-chase"), REMOVED),
      ).toBe(true);
      await syncMore(
        "fake-ally",
        {
          added: [
            toChase("day-90", -11_111, DAY_90),
            toChase("day-91", -22_222, DAY_91),
            payment("day-91-named", -33_333, DAY_91, "CHASE MOBILE PMT"),
          ],
        },
        at(DAY_91),
        false,
      );
      const ids = await Promise.all(["day-90", "day-91", "day-91-named"].map(idOf));
      await runMatching(bank.database, ids, at(DAY_91)());

      expect(await decisionOf("day-90")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: transfer(-11_111),
      });
      expect(await decisionOf("day-91")).toEqual({
        step: "5.1",
        provisionalUntil: "2026-10-05",
        parts: transfer(-22_222),
      });
      expect((await decisionOf("day-91-named"))?.provisionalUntil).toBe("2026-10-05");

      await runMatching(bank.database, ids, at("2026-10-05")());
      expect((await decisionOf("day-91"))?.parts).toEqual(transfer(-22_222));

      expect(await decideProvisionalAgain(bank.database, at("2026-10-06")())).toBe(2);
      expect(await decisionOf("day-90")).toMatchObject({ parts: transfer(-11_111) });
      expect(await decisionOf("day-91")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: [{ type: "Spending", amount: -22_222, category: "Miscellaneous" }],
      });
      expect((await decisionOf("day-91-named"))?.parts).toEqual([
        { type: "Spending", amount: -33_333, category: "Miscellaneous" },
      ]);
    });

    for (const reason of ["closed by a member", "vanished"]) {
      it(`leaves a card Closed as "${reason}" tracked after 90 days`, async () => {
        await closeCards(reason);
        await syncMore("fake-ally", {
          added: [
            toChase("chase-later", -44_444, "2026-10-28"),
            payment("capital-one-later", -55_555, "2026-10-28", "CAPITAL ONE MOBILE PMT"),
          ],
        });

        expect(await decisionOf("chase-later")).toEqual({
          step: "5.1",
          provisionalUntil: null,
          parts: transfer(-44_444),
        });
        expect(await decisionOf("capital-one-later")).toEqual({
          step: "5.1",
          provisionalUntil: null,
          parts: transfer(-55_555),
        });
      });
    }

    // Spec 03, Undo and hand links: re-matching never ends a hand-made link (K12). Both payments
    // name the Chase card, and the removal is dated more than 90 days before them, so step 5.1
    // alone would call the card untracked.
    it("keeps a hand link and an app link to the card, and the totals with them", async () => {
      await syncMore("fake-ally", {
        added: [
          payment("hand-out", -12_345, "2026-10-27", "CHASE MOBILE PMT"),
          toChase("app-out", -45_600, "2026-10-27"),
        ],
      });
      await syncMore("fake-chase", {
        added: [
          onCard("hand-in", 12_345, "2026-10-28", "ONLINE CREDIT"),
          onCard("app-in", 45_600, "2026-10-28", "PAYMENT THANK YOU"),
        ],
      });
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
      const outSides = async () =>
        Promise.all(["hand-out", "app-out"].map(async (id) => (await decisionOf(id))?.parts));
      const transfers = [transfer(-12_345), transfer(-45_600)];
      expect(await links()).toEqual(linked);
      expect(await outSides()).toEqual(transfers);
      const before = await totalsByMonth(bank.database);
      const ids = await Promise.all(["hand-out", "app-out", "hand-in", "app-in"].map(idOf));

      expect(
        await markConnectionRemoved(bank.database, await connectionOf("fake-chase"), REMOVED),
      ).toBe(true);
      await runMatching(bank.database, ids, NOW());

      expect(await links()).toEqual(linked);
      expect(await outSides()).toEqual(transfers);
      expect(await totalsByMonth(bank.database)).toEqual(before);

      // A Member reopens the card.
      await bank.database.$client.execute(
        "UPDATE household_accounts SET closed_at = NULL, closed_reason = NULL WHERE mask = '7731'",
      );
      await runMatching(bank.database, ids, NOW());

      expect(await links()).toEqual(linked);
      expect(await outSides()).toEqual(transfers);
      expect(await totalsByMonth(bank.database)).toEqual(before);
    });
  });

  it("leaves money out of a card under the card payment category, such as a returned payment, to later steps", async () => {
    await syncMore("fake-chase", {
      added: [
        {
          ...onCard("returned", -78_901, "2026-10-28", "PAYMENT RETURNED"),
          category: { name: CARD_PAYMENT, confidence: "HIGH", version: "v2", mcc: null },
        },
      ],
    });

    expect(await decisionOf("returned")).toMatchObject({ step: "5.7", provisionalUntil: null });
  });

  describe("a payment on a tracked card that no connected Account sent", () => {
    const received = (id: string, posted: string) => ({
      ...onCard(id, 67_890, posted, "PAYMENT THANK YOU"),
      category: { name: CARD_PAYMENT, confidence: "HIGH", version: "v2", mcc: null },
    });

    it("is a Transfer from an Unconnected account, and asks which one when there is none", async () => {
      await syncMore("fake-chase", { added: [received("from-outside", "2026-10-29")] });

      expect(await decisionOf("from-outside")).toEqual({
        step: "6.6",
        provisionalUntil: "2026-11-04",
        parts: transfer(67_890),
      });
      expect((await itemOf("from-outside"))?.decided).toContain("Which account is this?");
    });

    it("goes to the only Unconnected account, whatever synced Accounts the Household has", async () => {
      const pinecrest = (
        await addUnconnectedAccount(bank.database, {
          name: "Pinecrest savings",
          kind: "savings",
          institutionName: DEMO_PINECREST.name,
          mask: DEMO_PINECREST.mask,
        })
      ).id;
      await syncMore("fake-chase", { added: [received("from-western", "2026-10-29")] });

      expect((await decisionOf("from-western"))?.step).toBe("6.6");
      expect(await assignedTo("from-western")).toBe(pinecrest);
      expect((await itemOf("from-western"))?.bestAnswer.value).toBe(`account ${pinecrest}`);
    });
  });

  describe("card rewards", () => {
    it.each([
      ["CREDIT-CASH BACK REWARD"],
      ["REDEMPTION CREDIT"],
      ["Statement credit: rewards redemption"],
    ])("makes %j on a credit card Income", async (description) => {
      await syncMore("fake-chase", {
        added: [onCard("reward", 2_500, "2026-10-28", description)],
      });

      expect(await decisionOf("reward")).toEqual({
        step: "6.1",
        provisionalUntil: null,
        parts: [{ type: "Income", amount: 2_500, category: null }],
      });
    });

    it("leaves a reward word on a checking Account to the later steps", async () => {
      await syncMore("fake-ally", {
        added: [
          fakeTxn({
            id: "not-a-card",
            accountId: CHECKING,
            amount: 2_500,
            postedDate: "2026-10-28",
            description: "REWARD DEPOSIT",
          }),
        ],
      });

      expect((await decisionOf("not-a-card"))?.step).toBe("6.9");
    });
  });
});

// Screen text never calls card rewards "cash back" (spec 03, Card rewards). "Cash back" on a
// screen or in a Category's definition means only cash back at a checkout.
describe("the words for card rewards", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("uses 'cash back' only for cash back at a checkout", () => {
    const texts = [
      ...sources(join(import.meta.dirname, "..", "web")).map((path) => readFileSync(path, "utf8")),
      ...CATEGORY_GROUPS.flatMap((group) =>
        group.categories.map((category) => `${category.name}: ${category.definition}`),
      ),
    ];
    for (const text of texts) {
      for (const found of text.matchAll(/.{0,40}cash[\s-]?back.{0,40}/gi)) {
        expect(found[0]).toMatch(/at a checkout/i);
      }
    }
  });
});
