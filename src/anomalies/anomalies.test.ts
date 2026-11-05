import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, demoRecords, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { draftFirstBudgets, editBudget, startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges, typeSteadyIncome } from "../recurring/index.ts";
import {
  type Alert,
  ANOMALY_CHECKS_CAP,
  ANOMALY_CHECKS_STOPPED,
  alertList,
  checkAnomalies,
  startAnomalyChecks,
} from "./index.ts";

// The Anomaly checks (spec 06, When checks run; Anomalies; What an Alert says), through the
// anomalies module's interface, on the demo Household. Its history holds one Duplicate charge, one
// Price increase, and one Large purchase, found in its history load. Later Transactions arrive
// through the fake adapter, and the follow-up job runs Matching, Categorization, the Recurring
// charge checks, then the Anomaly checks.

const MEMBER = "member-1";
const accountOf = (bankId: string) =>
  DEMO_BANKS.find((demo) => demo.bankId === bankId)?.accounts[0]?.id ?? "";
const CAPITAL_ONE = accountOf("fake-capital-one");
const CHASE = accountOf("fake-chase");
const SYNCHRONY = accountOf("fake-synchrony");

// The demo's provider Merchant ID for a Merchant name.
const merchantIdOf = (name: string) =>
  demoRecords().find((record) => record.merchantName === name)?.merchantId ?? null;

