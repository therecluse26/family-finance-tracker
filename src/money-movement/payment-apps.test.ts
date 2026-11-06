import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, DEMO_MEMBERS, demoRecords, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { correctCategory, startCategorization } from "../categorization/index.ts";
import { listConnections, setHandSetFields } from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import { openReviewItems } from "../review/index.ts";
import { readTransactionDecision, startMoneyMovement } from "./index.ts";

// Payment apps and cash (spec 03, Payment apps, Cash), on the demo Household, through the
// Matching and Categorization follow-up steps on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const CHECKING = DEMO_BANKS.find((demo) => demo.bankId === "fake-ally")?.accounts[0]?.id ?? "";
const FROM_APPS_OUT = "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS";

// The demo's records whose description starts with `prefix`.
const demoLines = (prefix: string) =>
  demoRecords().filter((record) => record.description.startsWith(prefix) && !record.pending);

type PartRow = { type: string; category: string | null; source: string | null };

describe("payment apps and cash", () => {
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
  // The Transaction's parts with their Categories, and its Merchant's clean name.
  const shownAs = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.type, p.category, p.category_source AS source FROM transaction_parts p
            JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    const [merchant] = (
      await bank.database.$client.execute({
        sql: "SELECT merchant_clean_name AS name FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
        args: [providerId],
      })
    ).rows;
    return {
      parts: rows.rows.map((row) => ({ ...row }) as unknown as PartRow),
      merchant: merchant?.name ?? null,
    };
  };
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
  const syncMore = async (bankId: string, page: FakePage) => {
    bank.fake.addPages(bankId, page);
    const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
    await syncConnection(connection?.id ?? (await bank.connect(bankId)), NOW);
    await runFollowUp(NOW);
  };
  const inChecking = (
    id: string,
    amount: number,
    description: string,
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({ id, accountId: CHECKING, amount, postedDate: "2026-10-28", description, ...fields });
  const code = (name: string) => ({
    category: { name, confidence: "HIGH", version: "v2", mcc: null },
  });
  const app = (name: string) => ({ counterparties: [{ name, type: "payment_app" }] });

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    // The demo's two Members, whom Zelle lines name by first and last name.
    for (const [index, member] of DEMO_MEMBERS.entries()) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        args: [`member-${index}`, `${member.firstName} ${member.lastName}`, member.email],
      });
    }
    await seedDemoHousehold(bank.database, bank.fake, NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("bank lines", () => {
    it.each([
      ["VENMO PAYMENT", "Venmo"],
      ["VENMO ADDFUNDS", "Venmo"],
      ["Zelle payment to MORGAN LEE", "Morgan Lee"],
    ])(
      "makes the demo's %j lines Spending in Payments to people, with %j as the Merchant",
      async (prefix, merchant) => {
        await runFollowUp(NOW);
        const lines = demoLines(prefix);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect((await decisionOf(line.id))?.step).toBe("5.5");
          expect(await shownAs(line.id)).toEqual({
            parts: [{ type: "Spending", category: "Payments to people", source: "money movement" }],
            merchant,
          });
        }
      },
    );

    it.each([
      ["VENMO CASHOUT", "Venmo"],
      ["Zelle payment from TAYLOR BROOKS", "Taylor Brooks"],
    ])("makes the demo's %j lines Income, with %j as the Merchant", async (prefix, merchant) => {
      await runFollowUp(NOW);
      const lines = demoLines(prefix);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect((await decisionOf(line.id))?.step).toBe("6.5");
        expect(await shownAs(line.id)).toEqual({
          parts: [{ type: "Income", category: null, source: null }],
          merchant,
        });
      }
    });

    it.each([
      ["paypal-add", "PAYPAL INST XFER", { ...code(FROM_APPS_OUT), ...app("PayPal") }, "PayPal"],
      ["cash-app", "CASH APP*JOHN SMITH", {}, "John Smith"],
      ["paypal-person", "PAYPAL TRANSFER TO JOHN SMITH", {}, "John Smith"],
      ["zelle-person", "ZELLE PAYMENT TO JOHN SMITH", {}, "John Smith"],
      ["venmo-star", "VENMO *MORGAN LEE", {}, "Morgan Lee"],
      ["app-code-only", "MOBILE SEND 0042", code(FROM_APPS_OUT), null],
    ])(
      "makes %s (%j) Spending in Payments to people, never a one-sided Transfer",
      async (id, description, fields, merchant) => {
        await syncMore("fake-ally", { added: [inChecking(id, -4_200, description, fields)] });

        expect((await decisionOf(id))?.step).toBe("5.5");
        expect((await shownAs(id)).parts).toEqual([
          { type: "Spending", category: "Payments to people", source: "money movement" },
        ]);
        if (merchant !== null) expect((await shownAs(id)).merchant).toBe(merchant);
        expect(await assignedTo(id)).toBeNull();
        expect(await itemOf(id)).toBeUndefined();
      },
    );

    it("makes a payment-app line that names another Merchant an ordinary purchase", async () => {
      await syncMore("fake-ally", {
        added: [
          inChecking("etsy", -3_100, "PAYPAL *ETSY SHOP"),
          inChecking("yoga", -6_000, "PAYPAL TRANSFER", {
            merchantName: "Sunshine Yoga Studio",
            ...app("PayPal"),
            ...code("PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS"),
          }),
        ],
      });

      expect((await decisionOf("etsy"))?.step).toBe("5.7");
      expect(await shownAs("etsy")).toMatchObject({ merchant: "Etsy Shop" });
      expect((await decisionOf("yoga"))?.step).toBe("5.7");
      expect(await shownAs("yoga")).toEqual({
        parts: [{ type: "Spending", category: "Fitness", source: "provider" }],
        merchant: "Sunshine Yoga Studio",
      });
    });

    it("never ties a payment-app line to an Unconnected account, even one named for the app", async () => {
      await addUnconnectedAccount(bank.database, {
        name: "Venmo balance",
        kind: "other",
        institutionName: "Venmo",
        mask: null,
      });
      await syncMore("fake-ally", {
        added: [inChecking("venmo-xfer", -7_500, "VENMO TRANSFER", code(FROM_APPS_OUT))],
      });

      expect((await decisionOf("venmo-xfer"))?.step).toBe("5.5");
      expect(await assignedTo("venmo-xfer")).toBeNull();
    });
  });

  describe("Zelle with a Member's own name", () => {
    it("makes it a one-sided Transfer with no pair, whatever the case", async () => {
      await runFollowUp(NOW);
      const toAlex = demoLines("Zelle payment to ALEX RIVERA");
      const fromJamie = demoLines("Zelle payment from JAMIE RIVERA");
      expect(toAlex.length).toBeGreaterThan(0);
      expect(fromJamie.length).toBe(1);
      for (const line of [...toAlex, ...fromJamie]) {
        const decision = await decisionOf(line.id);
        expect(decision?.step).toBe(line.amount < 0 ? "5.4" : "6.3");
        expect(decision?.parts).toEqual([
          { type: "Transfer", amount: line.amount, category: null },
        ]);
      }

      await syncMore("fake-ally", {
        added: [inChecking("lower", -9_000, "zelle to alex rivera")],
      });
      expect((await decisionOf("lower"))?.step).toBe("5.4");
      expect((await itemOf("lower"))?.decided).toContain("Which account is this?");
    });

    it("pairs with the Member's own Account when it is connected", async () => {
      const ALEX_CHECKING = fakeAccount({
        id: "alex-checking",
        name: "Alex Checking",
        mask: "2210",
      });
      await syncMore("fake-other", {
        accounts: [ALEX_CHECKING],
        added: [
          fakeTxn({
            id: "alex-in",
            accountId: ALEX_CHECKING.id,
            amount: 33_000,
            postedDate: "2026-10-28",
            description: "ZELLE FROM JAMIE RIVERA",
            ...code("TRANSFER_IN_ACCOUNT_TRANSFER"),
          }),
        ],
      });
      await syncMore("fake-ally", {
        added: [
          inChecking("alex-out", -33_000, "Zelle payment to ALEX RIVERA", {
            ...code("TRANSFER_OUT_ACCOUNT_TRANSFER"),
            ...app("Zelle"),
          }),
        ],
      });

      expect((await decisionOf("alex-out"))?.step).toBe("3");
      expect((await decisionOf("alex-in"))?.step).toBe("3");
    });

    it("makes Zelle that names someone outside the Household a payment to a person", async () => {
      await syncMore("fake-ally", {
        // Only the first name of a Member, or only the last name.
        added: [
          inChecking("first-only", -1_500, "ZELLE PAYMENT TO ALEX SMITH"),
          inChecking("last-only", -1_600, "ZELLE PAYMENT TO CASEY RIVERA"),
        ],
      });

      expect((await decisionOf("first-only"))?.step).toBe("5.5");
      expect((await decisionOf("last-only"))?.step).toBe("5.5");
    });
  });

  it("pairs money added to a connected Venmo Account as a Transfer", async () => {
    const VENMO = fakeAccount({ id: "venmo-balance", name: "Venmo Balance", mask: null });
    await syncMore("fake-venmo", {
      accounts: [VENMO],
      added: [
        fakeTxn({
          id: "venmo-in",
          accountId: VENMO.id,
          amount: 5_000,
          postedDate: "2026-10-29",
          description: "Added funds from bank",
        }),
      ],
    });
    await syncMore("fake-ally", {
      added: [
        inChecking("venmo-out", -5_000, "VENMO ADDFUNDS", {
          ...code(FROM_APPS_OUT),
          ...app("Venmo"),
        }),
      ],
    });

    for (const id of ["venmo-out", "venmo-in"]) {
      expect(await decisionOf(id)).toMatchObject({
        step: "3",
        parts: [{ type: "Transfer", category: null }],
      });
    }
    expect(await assignedTo("venmo-out")).toBeNull();
  });

  describe("a person's own Category", () => {
    it("lets a Category rule for the person move the payments to Childcare", async () => {
      await runFollowUp(NOW);
      const [first, ...lines] = demoLines("Zelle payment to MORGAN LEE");
      expect(lines.length).toBeGreaterThan(0);
      // A Member's correction on one line makes a Category rule for the person.
      expect(
        await correctCategory(bank.database, await idOf(first?.id ?? ""), "Childcare", {
          onlyThisTransaction: false,
          memberId: "member-0",
        }),
      ).toMatchObject({ result: "corrected", rule: { merchant: { name: "Morgan Lee" } } });
      await runFollowUp(NOW);

      for (const line of lines) {
        expect(await shownAs(line.id)).toEqual({
          parts: [{ type: "Spending", category: "Childcare", source: "Category rule" }],
          merchant: "Morgan Lee",
        });
      }
      // Other people stay in Payments to people.
      const [venmo] = demoLines("VENMO PAYMENT");
      expect((await shownAs(venmo?.id ?? "")).parts[0]?.category).toBe("Payments to people");
    });

    it("lets a hand-set Category replace Payments to people", async () => {
      await runFollowUp(NOW);
      const [line] = demoLines("Zelle payment to MORGAN LEE");
      const id = await idOf(line?.id ?? "");
      await setHandSetFields(bank.database, id, { category: "Childcare" });
      await followUpAgain(bank.database, [id]);
      await runFollowUp(NOW);

      expect(await shownAs(line?.id ?? "")).toMatchObject({
        parts: [{ type: "Spending", category: "Childcare", source: "hand-set" }],
      });
    });
  });

  describe("cash", () => {
    it("makes a cash withdrawal Spending in Cash, even with transfer wording", async () => {
      await runFollowUp(NOW);
      const atm = demoLines("ATM WITHDRAWAL");
      expect(atm.length).toBe(4);
      for (const line of atm) {
        expect((await decisionOf(line.id))?.step).toBe("5.3");
        expect((await shownAs(line.id)).parts).toEqual([
          { type: "Spending", category: "Cash", source: "money movement" },
        ]);
      }

      await syncMore("fake-ally", {
        added: [
          inChecking(
            "teller",
            -20_000,
            "TELLER TRANSFER WITHDRAWAL",
            code("TRANSFER_OUT_WITHDRAWAL"),
          ),
        ],
      });
      expect((await decisionOf("teller"))?.step).toBe("5.3");
    });

    it("makes cash back on its own line Cash, and a combined line takes the purchase's Category", async () => {
      await syncMore("fake-ally", {
        added: [
          inChecking("own-line", -4_000, "CASH BACK GREEN GROCER"),
          inChecking("combined", -10_400, "PURCHASE WITH CASH BACK GREEN GROCER", {
            merchantName: "Green Grocer",
            ...code("FOOD_AND_DRINK_GROCERIES"),
          }),
        ],
      });

      expect((await decisionOf("own-line"))?.step).toBe("5.3");
      expect((await shownAs("own-line")).parts).toEqual([
        { type: "Spending", category: "Cash", source: "money movement" },
      ]);
      expect((await decisionOf("combined"))?.step).toBe("5.7");
      expect((await shownAs("combined")).parts).toEqual([
        { type: "Spending", category: "Groceries", source: "provider" },
      ]);
    });

    it("gives a combined line without the word purchase the purchase's Category, by its Merchant name or its Plaid code", async () => {
      await syncMore("fake-ally", {
        added: [
          inChecking("both", -6_500, "WALMART #1234 W/ CASH BACK", {
            merchantName: "Walmart",
            ...code("GENERAL_MERCHANDISE_SUPERSTORES"),
          }),
          // Each half alone names a purchase too.
          inChecking("merchant-only", -5_200, "HAT SHACK #77 W/ CASH BACK", {
            merchantName: "Hat Shack",
          }),
          inChecking("code-only", -4_300, "POS 0412 W/ CASH BACK", {
            ...code("GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES"),
          }),
          inChecking("word-only", -3_700, "POS PURCHASE W/ CASH BACK 0412"),
          // Cash alone: no Merchant name, and no code, a code that is no purchase, or Plaid's code
          // for "it does not know".
          inChecking("cash-alone", -2_000, "CASH BACK"),
          inChecking(
            "cash-transfer-code",
            -3_000,
            "CASH BACK 0412",
            code("TRANSFER_OUT_OTHER_TRANSFER_OUT"),
          ),
          inChecking("cash-unknown-code", -2_500, "CASH BACK", code("OTHER_OTHER")),
        ],
      });

      expect((await decisionOf("both"))?.step).toBe("5.7");
      expect((await shownAs("both")).parts).toEqual([
        { type: "Spending", category: "Superstores", source: "provider" },
      ]);
      for (const named of ["merchant-only", "word-only"]) {
        expect((await decisionOf(named))?.step).not.toBe("5.3");
        expect((await shownAs(named)).parts).not.toContainEqual(
          expect.objectContaining({ category: "Cash" }),
        );
      }
      expect((await decisionOf("code-only"))?.step).toBe("5.7");
      expect((await shownAs("code-only")).parts).toEqual([
        { type: "Spending", category: "Clothing", source: "provider" },
      ]);
      for (const cash of ["cash-alone", "cash-transfer-code", "cash-unknown-code"]) {
        expect((await decisionOf(cash))?.step).toBe("5.3");
        expect((await shownAs(cash)).parts).toEqual([
          { type: "Spending", category: "Cash", source: "money movement" },
        ]);
      }
    });
  });
});
