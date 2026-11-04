import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, DEMO_PINECREST, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { CATEGORY_GROUPS } from "../categories/index.ts";
import { listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { openReviewItems } from "../review/index.ts";
import {
  decideProvisionalAgain,
  readTransactionDecision,
  runMatching,
  startMoneyMovement,
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
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await seedDemoHousehold(bank.database, bank.fake, NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
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