describe("the Anomaly checks", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  // The Household's clock. The demo history loads on Nov 1; later Transactions come by Nov 20.
  let now: Date;
  const clock = () => now;

  // A posted purchase of `spent` whole cents, as Plaid sends one.
  const purchase = (
    id: string,
    accountId: string,
    postedDate: string,
    spent: number,
    merchantName: string,
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId,
      amount: -spent,
      postedDate,
      description: merchantName.toUpperCase(),
      merchantName,
      merchantId: merchantIdOf(merchantName),
      category: {
        name: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
        confidence: "HIGH",
        version: "v2",
        mcc: null,
      },
      ...fields,
    });
  const connectionOf = async (bankId: string) =>
    (await listConnections(bank.database)).find((each) => each.bankId === bankId)?.id ?? "";
  // A later sync of one demo bank, then the follow-up job it starts.
  const sync = async (bankId: string, page: FakePage) => {
    bank.fake.addPages(bankId, page);
    await syncConnection(await connectionOf(bankId), clock);
    await runFollowUp(clock);
  };
  const alerts = () => alertList(bank.database);
  const ofKind = async (kind: Alert["kind"]) =>
    (await alerts()).filter((alert) => alert.kind === kind);
  const textsOf = async (kind: Alert["kind"]) => (await ofKind(kind)).map((alert) => alert.text);
  // The texts of the Alerts that later syncs created: not found in history.
  const laterTexts = async (kind: Alert["kind"]) =>
    (await ofKind(kind)).filter((alert) => alert.state === null).map((alert) => alert.text);
  const providerIdsOf = async (alert: Alert | undefined) => {
    const ids = alert?.transactionIds ?? [];
    const rows = await bank.database.$client.execute({
      sql: `SELECT id, provider_transaction_id FROM transactions WHERE id IN (${ids.map(() => "?").join(", ")})`,
      args: ids,
    });
    const byId = new Map(rows.rows.map((row) => [row.id, row.provider_transaction_id]));
    return ids.map((id) => byId.get(id));
  };

  beforeEach(async () => {
    now = new Date("2026-11-01T14:00:00.000Z");
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      startRecurringCharges({ database: bank.database, now: clock }).stop,
      startAnomalyChecks({ database: bank.database, now: clock }).stop,
      startBudgets({ database: bank.database, now: clock }).stop,
    ];
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    await seedDemoHousehold(bank.database, bank.fake, clock);
    await runFollowUp(clock);
    now = new Date("2026-11-20T14:00:00.000Z");
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("in a history load", () => {
    it("stores each Anomaly the demo history holds as found in history, with the spec's texts", async () => {
      const blueDoor = demoRecords()
        .filter((record) => record.description === "SQ *BLUE DOOR CAFE" && record.amount === -1_840)
        .map((record) => record.authorizedDate ?? record.postedDate)
        .sort();
      const furniture = demoRecords().find(
        (record) => record.merchantName === "Oak & Iron Furniture",
      );
      const day = (date: string | undefined) =>
        new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });

      expect(
        (await textsOf("Price increase")).filter((text) => text.startsWith("Streamflix")),
      ).toEqual(["Streamflix went up from $15.49 to $17.99 (+$2.50, +16%) on Feb 8."]);
      expect(await textsOf("Duplicate charge")).toEqual([
        `Possible duplicate charge: $18.40 at Blue Door Cafe on Chase Card, on ${day(blueDoor[0])} and ${day(blueDoor[1])}.`,
      ]);
      expect(await textsOf("Large purchase")).toContain(
        `Large purchase: $2,749.00 at Oak & Iron Furniture on ${day(furniture?.authorizedDate ?? furniture?.postedDate)}, 2025. It is larger than 98% of your purchases in the last 12 months.`,
      );
      const all = await alerts();
      expect(all.length).toBeGreaterThan(0);
      for (const alert of all) {
        expect(alert).toMatchObject({
          state: "found in history",
          advice: null,
          notAProblem: [],
          category: null,
        });
      }
    });

    it("stores the Anomalies of a bank added later as found in history too", async () => {
      const connectionId = await addConnection(bank.database, {
        provider: "fake",
        bankId: "fake-later-bank",
        bankName: "Later Bank",
        origin: "linked",
        syncMinute: 9,
      });
      const card = DEMO_BANKS.find((demo) => demo.bankId === "fake-chase")?.accounts[0];
      if (card === undefined) throw new Error("The demo has no Chase card.");
      const laterCard = { ...card, id: "later-card", name: "Later Card" };
      bank.fake.addPages("fake-later-bank", {
        accounts: [laterCard],
        added: [
          purchase("later-1", laterCard.id, "2026-11-12", 4_250, "Corner Hardware"),
          purchase("later-2", laterCard.id, "2026-11-13", 4_250, "Corner Hardware"),
        ],
        historyLoaded: true,
      });
      await syncConnection(connectionId, clock);
      await runFollowUp(clock);

      const [duplicate] = await ofKind("Duplicate charge").then((found) =>
        found.filter((alert) => alert.text.includes("Corner Hardware")),
      );
      expect(duplicate).toMatchObject({
        text: "Possible duplicate charge: $42.50 at Corner Hardware on Later Card, on Nov 12 and Nov 13.",
        state: "found in history",
      });
    });
  });

  describe("Duplicate charge", () => {
    it("fires for the same Account, Merchant, and amount, 0 to 2 days apart, with the spec's text", async () => {
      await sync("fake-chase", {
        added: [
          purchase("dup-1", CHASE, "2026-11-03", 4_250, "Corner Hardware"),
          purchase("dup-2", CHASE, "2026-11-05", 4_250, "Corner Hardware"),
        ],
      });

      const [duplicate] = (await ofKind("Duplicate charge")).filter(
        (alert) => alert.state === null,
      );
      expect(duplicate).toMatchObject({
        text: "Possible duplicate charge: $42.50 at Corner Hardware on Chase Card, on Nov 3 and Nov 5.",
        facts: {
          kind: "Duplicate charge",
          merchant: { name: "Corner Hardware" },
          account: "Chase Card",
          amount: 4_250,
          dates: ["2026-11-03", "2026-11-05"],
        },
        state: null,
        createdAt: now,
      });
      expect(await providerIdsOf(duplicate)).toEqual(["dup-1", "dup-2"]);
      expect(await laterTexts("Duplicate charge")).toHaveLength(1);
    });

    it("fires nothing 3 days apart, a cent off, on another Account, or while pending", async () => {
      await sync("fake-chase", {
        added: [
          // Checks use posted Transactions only.
          purchase("hold-1", CHASE, "2026-11-17", 17_500, "Corner Hardware", { pending: true }),
          purchase("hold-2", CHASE, "2026-11-17", 17_500, "Corner Hardware", { pending: true }),
          purchase("far-1", CHASE, "2026-11-03", 4_250, "Corner Hardware"),
          purchase("far-2", CHASE, "2026-11-06", 4_250, "Corner Hardware"),
          purchase("cent-1", CHASE, "2026-11-10", 2_000, "Corner Hardware"),
          purchase("cent-2", CHASE, "2026-11-10", 2_001, "Corner Hardware"),
          purchase("other-1", CHASE, "2026-11-14", 3_000, "Corner Hardware"),
        ],
      });
      await sync("fake-capital-one", {
        added: [purchase("other-2", CAPITAL_ONE, "2026-11-14", 3_000, "Corner Hardware")],
      });

      expect((await ofKind("Duplicate charge")).filter((alert) => alert.state === null)).toEqual(
        [],
      );
    });

    it("never fires for a frequent purchase: 3 others at that amount in the 60 days before", async () => {
      const coffee = (id: string, date: string) =>
        purchase(id, CHASE, date, 475, "Bean Stop", {
          category: {
            name: "FOOD_AND_DRINK_COFFEE",
            confidence: "HIGH",
            version: "v2",
            mcc: null,
          },
        });
      // Two before: not yet frequent.
      await sync("fake-chase", {
        added: [
          coffee("bean-1", "2026-09-20"),
          coffee("bean-2", "2026-10-01"),
          coffee("bean-3", "2026-10-25"),
          coffee("bean-4", "2026-10-25"),
        ],
      });
      expect(await laterTexts("Duplicate charge")).toContain(
        "Possible duplicate charge: $4.75 at Bean Stop on Chase Card, on Oct 25 and Oct 25.",
      );

      // Three before: frequent.
      await sync("fake-chase", {
        added: [coffee("bean-5", "2026-11-12"), coffee("bean-6", "2026-11-13")],
      });
      expect(
        (await laterTexts("Duplicate charge")).filter((text) => text.includes("Nov 12")),
      ).toEqual([]);
    });
    it("counts only others at the same amount as a frequent purchase", async () => {
      const coffee = (id: string, date: string, spent: number) =>
        purchase(id, CHASE, date, spent, "Bean Stop", {
          category: {
            name: "FOOD_AND_DRINK_COFFEE",
            confidence: "HIGH",
            version: "v2",
            mcc: null,
          },
        });
      await sync("fake-chase", {
        added: [
          coffee("bean-1", "2026-09-20", 525),
          coffee("bean-2", "2026-10-01", 610),
          coffee("bean-3", "2026-10-10", 380),
          coffee("bean-4", "2026-10-25", 475),
          coffee("bean-5", "2026-10-26", 475),
        ],
      });
      expect(await laterTexts("Duplicate charge")).toContain(
        "Possible duplicate charge: $4.75 at Bean Stop on Chase Card, on Oct 25 and Oct 26.",
      );
    });

    it("matches the hard Merchant lines through the real cleanup rules", async () => {
      // Each pair is two posted lines on one day for one amount: whether they are one Merchant.
      const pairs: [string, string, string | null][] = [
        // A payment-app line that names no one has the app as its Merchant (spec 04, Identity).
        ["VENMO PAYMENT 1234567890 WEB ID", "VENMO PAYMENT 9876543210 WEB ID", "Venmo"],
        ["ZELLE PAYMENT TO 5551234", "ZELLE PAYMENT TO 5559876", "Zelle"],
        ["CASH APP*SENT", "CASH APP*SENT", "Cash App"],
        // A line that names a person or a shop has that one as its Merchant.
        ["VENMO *MORGAN LEE", "VENMO *JOHN SMITH", null],
        ["ZELLE PAYMENT TO JOHN SMITH", "CASH APP*JOHN SMITH", "John Smith"],
        ["PAYPAL *ETSY SHOP", "PAYPAL *INST XFER", null],
        // Store numbers, lead-ins, and digit runs.
        ["PURCHASE 1005 BLUEBIRD BOOKS", "PURCHASE 1007 BLUEBIRD BOOKS", "Bluebird Books"],
        ["BEST BUY CO", "BEST BUY CO", "Best Buy Co"],
        // No Merchant at all: no Anomaly.
        ["XXXX4821", "XXXX4821", null],
        ["REF#12345678", "REF#12345678", null],
        ["(800) 555-1212", "(800) 555-1212", null],
      ];
      await sync("fake-chase", {
        added: pairs.flatMap(([first, second], at) =>
          [first, second].map((description, each) =>
            purchase(`k7-${at}-${each}`, CHASE, "2026-11-10", 1_000 + at, "unused", {
              merchantName: null,
              merchantId: null,
              description,
            }),
          ),
        ),
      });

      const named = (await ofKind("Duplicate charge"))
        .filter((alert) => alert.state === null)
        .flatMap(({ facts }) =>
          facts.kind === "Duplicate charge" ? [[facts.amount, facts.merchant.name]] : [],
        );
      expect(named.sort()).toEqual(
        pairs.flatMap(([, , merchant], at) => (merchant === null ? [] : [[1_000 + at, merchant]])),
      );
    });
  });

  describe("Price increase", () => {
    it("fires once for the spec's example in the history, and for a later rise", async () => {
      const streamflix = (id: string, date: string, spent: number) =>
        purchase(id, CAPITAL_ONE, date, spent, "Streamflix");
      await sync("fake-capital-one", { added: [streamflix("sf-nov", "2026-11-08", 1_999)] });

      const later = (await ofKind("Price increase")).filter((alert) => alert.state === null);
      expect(later.map((alert) => alert.text)).toEqual([
        "Streamflix went up from $17.99 to $19.99 (+$2.00, +11%) on Nov 8.",
      ]);
      expect(later[0]?.facts).toEqual({
        kind: "Price increase",
        merchant: { id: merchantIdOf("Streamflix"), name: "Streamflix" },
        base: 1_799,
        amount: 1_999,
        date: "2026-11-08",
      });
      expect(await providerIdsOf(later[0])).toEqual(["sf-nov"]);
    });

    it("fires nothing for a rise of 5% or less, a rise of $1 or less, or a drop", async () => {
      // $49.99 to $52.48 is 4.98%; $11.99 to $9.99 is a drop.
      await sync("fake-chase", {
        added: [purchase("gym-nov", CHASE, "2026-11-02", 5_248, "Ironworks Fitness")],
      });
      await sync("fake-capital-one", {
        added: [
          // $17.99 to $18.99 is $1.00.
          purchase("sf-nov", CAPITAL_ONE, "2026-11-08", 1_899, "Streamflix"),
          purchase("tb-nov", CAPITAL_ONE, "2026-11-18", 999, "Tunebox"),
        ],
      });

      expect(await laterTexts("Price increase")).toEqual([]);
    });

    it("fires for a rise just over 5%", async () => {
      await sync("fake-chase", {
        added: [purchase("gym-nov", CHASE, "2026-11-02", 5_250, "Ironworks Fitness")],
      });

      expect(await laterTexts("Price increase")).toContain(
        "Ironworks Fitness went up from $49.99 to $52.50 (+$2.51, +5%) on Nov 2.",
      );
    });

    it("fires at most once for a Transaction, even when the provider changes it later", async () => {
      const raised = purchase("sf-nov", CAPITAL_ONE, "2026-11-08", 1_999, "Streamflix");
      await sync("fake-capital-one", { added: [raised] });
      await sync("fake-capital-one", {
        changed: [{ ...raised, amount: -2_099, description: "STREAMFLIX.COM NEW PRICE" }],
      });

      expect(await laterTexts("Price increase")).toEqual([
        "Streamflix went up from $17.99 to $19.99 (+$2.00, +11%) on Nov 8.",
      ]);
    });
  });

  describe("New Recurring charge", () => {
    const showbox = (id: string, date: string, spent = 999) =>
      purchase(id, CAPITAL_ONE, date, spent, "Showbox", {
        category: {
          name: "ENTERTAINMENT_TV_AND_MOVIES",
          confidence: "HIGH",
          version: "v2",
          mcc: null,
        },
      });

    it("fires for a second Transaction on a monthly schedule, with the spec's text", async () => {
      await sync("fake-capital-one", {
        added: [showbox("sb-sep", "2026-09-03"), showbox("sb-oct", "2026-10-03")],
      });

      const found = (await ofKind("New Recurring charge")).filter((alert) => alert.state === null);
      expect(found.map((alert) => [alert.text, alert.state])).toEqual([
        ["New Recurring charge? Showbox, $9.99 on Sep 3 and Oct 3. Next expected Nov 3.", null],
      ]);
      expect(await providerIdsOf(found[0])).toEqual(["sb-sep", "sb-oct"]);
    });

    it("fires for weekly and 2-week schedules, and never for the yearly one", async () => {
      await sync("fake-capital-one", {
        added: [
          purchase("wk-1", CAPITAL_ONE, "2026-11-02", 1_500, "Lawn Pros"),
          purchase("wk-2", CAPITAL_ONE, "2026-11-09", 1_550, "Lawn Pros"),
          purchase("bi-1", CAPITAL_ONE, "2026-10-20", 3_000, "Tutor Time"),
          purchase("bi-2", CAPITAL_ONE, "2026-11-03", 3_000, "Tutor Time"),
          purchase("yr-1", CAPITAL_ONE, "2025-11-05", 9_900, "Domain Host"),
          purchase("yr-2", CAPITAL_ONE, "2026-11-05", 9_900, "Domain Host"),
        ],
      });

      expect(await laterTexts("New Recurring charge")).toEqual(
        expect.arrayContaining([
          "New Recurring charge? Lawn Pros, $15.50 on Nov 2 and Nov 9. Next expected Nov 16.",
          "New Recurring charge? Tutor Time, $30.00 on Oct 20 and Nov 3. Next expected Nov 17.",
        ]),
      );
      expect((await laterTexts("New Recurring charge")).join()).not.toContain("Domain Host");
    });

    it("fires nothing outside 7.5%, or when two earlier Transactions fit", async () => {
      await sync("fake-capital-one", {
        added: [
          showbox("sb-sep", "2026-09-03", 999),
          // $10.75 is more than 7.5% above $9.99.
          showbox("sb-oct", "2026-10-03", 1_075),
          purchase("two-1", CAPITAL_ONE, "2026-09-03", 2_000, "Pet Box"),
          purchase("two-2", CAPITAL_ONE, "2026-09-04", 2_000, "Pet Box"),
          purchase("two-3", CAPITAL_ONE, "2026-10-04", 2_000, "Pet Box"),
        ],
      });

      expect(await laterTexts("New Recurring charge")).toEqual([]);
    });

    it("never fires for a Transaction that continues a Recurring charge", async () => {
      await sync("fake-capital-one", {
        added: [showbox("sb-sep", "2026-09-03"), showbox("sb-oct", "2026-10-03")],
      });
      // A one-off a month before the next charge is on its schedule, but the charge continues.
      await sync("fake-capital-one", {
        added: [showbox("sb-extra", "2026-10-05", 1_000), showbox("sb-nov", "2026-11-03")],
      });

      expect(await laterTexts("New Recurring charge")).toEqual([
        "New Recurring charge? Showbox, $9.99 on Sep 3 and Oct 3. Next expected Nov 3.",
      ]);
    });

    const taqueria = (id: string, date: string, spent: number) =>
      purchase(id, CAPITAL_ONE, date, spent, "Taco Spot", {
        category: {
          name: "FOOD_AND_DRINK_RESTAURANT",
          confidence: "HIGH",
          version: "v2",
          mcc: null,
        },
      });

    it("never fires for a frequent purchase: 3 others at any amount in the 60 days before", async () => {
      // A restaurant: none of these is within 7.5% of $24.00, and none lands on a schedule with
      // the next.
      await sync("fake-capital-one", {
        added: [
          taqueria("taco-jul-10", "2026-07-10", 1_150),
          taqueria("taco-jul-20", "2026-07-20", 6_480),
          taqueria("taco-aug", "2026-08-15", 3_725),
        ],
      });
      await sync("fake-capital-one", {
        added: [
          taqueria("taco-sep", "2026-09-03", 2_400),
          taqueria("taco-oct", "2026-10-03", 2_450),
        ],
      });
      expect(await laterTexts("New Recurring charge")).toEqual([]);
    });

    it("fires with only 2 others in the 60 days before", async () => {
      await sync("fake-capital-one", {
        added: [
          taqueria("taco-jul-20", "2026-07-20", 6_480),
          taqueria("taco-aug", "2026-08-15", 3_725),
        ],
      });
      await sync("fake-capital-one", {
        added: [
          taqueria("taco-sep", "2026-09-03", 2_400),
          taqueria("taco-oct", "2026-10-03", 2_450),
        ],
      });
      expect(await laterTexts("New Recurring charge")).toEqual([
        "New Recurring charge? Taco Spot, $24.50 on Sep 3 and Oct 3. Next expected Nov 3.",
      ]);
    });

    it("never counts a Recurring charge's Transactions as frequent purchases", async () => {
      const apple = (id: string, date: string, spent: number) =>
        purchase(id, CAPITAL_ONE, date, spent, "Apple");
      // A $2.99 Recurring charge, then one app: 3 Transactions in the 60 days before Sep 10, but
      // only the app is a visit.
      await sync("fake-capital-one", {
        added: [
          apple("cloud-jul", "2026-07-05", 299),
          apple("cloud-aug", "2026-08-05", 299),
          apple("app", "2026-08-20", 499),
          apple("cloud-sep", "2026-09-05", 299),
        ],
      });
      await sync("fake-capital-one", {
        added: [apple("music-sep", "2026-09-10", 999), apple("music-oct", "2026-10-10", 999)],
      });

      expect(await laterTexts("New Recurring charge")).toContain(
        "New Recurring charge? Apple, $9.99 on Sep 10 and Oct 10. Next expected Nov 10.",
      );
    });

    it("never fires for a Merchant and amount marked known", async () => {
      // An earlier New Recurring charge Alert for Showbox at $10.49, with a "Not a problem" press.
      await sync("fake-capital-one", {
        added: [showbox("old-1", "2026-03-03", 1_049), showbox("old-2", "2026-04-03", 1_049)],
      });
      const [old] = (await ofKind("New Recurring charge")).filter((alert) => alert.state === null);
      const pressedAt = now;
      await bank.database.$client.execute({
        sql: "INSERT INTO alert_presses (alert_id, member_id, pressed_at) VALUES (?, ?, ?)",
        args: [old?.id ?? "", MEMBER, pressedAt.toISOString()],
      });
      now = new Date("2026-11-21T14:00:00.000Z");

      // $9.99 is within 7.5% of $10.49; $12.99 is not.
      await sync("fake-capital-one", {
        added: [
          showbox("sb-sep", "2026-09-03"),
          showbox("sb-oct", "2026-10-03"),
          showbox("hi-sep", "2026-09-10", 1_299),
          showbox("hi-oct", "2026-10-10", 1_299),
        ],
      });

      expect(await laterTexts("New Recurring charge")).toEqual([
        "New Recurring charge? Showbox, $12.99 on Sep 10 and Oct 10. Next expected Nov 10.",
        "New Recurring charge? Showbox, $10.49 on Mar 3 and Apr 3. Next expected May 3.",
      ]);
      expect((await alerts()).find((alert) => alert.id === old?.id)?.notAProblem).toEqual([
        { memberId: MEMBER, pressedAt },
      ]);
    });
  });

  describe("Large purchase", () => {
    it("fires for a purchase larger than 98% of the last 12 months, with the spec's text", async () => {
      await sync("fake-synchrony", {
        added: [
          purchase("big", SYNCHRONY, "2026-11-05", 189_900, "Lakeside Appliances", {
            category: {
              name: "HOME_IMPROVEMENT_FURNITURE",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          }),
        ],
      });

      const later = (await ofKind("Large purchase")).filter((alert) => alert.state === null);
      expect(later.map((alert) => alert.text)).toEqual([
        "Large purchase: $1,899.00 at Lakeside Appliances on Nov 5. It is larger than 98% of your purchases in the last 12 months.",
      ]);
    });

    it("adds the Budget line when the Category has a Budget", async () => {
      await typeSteadyIncome(bank.database, 900_000, MEMBER, now);
      expect(await draftFirstBudgets(bank.database, now)).toBe(true);
      await editBudget(
        bank.database,
        { category: "Home and garden", amount: 300_000, memberId: MEMBER },
        now,
      );
      await sync("fake-synchrony", {
        added: [
          purchase("big", SYNCHRONY, "2026-11-05", 189_900, "Lakeside Appliances", {
            category: {
              name: "HOME_IMPROVEMENT_FURNITURE",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          }),
        ],
      });

      const later = (await ofKind("Large purchase")).filter((alert) => alert.state === null);
      expect(later.map((alert) => alert.text)).toEqual([
        "Large purchase: $1,899.00 at Lakeside Appliances on Nov 5. It is larger than 98% of your purchases in the last 12 months. Home and garden: $1,899 of its $3,000 Budget for Nov 2026.",
      ]);
    });

    it("fires nothing under $250, or for Spending in the Bills group", async () => {
      await sync("fake-synchrony", {
        added: [purchase("small", SYNCHRONY, "2026-11-05", 24_999, "Lakeside Appliances")],
      });
      await sync("fake-chase", {
        added: [
          purchase("bill", CHASE, "2026-11-06", 90_000, "Mapleford Power", {
            category: {
              name: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          }),
        ],
      });

      expect((await ofKind("Large purchase")).filter((alert) => alert.state === null)).toEqual([]);
    });
  });

  describe("failures", () => {
    it("stores what a sync stored before it failed, and the rest after its retry", async () => {
      bank.fake.addPages("fake-chase", {
        added: [
          purchase("dup-1", CHASE, "2026-11-03", 4_250, "Corner Hardware"),
          purchase("dup-2", CHASE, "2026-11-04", 4_250, "Corner Hardware"),
        ],
      });
      bank.fake.addPages("fake-chase", {
        added: [
          purchase("dup-3", CHASE, "2026-11-12", 6_100, "Pine Tools"),
          purchase("dup-4", CHASE, "2026-11-12", 6_100, "Pine Tools"),
        ],
      });
      const connectionId = await connectionOf("fake-chase");
      const failing = DEMO_BANKS.find((demo) => demo.bankId === "fake-chase")?.pages.length ?? 0;
      bank.fake.failAt("fake-chase", failing + 1, "temporary");
      await expect(syncConnection(connectionId, clock)).rejects.toThrow("failed page");
      await runFollowUp(clock);
      const later = async () =>
        (await ofKind("Duplicate charge"))
          .filter((alert) => alert.state === null)
          .flatMap(({ facts }) => (facts.kind === "Duplicate charge" ? [facts.merchant.name] : []));
      expect(await later()).toEqual(["Corner Hardware"]);

      await syncConnection(connectionId, clock);
      await runFollowUp(clock);
      expect((await later()).sort()).toEqual(["Corner Hardware", "Pine Tools"]);
    });

    it("stops a step that always throws at its cap with one System notice, and the next success ends it", async () => {
      await bank.database.$client.execute("ALTER TABLE alerts RENAME TO alerts_away");
      await sync("fake-chase", {
        added: [purchase("dup-1", CHASE, "2026-11-03", 4_250, "Corner Hardware")],
      }).catch(() => undefined);
      for (let run = 2; run < ANOMALY_CHECKS_CAP; run += 1) {
        await expect(runFollowUp(clock)).rejects.toThrow("The Anomaly checks failed.");
      }
      // The run at the cap gives up on the Transaction, and the job goes on.
      await expect(runFollowUp(clock)).resolves.toBeUndefined();
      await expect(runFollowUp(clock)).resolves.toBeUndefined();
      const open = async () =>
        (
          await bank.database.$client.execute({
            sql: "SELECT text FROM system_notices WHERE condition = ? AND closed_at IS NULL",
            args: [ANOMALY_CHECKS_STOPPED],
          })
        ).rows;
      expect(await open()).toHaveLength(1);
      const marks = await bank.database.$client.execute(
        "SELECT count(*) AS n FROM follow_up_marks m JOIN transactions t ON t.id = m.transaction_id WHERE t.provider_transaction_id = 'dup-1' AND m.step IN ('anomaly checks', 'Bills Budgets')",
      );
      expect(Number(marks.rows[0]?.n)).toBe(2);

      await bank.database.$client.execute("ALTER TABLE alerts_away RENAME TO alerts");
      await sync("fake-chase", {
        added: [purchase("dup-2", CHASE, "2026-11-04", 4_250, "Corner Hardware")],
      });
      expect(await open()).toEqual([]);
      expect(await laterTexts("Duplicate charge")).toContain(
        "Possible duplicate charge: $42.50 at Corner Hardware on Chase Card, on Nov 3 and Nov 4.",
      );
    });

    it("deletes a Connection's Alerts with its history", async () => {
      expect(await textsOf("Duplicate charge")).toHaveLength(1);
      const removing = connectionRemoving();
      const connectionId = await connectionOf("fake-chase");
      expect(await removing.remove(connectionId)).toMatchObject({ outcome: "removed" });
      expect(await removing.deleteHistory(connectionId)).toMatchObject({ outcome: "deleted" });

      // The Duplicate charge and the Large purchase were on the Chase card.
      expect(await textsOf("Duplicate charge")).toEqual([]);
      expect((await textsOf("Large purchase")).join()).not.toContain("Oak & Iron");
      expect(await textsOf("Price increase")).toContain(
        "Streamflix went up from $15.49 to $17.99 (+$2.50, +16%) on Feb 8.",
      );
      const rows = await bank.database.$client.execute(
        "SELECT count(*) AS n FROM alert_transactions",
      );
      expect(Number(rows.rows[0]?.n)).toBe(
        (await alerts()).reduce((sum, alert) => sum + alert.transactionIds.length, 0),
      );
    });
  });

  it("checks 2,500 new Transactions in a few seconds", async () => {
    const added: TxnRecord[] = [];
    for (let index = 0; index < 2_500; index += 1) {
      const day = String(1 + (index % 28)).padStart(2, "0");
      const month = String(1 + Math.floor(index / 250)).padStart(2, "0");
      added.push(
        purchase(
          `many-${index}`,
          CHASE,
          `2025-${month}-${day}`,
          1_000 + (index % 400) * 25,
          `Shop ${index % 120}`,
        ),
      );
    }
    // The checks run directly below, so the follow-up job's step stops first.
    stops[3]?.();
    await sync("fake-chase", { added });
    const ids = (
      await bank.database.$client.execute(
        "SELECT id FROM transactions WHERE provider_transaction_id LIKE 'many-%'",
      )
    ).rows.map((row) => String(row.id));
    expect(ids).toHaveLength(2_500);

    // CPU time, which a busy host does not stretch.
    const started = process.cpuUsage();
    await checkAnomalies(bank.database, ids, now);
    const used = process.cpuUsage(started);
    expect((used.user + used.system) / 1_000).toBeLessThan(3_000);
  }, 120_000);
});
