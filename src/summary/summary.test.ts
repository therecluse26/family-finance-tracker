import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import {
  alertList,
  markNotAProblem,
  startAnomalyChecks,
  startOverspendingChecks,
} from "../anomalies/index.ts";
import { DEMO_BANKS, DEMO_MEMBERS, seedDemoHousehold } from "../bank/demo.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { draftFirstBudgets, editBudget, startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addGoal,
  type Database,
  deleteRemovedConnection,
  listAccounts,
  listConnections,
  markConnectionRemoved,
  readHouseholdSummary,
  replaceRecurringCharges,
  storeHouseholdSummary,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startGoal } from "../goals/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import type { LogFields, Logger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { propose } from "../proposals/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import {
  HISTORY_MONTHS,
  householdSummary,
  isDeliveryService,
  SUMMARY_TOKENS,
  summaryTokens,
} from "./index.ts";

// The Household summary (spec 08, Household summary) on the demo Household, with AI SDK test
// models: no test calls an AI provider. The demo history runs from May 2025 to October 2026, and
// loads on November 1, 2026. The summary is read as the Writer model reads it.

const LOADED = new Date("2026-11-01T14:00:00.000Z");
const NOW = new Date("2026-11-20T14:00:00.000Z");
const PRICE = { input: 1_000_000, output: 2_000_000 };

