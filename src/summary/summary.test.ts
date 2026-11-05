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
import { draftFirstBudgets, startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addGoal,
  type Database,
  deleteRemovedConnection,
  listAccounts,
  listConnections,
  markConnectionRemoved,
  readHouseholdSummary,
  storeHouseholdSummary,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startGoal } from "../goals/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import type { LogFields, Logger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
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
// loads on November 1, 2026. The summary is read as the Writer model reads it, after the real
// privacy filter.

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
  const saved = await aiSettings(options).save(
    {
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    },
    { freshCode: true },
  );
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
    // One Goal by each Member: Alex joined second, so is Member B.
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

  it("matches the stored snapshot, within 3,000 tokens", async () => {
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
      "## Coming up, 2026-11-21 to 2026-12-04",
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

  it("names each Goal's author by Member label, in the order Members joined", async () => {
    const { text } = await summary().today();

    expect(text).toContain('- "Spend less at restaurants", by Member B on 2026-11-01;');
    expect(text).toContain('- "Put away for a summer trip", by Member A on 2026-11-01;');
    expect(text).toContain('Marked "Not a problem" by Member B on 2026-11-01.');
    for (const member of DEMO_MEMBERS) {
      for (const name of [member.firstName, member.lastName, member.email]) {
        expect(text).not.toContain(name);
      }
    }
  });

  it("names each Account by its label, and holds no Account number", async () => {
    const { text } = await summary().today();
    const labels = await ai.accountLabels();

    for (const account of await listAccounts(bank.database)) {
      if (account.closedAt === null && !account.excluded) {
        expect(text).toContain(`- ${labels.get(account.id)}: `);
      }
      if (account.mask !== null) {
        expect(text).not.toMatch(new RegExp(`(?<!\\d)${account.mask}(?!\\d)`));
      }
      expect(text).not.toContain(account.name);
    }
  });

  it("goes to the model whole: the privacy filter finds nothing to remove", async () => {
    const { parts, text } = await summary().today();

    expect(
      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." }),
    ).toMatchObject({ ready: true });

    expect(summaryTheModelRead(stub)).toBe(text);
  });

  it("keeps each amount, date, month, and count the app made, even when a last 4, the ZIP code, or an age matches it", async () => {
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
      // Sent as one text, the filter would take these numbers out of the app's own amounts.
      await ai.generate({ use: "insight cards", summary: text, task: "Write the cards." });
      expect(summaryTheModelRead(stub)).not.toBe(text);

      expect(
        await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." }),
      ).toMatchObject({ ready: true });
      const read = summaryTheModelRead(stub);
      expect(read).toBe(text);
      expect(read).not.toMatch(/\\\p{L}/u);

      // A Goal's words stay text, so the filter still takes out a last 4, a card number, the ZIP
      // code, and an age that a Member wrote, while every line the app made stays as it was.
      await addGoal(bank.database, {
        words: "Pay card 4999 and\n4111\n1111\n1111\n1111 from ZIP 18950 for our 20 year old",
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
      const isGoal = (line: string) => line.startsWith('- "Pay card');
      expect(readLater.split("\n").filter((line) => !isGoal(line))).toEqual(
        later.text.split("\n").filter((line) => !isGoal(line)),
      );
      const goalLine = readLater.split("\n").find(isGoal) ?? "";
      expect(goalLine).toContain("by Member A on 2026-11-24");
      expect(goalLine).not.toContain("4999");
      expect(goalLine).not.toMatch(/4111\D{0,3}1111/);
      expect(goalLine).not.toContain("18950");
      expect(goalLine).not.toMatch(/(?<!\d)20(?!\d)/);
      expect(readLater).not.toMatch(/\\\p{L}/u);
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

  it("keeps the amounts in an Alert and in a Goal's progress, even when a last 4 or the ZIP code matches them", async () => {
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
      // Sent as one text, the filter would take these numbers out.
      await ai.generate({ use: "insight cards", summary: text, task: "Write the cards." });
      const asText = summaryTheModelRead(stub);
      expect(asText).not.toContain("$70.37");
      expect(asText).not.toContain("$32.87");
      expect(asText).not.toContain("$22971");

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
    // Stored as its pieces, with no typed value's mark, which is new each time the app starts.
    expect(stored?.text).toContain('{"amount":');
    expect(stored?.text).not.toContain("privacyFilter");

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
      expect(next).toContain('"Pay the card off", by Member A');
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

  it("passes the real privacy filter: no Member name, Account number, ZIP code, or age reaches the model", async () => {
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
    // A Goal's words, as a Member wrote them: a name after a tab, names glued, a last 4 and a card
    // number split by line breaks, the ZIP code, and ages in digits and in words.
    await addGoal(bank.database, {
      words: `Before\tJamie turns forty-seven, AlexRivera pays card ${card?.mask}\n4111\n1111\n1111\n1111 from ZIP ${zipCode} for our 13 year old`,
      authorId: "member-2",
      date: "2026-11-21",
      target: null,
      change: null,
      deadline: null,
    });
    now = new Date("2026-11-22T14:00:00.000Z");
    try {
      const { parts, text } = await summary().today();
      expect(text).toContain("by Member B on 2026-11-21");
      // The summary is one text the AI reads as it is: no control character but a line break, so
      // no field starts a line of its own, and no backslash before a letter.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters it looks for.
      expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/u);
      expect(text).not.toMatch(/\\\p{L}/u);

      await ai.generate({ use: "insight cards", summary: parts, task: "Write the cards." });
      const read = summaryTheModelRead(stub);
      expect(read).not.toMatch(/\\\p{L}/u);

      expect(read).toContain("Member A turns");
      expect(read).toContain("Member B pays card");
      for (const member of DEMO_MEMBERS) {
        for (const name of [member.firstName, member.lastName, member.email]) {
          expect(read.toLowerCase()).not.toContain(name.toLowerCase());
        }
      }
      for (const account of accounts) {
        if (account.mask !== null) {
          expect(read).not.toMatch(new RegExp(`(?<!\\d)${account.mask}(?!\\d)`));
        }
      }
      expect(read).not.toMatch(/4111\D{0,3}1111/);
      expect(read).not.toContain(zipCode);
      // The Goal's line holds neither age. Elsewhere, an amount or a share such as +47% is not an
      // age, and stays.
      const goalLine = read.split("\n").find((line) => line.includes("Member A turns")) ?? "";
      expect(goalLine).not.toMatch(/forty[\s-]?seven/i);
      for (const age of ages) {
        expect(goalLine).not.toMatch(new RegExp(`(?<!\\d)${age}(?!\\d)`));
      }
    } finally {
      now = NOW;
    }
  });

  it("names the Account of a Card interest or Duplicate charge Alert by its label", async () => {
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
      const label = (await ai.accountLabels()).get(card?.id ?? "") ?? "";
      expect(label).not.toBe("");
      const lines = recent?.split("\n") ?? [];
      const interest = lines.find((line) => line.includes("Card interest or fee:")) ?? "";
      const duplicate = lines.find((line) => line.includes("Duplicate charge:")) ?? "";
      expect(interest).toContain(` on ${label} `);
      expect(duplicate).toContain(label);
      expect(text).not.toContain("Chase Card");
    } finally {
      now = NOW;
    }
  });

  it("drops the oldest months of per-Category history until it fits in 3,000 tokens", async () => {
    const { text: before } = await summary().today();
    // Long Goals push the summary about 600 characters past 3,000 tokens: less than its 12 months of
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
      // Each Category's history row holds one amount per month kept.
      const rows = text
        .slice(text.indexOf(header?.[0] ?? ""))
        .split("\n## ")[0]
        ?.split("\n")
        .filter((line) => line.startsWith("- "));
      expect(rows?.length).toBeGreaterThan(0);
      for (const row of rows ?? []) expect(row.split(", ")).toHaveLength(kept);
      // Every Goal is still there.
      expect(text).toContain(`Goal ${count}: keep the grocery list short`);
      // One more month would not fit.
      expect(summaryTokens(text)).toBeGreaterThan(SUMMARY_TOKENS - 200);
    } finally {
      now = NOW;
    }
  });

  it("goes as it is when still over 3,000 tokens with no history left, and logs its size only", async () => {
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
        "In 2026-09: meals out (Restaurants Transactions) 1, delivery orders 1.",
        "- Share of Spending made Friday to Sunday: Restaurants 0%",
        "- Most frequent Merchants, with Transactions and Spending: GRUBHUB*TAQUERIA 1 for 18.00",
        "In 2026-10: meals out (Restaurants Transactions) 5, delivery orders 2.",
        // Restaurants: $30 + $20 + $25 of $140. Groceries: $100 of $400. Utilities is a Bill.
        "- Share of Spending made Friday to Sunday: Groceries 25%, Restaurants 54%, Transit and rideshare 0%",
        "- Most frequent Merchants, with Transactions and Spending: Corner Bistro 3 for 100.00; Fresh Market 2 for 400.00; City Power 1 for 80.00; DoorDash 1 for 25.00; Uber Eats 1 for 15.00; Uber 1 for 12.00",
        "In 2026-11, so far: meals out (Restaurants Transactions) 0, delivery orders 0.",
        "- Share of Spending made Friday to Sunday: none",
        "- Most frequent Merchants, with Transactions and Spending: none",
      ].join("\n"),
    );
  });

  it("names a card or loan payment in Coming up by its Account's label, never by its name", async () => {
    const text = await summaryOf();
    const labels = await householdAi({
      database: bank.database,
      secrets: bank.secrets,
      cost: aiCost({ database: bank.database }),
    }).accountLabels();
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
    expect(text).not.toContain("Dana");
    expect(text).not.toContain("Okafor");
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

    expect(await markConnectionRemoved(bank.database, connectionId, NOVEMBER_5)).toBe(true);
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