async function addMembers(database: Database, names: readonly string[]) {
  for (const [index, name] of names.entries()) {
    await database.$client.execute({
      sql: `INSERT INTO members (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: [
        `member-${index + 1}`,
        name,
        `${name.toLowerCase().replace(/\W+/g, ".")}@example.com`,
        `2026-10-0${index + 1}T00:00:00.000Z`,
        `2026-10-0${index + 1}T00:00:00.000Z`,
      ],
    });
  }
}

// A Household AI with a Writer test model, which keeps each prompt as the model got it.
async function connectAi(bank: TestBank, stub: StubModels) {
  const options: AiOptions = {
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    notices: { raise: async () => {}, end: async () => {} },
  };
  const saved = await aiSettings(options).save({
    provider: "anthropic",
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });
  expect(saved).toMatchObject({ saved: true });
  return householdAi(options);
}

// The Household summary as the Writer model read it in its last call: the first message after the
// fixed rules.
function summaryTheModelRead(stub: StubModels): string {
  const [summary] = (stub.prompts.at(-1) ?? []).filter(
    (message: StubMessage) => message.role === "user",
  );
  const content = summary?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

describe("the Household summary on the demo Household", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let stub: StubModels;
  let ai: Awaited<ReturnType<typeof connectAi>>;
  let now = LOADED;
  const clock = () => now;
  const summary = () => householdSummary({ database: bank.database, ai, now: clock });

  beforeAll(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      startRecurringCharges({ database: bank.database, now: clock }).stop,
      startBudgets({ database: bank.database, now: clock }).stop,
      startAnomalyChecks({ database: bank.database, now: clock }).stop,
      startOverspendingChecks({ database: bank.database, now: clock }).stop,
    ];
    await addMembers(
      bank.database,
      DEMO_MEMBERS.map((member) => `${member.firstName} ${member.lastName}`),
    );
    await seedDemoHousehold(bank.database, bank.fake, clock);
    await runFollowUp(clock);
    await draftFirstBudgets(bank.database, LOADED);
    const savings = (await listAccounts(bank.database)).find(
      (account) => account.subtype === "savings",
    );
    // One Goal by each Member.
    const restaurants = await addGoal(bank.database, {
      words: "Spend less at restaurants",
      authorId: "member-2",
      date: "2026-11-01",
      target: { kind: "Category", category: "Restaurants" },
      change: { amount: 10_000 },
      deadline: null,
    });
    await startGoal(bank.database, restaurants, { goalAmount: 30_000, now: LOADED });
    const save = await addGoal(bank.database, {
      words: "Put away for a summer trip",
      authorId: "member-1",
      date: "2026-11-01",
      target: { kind: "Accounts", accountIds: [savings?.id ?? ""] },
      change: { amount: 300_000 },
      deadline: "2027-06-30",
    });
    await startGoal(bank.database, save, { now: LOADED });
    // A Member marks one Alert "Not a problem": the first by its text, so each run marks the same.
    const [marked] = (await alertList(bank.database)).sort((a, b) => a.text.localeCompare(b.text));
    if (marked !== undefined) await markNotAProblem(bank.database, marked.id, "member-2", LOADED);
    now = NOW;
    stub = new StubModels();
    ai = await connectAi(bank, stub);
  }, 120_000);

  afterAll(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("matches the stored snapshot, within 4,000 tokens", async () => {
    const { text } = await summary().today();

    expect(summaryTokens(text)).toBeLessThanOrEqual(SUMMARY_TOKENS);
    await expect(text).toMatchFileSnapshot("./__snapshots__/demo-summary.txt");
  });

  it("holds every part, and no raw Transaction", async () => {
    const { text } = await summary().today();

    for (const heading of [
      "## The month",
      "## Per Category, 2026-11",
      `## Per Category, Spending in each complete month, 2025-11 to 2026-10`,
      "## Money flow in each complete month",
      "## Habit counts",
      "## Balances",
      // A late Recurring charge shows on today: the window starts on it.
      "## Coming up, 2026-11-20 to 2026-12-04",
      "## Recurring charges",
      "## Goals",
      "## Alerts in the last 7 days",
      "## Proposals",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Today is 2026-11-20, day 20 of the 30 days of 2026-11. Days left: 10.");
    expect(text).toContain("Steady Income: ");
    // No Transaction's ID or bank description.
    const rows = (
      await bank.database.$client.execute("SELECT id, description FROM transactions")
    ).rows.map((row) => ({ id: String(row.id), description: String(row.description) }));
    for (const row of rows) {
      expect(text).not.toContain(row.id);
      expect(text).not.toContain(row.description);
    }
  });

  it("names each Goal's author by their name, and holds no email address", async () => {
    const { text } = await summary().today();

    expect(text).toContain('- "Spend less at restaurants", by Alex Rivera on 2026-11-01;');
    expect(text).toContain('- "Put away for a summer trip", by Jamie Rivera on 2026-11-01;');
    expect(text).toContain('Marked "Not a problem" by Alex Rivera on 2026-11-01.');
    for (const member of DEMO_MEMBERS) expect(text).not.toContain(member.email);
  });

  it("names each Account by its name and last 4", async () => {
    const { text } = await summary().today();
    const names = await ai.accountNames();

    for (const account of await listAccounts(bank.database)) {
      if (account.closedAt === null && !account.excluded) {
        expect(names.get(account.id)).toBe(
          account.mask === null ? account.name : `${account.name} ending ${account.mask}`,
        );
        expect(text).toContain(`- ${names.get(account.id)}: `);
      }
    }
  });

  it("goes to the model whole", async () => {
    const { parts, text } = await summary().today();

    expect(
      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." }),
    ).toMatchObject({ ready: true });

    expect(summaryTheModelRead(stub)).toBe(text);
  });

  it("sends each amount, date, month, and count the app made as it is, even when a last 4 matches it", async () => {
    const { parts, text } = await summary().today();
    // Fitness is 49.99 a month and Housing 1850.00; every date starts 2026; checking holds
    // 18950.32; today is day 20 of the month's 30; the Capital One card's APR is 28.49%.
    for (const made of [
      "49.99",
      "1850.00",
      "2026-11-20",
      "18950.32",
      "day 20 of the 30 days",
      "APR 28.49%",
    ]) {
      expect(text).toContain(made);
    }
    const accounts = await listAccounts(bank.database);
    const setMask = (name: string, mask: string | null) =>
      bank.database.$client.execute({
        sql: "UPDATE household_accounts SET mask = ? WHERE id = ?",
        args: [mask, accounts.find((account) => account.name === name)?.id ?? ""],
      });
    const masks = [
      ["Interest Checking", "4999"],
      ["Online Savings", "1850"],
      ["Chase Card", "2026"],
      ["Rewards Card", "2849"],
    ] as const;
    for (const [name, mask] of masks) await setMask(name, mask);
    expect(
      await saveHouseholdFacts(
        bank.database,
        { zipCode: "18950", ages: [20, 30], rentOrOwn: "rent" },
        "member-1",
        NOW,
      ),
    ).toMatchObject({ saved: { zipCode: "18950" } });
    try {
      // Sent as one text or as its parts, the model reads the same summary.
      await ai.generate({ use: "insight cards", summary: text, task: "Write the cards." });
      expect(summaryTheModelRead(stub)).toBe(text);

      expect(
        await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." }),
      ).toMatchObject({ ready: true });
      const read = summaryTheModelRead(stub);
      expect(read).toBe(text);
      expect(read).not.toMatch(/\\\p{L}/u);

      // A Goal's words reach the model as the Member wrote them, on one line.
      await addGoal(bank.database, {
        words: "Pay card 4999 and\nsave 18950 for our 20 year old",
        authorId: "member-1",
        date: "2026-11-24",
        target: null,
        change: null,
        deadline: null,
      });
      now = new Date("2026-11-25T14:00:00.000Z");
      const later = await summary().today();
      await ai.generate({ use: "insight cards", summary: later.parts, task: "Write the cards." });
      const readLater = summaryTheModelRead(stub);
      expect(readLater).toBe(later.text);
      const goalLine = readLater.split("\n").find((line) => line.startsWith('- "Pay card')) ?? "";
      expect(goalLine).toContain(
        '- "Pay card 4999 and save 18950 for our 20 year old", by Jamie Rivera on 2026-11-24',
      );
    } finally {
      now = NOW;
      for (const [name] of masks) {
        const demo = DEMO_BANKS.flatMap((each) => each.accounts).find(
          (account) => account.name === name,
        );
        await setMask(name, demo?.mask ?? null);
      }
    }
  });

  it("sends the amounts in an Alert and in a Goal's progress as they are, even when a last 4 matches them", async () => {
    const { parts, text } = await summary().today();
    const alertLine = text.split("\n").find((line) => line.includes("Price increase:")) ?? "";
    const goalLine = text.split("\n").find((line) => line.startsWith('- "Put away')) ?? "";
    // The demo's "Not a problem" Alert went from $70.37 to $103.24 (+$32.87); the summer trip
    // Goal's progress is $19,971 of $22,971, written in whole dollars with no comma.
    expect(alertLine).toContain("went up from $70.37 to $103.24 (+$32.87, +47%) on 2026-06-10.");
    expect(goalLine).toContain("progress: 0% done, Behind, $19971 of $22971, and $237 behind pace");

    const accounts = await listAccounts(bank.database);
    const setMask = (name: string, mask: string | null) =>
      bank.database.$client.execute({
        sql: "UPDATE household_accounts SET mask = ? WHERE id = ?",
        args: [mask, accounts.find((account) => account.name === name)?.id ?? ""],
      });
    const masks = [
      ["Interest Checking", "7037"],
      ["Rewards Card", "3287"],
    ] as const;
    for (const [name, mask] of masks) await setMask(name, mask);
    await saveHouseholdFacts(
      bank.database,
      { zipCode: "22971", ages: [20, 30], rentOrOwn: "rent" },
      "member-1",
      NOW,
    );
    try {
      await ai.generate({ use: "insight cards", summary: text, task: "Write the cards." });
      const asText = summaryTheModelRead(stub).split("\n");
      expect(asText).toContain(alertLine);
      expect(asText).toContain(goalLine);

      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." });
      const read = summaryTheModelRead(stub).split("\n");
      expect(read).toContain(alertLine);
      expect(read).toContain(goalLine);
    } finally {
      for (const [name] of masks) {
        const demo = DEMO_BANKS.flatMap((each) => each.accounts).find(
          (account) => account.name === name,
        );
        await setMask(name, demo?.mask ?? null);
      }
      await saveHouseholdFacts(
        bank.database,
        { zipCode: "18950", ages: [20, 30], rentOrOwn: "rent" },
        "member-1",
        NOW,
      );
    }
  });

  it("is built once a day: later Writer uses that day read the same text", async () => {
    const first = await summary().today();
    const stored = await readHouseholdSummary(bank.database);
    expect(stored?.day).toBe("2026-11-20");
    // Stored as its pieces.
    expect(stored?.text).toContain('{"amount":');

    // A Goal added later that day stays out until the next day's summary.
    await addGoal(bank.database, {
      words: "Pay the card off",
      authorId: "member-1",
      date: "2026-11-20",
      target: null,
      change: null,
      deadline: null,
    });
    expect(await summary().today()).toEqual(first);

    now = new Date("2026-11-21T14:00:00.000Z");
    try {
      const { text: next } = await summary().today();
      expect(next).not.toBe(first.text);
      expect(next).toContain('"Pay the card off", by Jamie Rivera');
      expect(next).toContain("Today is 2026-11-21");
      expect((await readHouseholdSummary(bank.database))?.day).toBe("2026-11-21");
    } finally {
      now = NOW;
    }
  });

  it("builds the Monthly review's summary anew, for the month just ended", async () => {
    await summary().today();
    const stored = await readHouseholdSummary(bank.database);
    now = new Date("2026-12-01T17:00:00.000Z");
    try {
      const { text: review } = await summary().monthJustEnded();

      expect(review).toContain(
        "Today is 2026-12-01. The month 2026-11 has ended, all 30 days of it.",
      );
      expect(review).toContain("## Per Category, 2026-11:");
      expect(review).toContain("Spending in each complete month, 2025-11 to 2026-10");
      expect(review).toContain("Alerts the weekly cap held back in 2026-11:");
      expect(summaryTokens(review)).toBeLessThanOrEqual(SUMMARY_TOKENS);
      // It is not stored: the day's own summary stays.
      expect(await readHouseholdSummary(bank.database)).toEqual(stored);
    } finally {
      now = NOW;
    }
  });

  it("lists no Alert found in the history load as a current Alert", async () => {
    const found = (await alertList(bank.database)).filter(
      (alert) => alert.state === "found in history",
    );
    expect(found.length).toBeGreaterThan(0);
    // Made on November 1, the day the history loaded: within 7 days of November 2.
    now = new Date("2026-11-02T14:00:00.000Z");
    try {
      const { text } = await summary().monthJustEnded();
      const recent = text.slice(text.indexOf("## Alerts in the last 7 days")).split("\n");

      expect(recent.slice(0, 2)).toEqual(["## Alerts in the last 7 days", "- None."]);
    } finally {
      now = NOW;
    }
  });

  it("sends a Member's words and names as they are, and never the ZIP code or ages", async () => {
    const zipCode = "10001";
    const ages = [47, 13];
    expect(
      await saveHouseholdFacts(
        bank.database,
        { zipCode, ages, rentOrOwn: "rent" },
        "member-1",
        NOW,
      ),
    ).toMatchObject({ saved: { zipCode } });
    const accounts = await listAccounts(bank.database);
    const card = accounts.find((account) => account.kind === "credit");
    // A Goal's words, as a Member wrote them: a name after a tab and a last 4 after a line break.
    await addGoal(bank.database, {
      words: `Before\tJamie turns ten, Alex pays card\n${card?.mask}`,
      authorId: "member-2",
      date: "2026-11-21",
      target: null,
      change: null,
      deadline: null,
    });
    now = new Date("2026-11-22T14:00:00.000Z");
    try {
      const { parts, text } = await summary().today();
      expect(text).toContain(
        `- "Before Jamie turns ten, Alex pays card ${card?.mask}", by Alex Rivera on 2026-11-21`,
      );
      // The summary is one text the AI reads as it is: no control character but a line break, so
      // no field starts a line of its own, and no backslash before a letter.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters it looks for.
      expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/u);
      expect(text).not.toMatch(/\\\p{L}/u);

      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." });
      const read = summaryTheModelRead(stub);
      expect(read).toBe(text);
      // The Household facts never go in.
      expect(read).not.toContain(zipCode);
    } finally {
      now = NOW;
    }
  });

  it("names the Account of a Card interest or Duplicate charge Alert by its name and last 4", async () => {
    const chase = (await listConnections(bank.database)).find(
      (connection) => connection.bankId === "fake-chase",
    );
    const charge = (id: string, spent: number, description: string, category: string) =>
      fakeTxn({
        id,
        accountId: "demo-chase-card",
        amount: -spent,
        postedDate: "2026-11-23",
        description,
        merchantName: description === "NOODLE HOUSE" ? "Noodle House" : null,
        category: { name: category, confidence: "VERY_HIGH", version: "v2", mcc: null },
      });
    bank.fake.addPages("fake-chase", {
      added: [
        charge(
          "chase-interest",
          1_234,
          "INTEREST CHARGE ON PURCHASES",
          "BANK_FEES_INTEREST_CHARGE",
        ),
        charge("noodles-1", 4_321, "NOODLE HOUSE", "FOOD_AND_DRINK_RESTAURANT"),
        charge("noodles-2", 4_321, "NOODLE HOUSE", "FOOD_AND_DRINK_RESTAURANT"),
      ],
    });
    now = new Date("2026-11-24T14:00:00.000Z");
    try {
      await syncConnection(chase?.id ?? "", clock);
      await runFollowUp(clock);
      const kinds = (await alertList(bank.database))
        .filter((alert) => alert.state !== "found in history")
        .map((alert) => alert.kind);
      expect(kinds).toEqual(expect.arrayContaining(["Card interest or fee", "Duplicate charge"]));

      const { text } = await summary().today();
      const recent = text.slice(text.indexOf("## Alerts in the last 7 days")).split("\nAlerts")[0];
      const card = (await listAccounts(bank.database)).find(
        (account) => account.name === "Chase Card",
      );
      const label = (await ai.accountNames()).get(card?.id ?? "") ?? "";
      expect(label).toBe(`Chase Card ending ${card?.mask}`);
      const lines = recent?.split("\n") ?? [];
      const interest = lines.find((line) => line.includes("Card interest or fee:")) ?? "";
      const duplicate = lines.find((line) => line.includes("Duplicate charge:")) ?? "";
      expect(interest).toContain(` on ${label} `);
      expect(duplicate).toContain(label);
    } finally {
      now = NOW;
    }
  });

  it("drops the oldest months of per-Category history until it fits in 4,000 tokens", async () => {
    const { text: before } = await summary().today();
    // Long Goals push the summary about 600 characters past 4,000 tokens: less than its 12 months of
    // per-Category history.
    const phrase = "keep the grocery list short and cook at home on weeknights. ";
    const goalLine = 150;
    const over = SUMMARY_TOKENS * 4 + 600 - before.length;
    const count = Math.ceil(over / (phrase.length * 4 + goalLine));
    for (let index = 0; index < count; index += 1) {
      await addGoal(bank.database, {
        words: `Goal ${index + 1}: ${phrase.repeat(4)}`,
        authorId: "member-1",
        date: "2026-11-22",
        target: null,
        change: null,
        deadline: null,
      });
    }
    now = new Date("2026-11-23T14:00:00.000Z");
    try {
      const { text } = await summary().today();

      expect(summaryTokens(text)).toBeLessThanOrEqual(SUMMARY_TOKENS);
      expect(summaryTokens(before)).toBeLessThan(SUMMARY_TOKENS);
      const header =
        /## Per Category, Spending in each complete month, (\d{4}-\d{2}) to (\d{4}-\d{2})/u.exec(
          text,
        );
      // The newest months stay; the oldest go first.
      expect(header?.[2]).toBe("2026-10");
      expect(header?.[1]).not.toBe("2025-11");
      const monthNumber = (month = "") =>
        Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
      const kept = monthNumber(header?.[2]) - monthNumber(header?.[1]) + 1;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(HISTORY_MONTHS);
      // Each Category's history row labels the latest months kept, at most 6, and its average,
      // low, and high cover every month kept.
      expect(text).toContain(
        `${header?.[0]}: the latest ${Math.min(kept, 6)}, then the average, low, and high of all ${kept}`,
      );
      const rows = text
        .slice(text.indexOf(header?.[0] ?? ""))
        .split("\n## ")[0]
        ?.split("\n")
        .filter((line) => line.startsWith("- "));
      expect(rows?.length).toBeGreaterThan(0);
      for (const row of rows ?? []) {
        expect(row.split("; ")[0]?.split(", ")).toHaveLength(Math.min(kept, 6));
        expect(row).toContain(`${header?.[2]} `);
      }
      // Every Goal is still there.
      expect(text).toContain(`Goal ${count}: keep the grocery list short`);
      // One more month would not fit.
      expect(summaryTokens(text)).toBeGreaterThan(SUMMARY_TOKENS - 200);
    } finally {
      now = NOW;
    }
  });

  it("lists each open Proposal, with the app's amounts as they are", async () => {
    // A Goal with no Goal amount yet, for a Goal amount Proposal.
    const groceries = await addGoal(bank.database, {
      words: "Spend less on groceries",
      authorId: "member-1",
      date: "2026-11-27",
      target: { kind: "Category", category: "Groceries" },
      change: null,
      deadline: null,
    });
    const card = (await listAccounts(bank.database)).find(
      (account) => account.name === "Rewards Card",
    );
    const setMask = (mask: string | null) =>
      bank.database.$client.execute({
        sql: "UPDATE household_accounts SET mask = ? WHERE id = ?",
        args: [mask, card?.id ?? ""],
      });
    now = new Date("2026-11-27T14:00:00.000Z");
    try {
      const amount = await propose(
        bank.database,
        {
          kind: "Goal amount",
          source: "Monthly review",
          runId: "review-2026-10",
          reason: "A set amount shows how far along the Goal is.",
          goalId: groceries,
          goalAmount: 482_100,
        },
        now,
      );
      const goal = await propose(
        bank.database,
        {
          kind: "new Goal",
          source: "Monthly review",
          runId: "review-2026-10",
          reason: "Lunches out were a third of Restaurants.",
          words: "Pack lunch\u0007three days a week",
        },
        now,
      );
      expect([amount.outcome, goal.outcome]).toEqual(["shown", "shown"]);
      // The Goal amount's digits are a card's last 4.
      await setMask("4821");

      const { text, parts } = await summary().today();
      const section = text.slice(text.indexOf("## Proposals"));
      expect(section.split("\n").slice(0, 3)).toEqual([
        "## Proposals",
        '- Made 2026-11-27: Goal amount, from Monthly review: Goal amount of 4821.00 for the Goal "Spend less on groceries". Reason: "A set amount shows how far along the Goal is."',
        '- Made 2026-11-27: new Goal, from Monthly review: new Goal "Pack lunch three days a week". Reason: "Lunches out were a third of Restaurants."',
      ]);

      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." });
      expect(summaryTheModelRead(stub)).toContain("Goal amount of 4821.00 for the Goal");
      await ai.generate({ use: "insight cards", summary: text, task: "Write the cards." });
      expect(summaryTheModelRead(stub)).toContain("Goal amount of 4821.00 for the Goal");
    } finally {
      await setMask(
        DEMO_BANKS.flatMap((each) => each.accounts).find(
          (account) => account.name === "Rewards Card",
        )?.mask ?? null,
      );
      now = NOW;
    }
  });

  it("goes as it is when still over 4,000 tokens with no history left, and logs its size only", async () => {
    const lines: { level: string; message: string; fields?: LogFields }[] = [];
    const logger: Logger = {
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warn: (message, fields) => lines.push({ level: "warn", message, fields }),
      error: (message, fields) => lines.push({ level: "error", message, fields }),
    };
    // More long Goals than 12 months of per-Category history can make room for.
    for (let index = 0; index < 20; index += 1) {
      await addGoal(bank.database, {
        words: `Long Goal ${index + 1}: ${"walk to the shops and pack lunches for work. ".repeat(8)}`,
        authorId: "member-1",
        date: "2026-11-25",
        target: null,
        change: null,
        deadline: null,
      });
    }
    now = new Date("2026-11-26T14:00:00.000Z");
    try {
      const { text } = await householdSummary({
        database: bank.database,
        ai,
        now: clock,
        logger,
      }).today();

      expect(summaryTokens(text)).toBeGreaterThan(SUMMARY_TOKENS);
      expect(text).not.toContain("Spending in each complete month");
      expect(text).toContain("Long Goal 20: walk to the shops");
      expect(lines).toEqual([
        {
          level: "warn",
          message: expect.any(String),
          fields: { size: summaryTokens(text), limit: SUMMARY_TOKENS },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain("walk to the shops");
    } finally {
      now = NOW;
    }
  });
});

describe("the Habit counts", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;
  const NOVEMBER_5 = new Date("2026-11-05T14:00:00.000Z");
  const clock = () => NOVEMBER_5;
  const ACCOUNT = "habit-card";

  // A posted purchase of `spent` whole cents, on `date`, with Plaid's category.
  const purchase = (
    id: string,
    date: string,
    spent: number,
    merchantName: string,
    category: string,
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: ACCOUNT,
      amount: -spent,
      postedDate: date,
      description: merchantName.toUpperCase(),
      merchantName,
      category: { name: category, confidence: "VERY_HIGH", version: "v2", mcc: null },
    });

  beforeAll(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      startRecurringCharges({ database: bank.database, now: clock }).stop,
    ];
    await addMembers(bank.database, ["Dana Okafor"]);
    connectionId = await bank.connect("fake-habits", "Habit Bank");
    const restaurant = "FOOD_AND_DRINK_RESTAURANT";
    bank.fake.addPages("fake-habits", {
      accounts: [
        fakeAccount({ id: ACCOUNT, type: "credit", subtype: "credit card", mask: "2468" }),
        // A card and a loan with a payment due in Coming up, each named for a Member.
        fakeAccount({
          id: "habit-store-card",
          name: "Dana Okafor Store Card",
          type: "credit",
          subtype: "credit card",
          mask: "1357",
          currentBalance: -9_000,
          card: {
            aprs: [],
            statementBalance: -7_500,
            minimumPayment: 2_500,
            dueDate: "2026-11-12",
            statementIssueDate: "2026-10-15",
          },
        }),
        fakeAccount({
          id: "habit-loan",
          name: "Dana Okafor Car Loan",
          type: "loan",
          subtype: "auto",
          mask: "9753",
          currentBalance: -800_000,
          loan: {
            apr: 6.5,
            principal: 800_000,
            interestPaidThisYear: null,
            minimumPayment: 31_000,
            dueDate: "2026-11-15",
          },
        }),
      ],
      added: [
        // October 2026: the 2nd is a Friday, the 3rd a Saturday, the 4th a Sunday.
        purchase("bistro-1", "2026-10-02", 3_000, "Corner Bistro", restaurant),
        purchase("bistro-2", "2026-10-03", 2_000, "Corner Bistro", restaurant),
        purchase("bistro-3", "2026-10-06", 5_000, "Corner Bistro", restaurant),
        purchase("doordash", "2026-10-04", 2_500, "DoorDash", restaurant),
        purchase("uber-eats", "2026-10-07", 1_500, "Uber Eats", restaurant),
        purchase("uber", "2026-10-08", 1_200, "Uber", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"),
        purchase("market-1", "2026-10-09", 10_000, "Fresh Market", "FOOD_AND_DRINK_GROCERIES"),
        purchase("market-2", "2026-10-12", 30_000, "Fresh Market", "FOOD_AND_DRINK_GROCERIES"),
        purchase(
          "power",
          "2026-10-10",
          8_000,
          "City Power",
          "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
        ),
        // September 2026: one Grubhub order on a Monday.
        purchase("grubhub", "2026-09-14", 1_800, "GRUBHUB*TAQUERIA", restaurant),
      ],
    });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
  }, 60_000);

  afterAll(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  const summaryOf = async () => {
    const ai = householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    });
    return (await householdSummary({ database: bank.database, ai, now: clock }).today()).text;
  };

  it("counts meals out, delivery orders, the Friday-to-Sunday share, and the frequent Merchants per month", async () => {
    const text = await summaryOf();
    const habits = text.slice(text.indexOf("## Habit counts")).split("\n\n")[0];

    expect(habits).toBe(
      [
        "## Habit counts",
        "In 2026-09: meals out (Restaurants Transactions) 1, average meal out 18.00, delivery orders 1.",
        "- Share of Spending made Friday to Sunday: Restaurants 0%",
        "- Most frequent Merchants, with Transactions, Spending, and the average Transaction: GRUBHUB*TAQUERIA 1 for 18.00, average 18.00",
        // Restaurants: $30 + $20 + $50 + $25 + $15 = $140 over 5 meals out.
        "In 2026-10: meals out (Restaurants Transactions) 5, average meal out 28.00, delivery orders 2.",
        // Restaurants: $30 + $20 + $25 of $140. Groceries: $100 of $400. Utilities is a Bill.
        "- Share of Spending made Friday to Sunday: Groceries 25%, Restaurants 54%, Transit and rideshare 0%",
        // Corner Bistro: $100 over 3 Transactions is $33.333, to the cent.
        "- Most frequent Merchants, with Transactions, Spending, and the average Transaction: Corner Bistro 3 for 100.00, average 33.33; Fresh Market 2 for 400.00, average 200.00; City Power 1 for 80.00, average 80.00; DoorDash 1 for 25.00, average 25.00; Uber Eats 1 for 15.00, average 15.00; Uber 1 for 12.00, average 12.00",
        // No meal out: no average.
        "In 2026-11, so far: meals out (Restaurants Transactions) 0, delivery orders 0.",
        "- Share of Spending made Friday to Sunday: none",
        "- Most frequent Merchants, with Transactions, Spending, and the average Transaction: none",
      ].join("\n"),
    );
  });

  it("names a card or loan payment in Coming up by its Account's name and last 4", async () => {
    const text = await summaryOf();
    const labels = await householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    }).accountNames();
    const accounts = await listAccounts(bank.database);
    const labelOf = (name: string) =>
      labels.get(accounts.find((account) => account.name === name)?.id ?? "");
    const comingUp = text.slice(text.indexOf("## Coming up")).split("\n\n")[0] ?? "";

    expect(comingUp).toContain(
      `- 2026-11-12: ${labelOf("Dana Okafor Store Card")} payment, -75.00, card payment`,
    );
    expect(comingUp).toContain(
      `- 2026-11-15: ${labelOf("Dana Okafor Car Loan")} payment, -310.00, loan payment`,
    );
  });

  it("builds the day's summary again when the stored one is not its pieces", async () => {
    const built = await summaryOf();
    for (const text of [
      "Household summary as plain text",
      JSON.stringify(["Fitness: ", { amount: "49.99" }]),
      JSON.stringify(["Fitness: ", { amount: 4_999, note: "card 4999" }]),
      JSON.stringify({ amount: 4_999 }),
    ]) {
      await storeHouseholdSummary(bank.database, { day: "2026-11-05", text }, NOVEMBER_5);

      expect(await summaryOf()).toBe(built);
    }
  });

  it("knows each delivery service in the forms banks write it, and nothing else", () => {
    for (const name of [
      "DoorDash",
      "DOORDASH*TAQUERIA",
      "Door Dash",
      "UBEREATS",
      "Uber Eats Pending",
      "GRUBHUB",
      "Postmates",
      "SEAMLESS*THAI PALACE",
      "Caviar",
      "goPuff",
    ]) {
      expect(isDeliveryService(name)).toBe(true);
    }
    for (const name of ["Uber", "Uber Trip", "DoorDashery Cafe", "Lyft"]) {
      expect(isDeliveryService(name)).toBe(false);
    }
  });

  it("is cleared by Delete history, so the next Writer use builds it without that history", async () => {
    const before = await summaryOf();
    expect(before).toContain("Corner Bistro");
    expect((await readHouseholdSummary(bank.database))?.text).toContain("Corner Bistro");

    expect(await markConnectionRemoved(bank.database, connectionId, NOVEMBER_5)).toMatchObject({
      removed: true,
    });
    expect(await deleteRemovedConnection(bank.database, connectionId, NOVEMBER_5)).toBeDefined();

    expect(await readHouseholdSummary(bank.database)).toBeUndefined();
    const after = await summaryOf();
    expect(after).not.toContain("Corner Bistro");
    expect(after).toContain(
      "In 2026-10: meals out (Restaurants Transactions) 0, delivery orders 0.",
    );
    expect(await listConnections(bank.database)).toEqual([]);
  });
});

describe("the app's figures, on a hand-worked Household", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  // November 10, 2026: day 10 of 30, with 20 days left. The Household has no ZIP code: UTC.
  const NOVEMBER_10 = new Date("2026-11-10T14:00:00.000Z");
  const clock = () => NOVEMBER_10;
  const CARD = "figures-card";
  const CHECKING = "figures-checking";
  const GROCERIES = "FOOD_AND_DRINK_GROCERIES";
  const RESTAURANT = "FOOD_AND_DRINK_RESTAURANT";
  const GAS = "TRANSPORTATION_GAS";
  const MOVIES = "ENTERTAINMENT_TV_AND_MOVIES";
  const HARDWARE = "HOME_IMPROVEMENT_HARDWARE";
  const INSURANCE = "GENERAL_SERVICES_INSURANCE";
  // Harbor Insurance's prices, in dollars: up, the same, up, then down.
  const INSURANCE_PRICES: [string, number][] = [
    ["2026-06-08", 100],
    ["2026-07-08", 110],
    ["2026-08-08", 110],
    ["2026-09-08", 125],
    ["2026-10-08", 120],
  ];

  // A posted card purchase of `dollars`, on `date`, with Plaid's category. Each is under $250 and
  // under half of its Category's Budget, so the projection extrapolates it.
  const purchase = (
    id: string,
    date: string,
    dollars: number,
    merchantName: string,
    category: string,
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD,
      amount: -dollars * 100,
      postedDate: date,
      description: merchantName.toUpperCase(),
      merchantName,
      category: { name: category, confidence: "VERY_HIGH", version: "v2", mcc: null },
    });
  const pay = (id: string, date: string, dollars: number): TxnRecord =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount: dollars * 100,
      postedDate: date,
      description: "PAYROLL CO DIRECT DEP",
      merchantName: "Payroll Co",
      category: { name: "INCOME_WAGES", confidence: "VERY_HIGH", version: "v2", mcc: null },
    });

  beforeAll(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    await addMembers(bank.database, ["Dana Okafor"]);
    const connectionId = await bank.connect("fake-figures", "Figures Bank");
    bank.fake.addPages("fake-figures", {
      accounts: [
        fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "2468" }),
        fakeAccount({ id: CHECKING, type: "depository", subtype: "checking", mask: "1357" }),
      ],
      added: [
        // Groceries: $200, $220, $230 in the 3 months before November: a 3-month average of
        // $216.67.
        purchase("g-aug-1", "2026-08-05", 120, "Fresh Market", GROCERIES),
        purchase("g-aug-2", "2026-08-19", 80, "Corner Grocer", GROCERIES),
        purchase("g-sep-1", "2026-09-04", 100, "Fresh Market", GROCERIES),
        purchase("g-sep-2", "2026-09-18", 120, "Corner Grocer", GROCERIES),
        purchase("g-oct-1", "2026-10-06", 110, "Fresh Market", GROCERIES),
        purchase("g-oct-2", "2026-10-20", 120, "Corner Grocer", GROCERIES),
        // Restaurants: $100, $80, $120: an average of $100.
        purchase("r-aug-1", "2026-08-07", 60, "Corner Bistro", RESTAURANT),
        purchase("r-aug-2", "2026-08-21", 40, "Noodle House", RESTAURANT),
        purchase("r-sep-1", "2026-09-09", 50, "Corner Bistro", RESTAURANT),
        purchase("r-sep-2", "2026-09-23", 30, "Noodle House", RESTAURANT),
        purchase("r-oct-1", "2026-10-09", 70, "Corner Bistro", RESTAURANT),
        purchase("r-oct-2", "2026-10-23", 50, "Noodle House", RESTAURANT),
        // Gas: $150 each month. Entertainment: $60 each month. Home and garden: $30 in October.
        purchase("gas-aug", "2026-08-15", 150, "QuickFuel", GAS),
        purchase("gas-sep", "2026-09-15", 150, "QuickFuel", GAS),
        purchase("gas-oct", "2026-10-15", 150, "QuickFuel", GAS),
        purchase("e-aug", "2026-08-12", 60, "Movie House", MOVIES),
        purchase("e-sep", "2026-09-12", 60, "Movie House", MOVIES),
        purchase("e-oct", "2026-10-12", 60, "Movie House", MOVIES),
        purchase("h-oct", "2026-10-25", 30, "Corner Hardware", HARDWARE),
        ...INSURANCE_PRICES.map(([date, dollars]) =>
          purchase(`ins-${date}`, date, dollars, "Harbor Insurance", INSURANCE),
        ),
        // Income: above Spending in August and October only.
        pay("pay-aug", "2026-08-28", 1_000),
        pay("pay-sep", "2026-09-28", 300),
        pay("pay-oct", "2026-10-28", 1_000),
        // November, to the 10th. Groceries: 5 Transactions at 4 Merchants, $120.
        purchase("g-nov-1", "2026-11-02", 40, "Fresh Market", GROCERIES),
        purchase("g-nov-2", "2026-11-03", 35, "Corner Grocer", GROCERIES),
        purchase("g-nov-3", "2026-11-05", 12, "Farm Stand", GROCERIES),
        purchase("g-nov-4", "2026-11-07", 25, "Fresh Market", GROCERIES),
        purchase("g-nov-5", "2026-11-09", 8, "Bakery Row", GROCERIES),
        // Restaurants: 3 meals out, $70.
        purchase("r-nov-1", "2026-11-01", 30, "Corner Bistro", RESTAURANT),
        purchase("r-nov-2", "2026-11-04", 25, "Noodle House", RESTAURANT),
        purchase("r-nov-3", "2026-11-08", 15, "Corner Bistro", RESTAURANT),
        // Gas: 3 Transactions, $60, already over its $50 Budget.
        purchase("gas-nov-1", "2026-11-02", 18, "QuickFuel", GAS),
        purchase("gas-nov-2", "2026-11-05", 20, "QuickFuel", GAS),
        purchase("gas-nov-3", "2026-11-09", 22, "QuickFuel", GAS),
        // Entertainment: 3 Transactions, $15, under its pace.
        purchase("e-nov-1", "2026-11-01", 5, "Movie House", MOVIES),
        purchase("e-nov-2", "2026-11-03", 5, "Movie House", MOVIES),
        purchase("e-nov-3", "2026-11-06", 5, "Movie House", MOVIES),
        // Home and garden: one $90 payment, the most at stake, but only 1 Transaction.
        purchase("h-nov", "2026-11-06", 90, "Corner Hardware", HARDWARE),
      ],
    });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    // A first draft, so a Member may edit a Budget. Only Groceries and Gas keep one.
    await draftFirstBudgets(bank.database, NOVEMBER_10);
    await bank.database.$client.execute(
      "DELETE FROM budgets WHERE category NOT IN ('Groceries', 'Gas')",
    );
    for (const [category, dollars] of [
      ["Groceries", 300],
      ["Gas", 50],
    ] as const) {
      expect(
        await editBudget(
          bank.database,
          { category, amount: dollars * 100, memberId: "member-1" },
          NOVEMBER_10,
        ),
      ).toBeDefined();
    }
    // Harbor Insurance as a Recurring charge, due on November 8 and not yet charged: late.
    const ids = new Map(
      (
        await bank.database.$client.execute("SELECT id, provider_transaction_id FROM transactions")
      ).rows.map((row) => [String(row.provider_transaction_id), String(row.id)]),
    );
    const [account] = (
      await bank.database.$client.execute({
        sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
        args: [CARD],
      })
    ).rows;
    await replaceRecurringCharges(bank.database, [
      {
        id: "charge-harbor",
        merchantId: null,
        merchantName: "Harbor Insurance",
        category: "Insurance",
        schedule: "monthly",
        nextExpectedDate: "2026-11-08",
        latestAmount: 12_000,
        priceHistory: INSURANCE_PRICES.map(([date, dollars]) => ({
          transactionId: ids.get(`ins-${date}`) ?? "",
          date,
          amount: dollars * 100,
        })),
        accountId: String(account?.id),
        status: "active",
        foundAt: NOVEMBER_10,
        endedAt: null,
        endedBy: null,
      },
    ]);
  }, 60_000);

  afterAll(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  const summaryText = async () => {
    const ai = householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    });
    return (await householdSummary({ database: bank.database, ai, now: clock }).today()).text;
  };
  // One part of the summary, from its heading to the blank line after it.
  const part = (text: string, heading: string) =>
    text.slice(text.indexOf(heading)).split("\n\n")[0]?.split("\n") ?? [];

  it("gives each current-month Category its Spending per day so far", async () => {
    const lines = part(await summaryText(), "## Per Category, 2026-11");

    expect(lines).toEqual([
      "## Per Category, 2026-11: Spending, Budget, status, projected month-end Spending, and Spending per day so far",
      // P = F × 30 ÷ 10: $120 × 3 = $360. $120 over 10 days is $12 a day.
      "- Groceries: 120.00 of a Budget of 300.00, On pace, projected 360.00, 12.00 a day so far",
      "- Home and garden: 90.00, no Budget, projected 270.00, 9.00 a day so far",
      "- Gas: 60.00 of a Budget of 50.00, Over Budget, projected 180.00, 6.00 a day so far",
      "- Restaurants: 70.00, no Budget, projected 210.00, 7.00 a day so far",
      "- Entertainment: 15.00, no Budget, projected 45.00, 1.50 a day so far",
    ]);
  });

  it("ranks the Biggest changes by the dollars at stake, and leaves out a Category with fewer than 3 Transactions", async () => {
    const lines = part(await summaryText(), "## Biggest changes");

    expect(lines).toEqual([
      "## Biggest changes, 2026-11: the most dollars at stake first",
      "At stake is the larger of projected Spending over Budget and projected Spending over the 3-month average. A Category with fewer than 3 Transactions this month is left out.",
      // $360 − $216.67 = $143.33 beats $360 − $300 = $60. ($300 − $120) ÷ 20 days = $9 a day.
      "- Groceries: 143.33 at stake; projected 360.00, Budget 300.00, 3-month average 216.67; 9.00 a day for the 20 days left keeps it in Budget",
      // $180 − $50 = $130 beats $180 − $150 = $30.
      "- Gas: 130.00 at stake; projected 180.00, Budget 50.00, 3-month average 150.00; already 10.00 over Budget",
      // $210 − $100. Home and garden ($270 − $10 = $260) has 1 Transaction; Entertainment's $45 is
      // under its $60 average.
      "- Restaurants: 110.00 at stake; projected 210.00, no Budget, 3-month average 100.00",
    ]);
  });

  it("labels each history value with its month, then gives the 12-month average, low, and high", async () => {
    const lines = part(await summaryText(), "## Per Category, Spending in each complete month");

    expect(lines).toEqual([
      "## Per Category, Spending in each complete month, 2025-11 to 2026-10: the latest 6, then the average, low, and high of all 12",
      // $565 ÷ 12 = $47.08. A tie goes to the latest month.
      "- Insurance: 2026-05 0.00, 2026-06 100.00, 2026-07 110.00, 2026-08 110.00, 2026-09 125.00, 2026-10 120.00; average 47.08, low 0.00 in 2026-05, high 125.00 in 2026-09",
      "- Groceries: 2026-05 0.00, 2026-06 0.00, 2026-07 0.00, 2026-08 200.00, 2026-09 220.00, 2026-10 230.00; average 54.17, low 0.00 in 2026-07, high 230.00 in 2026-10",
      "- Home and garden: 2026-05 0.00, 2026-06 0.00, 2026-07 0.00, 2026-08 0.00, 2026-09 0.00, 2026-10 30.00; average 2.50, low 0.00 in 2026-09, high 30.00 in 2026-10",
      "- Gas: 2026-05 0.00, 2026-06 0.00, 2026-07 0.00, 2026-08 150.00, 2026-09 150.00, 2026-10 150.00; average 37.50, low 0.00 in 2026-07, high 150.00 in 2026-10",
      "- Restaurants: 2026-05 0.00, 2026-06 0.00, 2026-07 0.00, 2026-08 100.00, 2026-09 80.00, 2026-10 120.00; average 25.00, low 0.00 in 2026-07, high 120.00 in 2026-10",
      "- Entertainment: 2026-05 0.00, 2026-06 0.00, 2026-07 0.00, 2026-08 60.00, 2026-09 60.00, 2026-10 60.00; average 15.00, low 0.00 in 2026-07, high 60.00 in 2026-10",
    ]);
  });

  it("counts the months Income was above Spending, gives the average Spending, and leaves out a Saving of 0.00 in every month", async () => {
    const lines = part(await summaryText(), "## Money flow");

    expect(lines[0]).toBe("## Money flow in each complete month: no Saving in any of them");
    expect(lines).toContain("- 2026-08: Income 1000.00, Spending 620.00");
    expect(lines).toContain("- 2026-09: Income 300.00, Spending 635.00");
    expect(lines).toContain("- 2026-10: Income 1000.00, Spending 710.00");
    expect(lines.join("\n")).not.toContain("Saving 0.00");
    // ($100 + $110 + $620 + $635 + $710) ÷ 12 = $181.25.
    expect(lines).toContain(
      "Income was above Spending in 2 of these 12 months. Average Spending a month: 181.25.",
    );
  });

  it("gives the average meal out, each frequent Merchant's average Transaction, and each Category's top 3 Merchants this month", async () => {
    const text = await summaryText();
    const habits = part(text, "## Habit counts");

    // $70 over 3 meals out.
    expect(habits).toContain(
      "In 2026-11, so far: meals out (Restaurants Transactions) 3, average meal out 23.33, delivery orders 0.",
    );
    expect(habits.at(-1)).toContain("Fresh Market 2 for 65.00, average 32.50");
    expect(habits.at(-1)).toContain("QuickFuel 3 for 60.00, average 20.00");
    expect(part(text, "## Top Merchants per Category")).toEqual([
      "## Top Merchants per Category, 2026-11: at most 3 each, with Transactions and Spending before Refunds",
      // Bakery Row, the fourth, is left out.
      "- Groceries: Fresh Market 2 for 65.00; Corner Grocer 1 for 35.00; Farm Stand 1 for 12.00",
      "- Home and garden: Corner Hardware 1 for 90.00",
      "- Gas: QuickFuel 3 for 60.00",
      "- Restaurants: Corner Bistro 2 for 45.00; Noodle House 1 for 25.00",
      "- Entertainment: Movie House 3 for 15.00",
    ]);
  });

  it("counts a Recurring charge's price rises and falls, and starts Coming up on its late item", async () => {
    const text = await summaryText();

    // 100 → 110 → 125 → 120: 2 rises and 1 fall. $120 is 20% above $100.
    expect(part(text, "## Recurring charges")).toContain(
      "- Harbor Insurance: 120.00 monthly, next 2026-11-08, Insurance; prices: 100.00 from 2026-06-08, 110.00 from 2026-07-08, 125.00 from 2026-09-08, 120.00 from 2026-10-08; rose 2 times, fell 1 times; now +20% from the first price",
    );
    const comingUp = part(text, "## Coming up");
    expect(comingUp[0]).toBe("## Coming up, 2026-11-10 to 2026-11-24");
    expect(comingUp[1]).toBe("- 2026-11-10: Harbor Insurance, -120.00, Recurring charge, late");
  });
});
