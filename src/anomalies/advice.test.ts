import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi, RETRY_DELAYS_MS } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  addGoal,
  type NewAlert,
  type NewPart,
  readAiRetry,
  storeAlertAdvice,
  storeAlerts,
  storeDecisions,
  storeFirstDraft,
  storeHouseholdFacts,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { ADVICE_ALERTS_CAP, ALERT_ADVICE_TASK } from "./advice.ts";
import {
  type AlertFacts,
  alertList,
  alertNotes,
  alertText,
  markNotAProblem,
  startAlertSending,
} from "./index.ts";

// The AI's advice on Alerts (spec 06, The AI's advice; spec 08, Every AI use, Limits on each
// call, Failures), through the Alerts step in the follow-up job. Transactions arrive through the
// fake adapter; the AI is AI SDK test models behind the real privacy filter. No test calls an AI
// provider. The Household time zone is New York, on Eastern Standard Time in these weeks.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const BANK = "fake-advice-bank";
const PRICE = { input: 1_000_000, output: 2_000_000 };
// The card's last 4 is also an Alert's amount, $49.99: the amount goes as a typed value, so the
// privacy filter keeps it (K16).
const CARD = fakeAccount({
  id: "acc-card",
  name: "Juniper Rewards Card",
  type: "credit",
  subtype: "credit card",
  mask: "4999",
});
const $ = (dollars: number) => Math.round(dollars * 100);

// A card number that passes the Luhn check, made at test time. Its digits are drawn from 3, 5, 6,
// and 9, so no group of it is the card's last 4.
function newCardNumber(): string {
  const digits = [
    4,
    ...Array.from({ length: 14 }, () => [3, 5, 6, 9][Math.floor(Math.random() * 4)] ?? 3),
  ];
  const doubled = (digit: number) => (digit * 2 > 9 ? digit * 2 - 9 : digit * 2);
  const sum = digits
    .toReversed()
    .reduce((total, digit, place) => total + (place % 2 === 0 ? doubled(digit) : digit), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

// One advice call the test model answered: the Alerts message as the model read it.
type Asked = { text: string; rows: number };

describe("the AI's advice on Alerts", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  let asked: Asked[];
  let pausedUntil: string | undefined;
  // What the AI says for each row.
  let answer: (row: number) => string;
  const ids = new Map<string, string>();

  const gates: AiGates = {
    historyLoaded: async () => true,
    costCapPausedUntil: async () => pausedUntil,
  };
  const aiOptions = () => ({
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    gates,
    notices: { raise: async () => undefined, end: async () => undefined },
  });
  const connectAi = async () => {
    const saved = await aiSettings(aiOptions()).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
  };

  // The Alerts message of an advice call, as the model read it after the privacy filter.
  const readCall = (messages: StubMessage[]): Asked | undefined => {
    const texts = messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""),
      );
    const task = texts.indexOf(ALERT_ADVICE_TASK);
    const text = texts[task + 1];
    if (task === -1 || text === undefined) return undefined;
    const alerts = text.split("\n\n")[0] ?? "";
    return { text, rows: [...alerts.matchAll(/^\d+\. /gm)].length };
  };

  // Syncs Transactions on the card with their parts, as Money movement and Categorization would
  // store them.
  const load = async (txns: { id: string; date: string; merchant: string; parts: NewPart[] }[]) => {
    bank.fake.addPages(BANK, {
      accounts: [CARD],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CARD.id,
          amount: txn.parts.reduce((sum, part) => sum + part.amount, 0),
          postedDate: txn.date,
          merchantName: txn.merchant,
        }),
      ),
    });
    await syncConnection(connectionId, () => new Date());
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    for (const row of rows.rows) ids.set(String(row.provider_transaction_id), String(row.id));
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: new Date(),
        parts: txn.parts,
      })),
    );
  };

  // A new Alert as the checks store it, with its template's text.
  const alertOf = (
    id: string,
    facts: AlertFacts,
    about: {
      transactions?: string[];
      category?: string;
      state?: NewAlert["state"];
      createdAt?: Date;
    } = {},
  ): NewAlert => ({
    id,
    kind: facts.kind,
    createdAt: about.createdAt ?? new Date(),
    facts,
    text: alertText(facts, "2026-11-10"),
    category: about.category ?? null,
    state: about.state ?? null,
    transactionIds: (about.transactions ?? []).map((each) => ids.get(each) ?? ""),
  });

  // A sync that brings three Transactions, and the three Alerts the checks find in them.
  const syncThreeAlerts = async () => {
    await load([
      {
        id: "books",
        date: "2026-11-09",
        merchant: "Bluebird Books",
        parts: [{ type: "Spending", amount: -4_999, category: "Books and education" }],
      },
      {
        id: "stream-1",
        date: "2026-11-08",
        merchant: "Streamflix",
        parts: [{ type: "Spending", amount: -1_599, category: "Entertainment" }],
      },
      {
        id: "stream-2",
        date: "2026-11-09",
        merchant: "Streamflix",
        parts: [{ type: "Spending", amount: -1_599, category: "Entertainment" }],
      },
      {
        id: "dinner",
        date: "2026-11-09",
        merchant: "Corner Bistro",
        parts: [{ type: "Spending", amount: -$(620), category: "Restaurants" }],
      },
    ]);
    await storeAlerts(bank.database, [
      alertOf(
        "alert-1",
        {
          kind: "Large purchase",
          merchant: { id: null, name: "Bluebird Books" },
          amount: 4_999,
          date: "2026-11-09",
          budget: null,
        },
        { transactions: ["books"] },
      ),
      alertOf(
        "alert-2",
        {
          kind: "Duplicate charge",
          merchant: { id: null, name: "Streamflix" },
          // The Account's name when the Alert was made: the bank has renamed it since, so the
          // privacy filter does not know this name. Only the label goes to the AI.
          account: "Juniper Travel Card",
          amount: 1_599,
          dates: ["2026-11-08", "2026-11-09"],
        },
        { transactions: ["stream-1", "stream-2"] },
      ),
      alertOf(
        "alert-3",
        {
          kind: "Over Budget",
          budget: {
            category: "Restaurants",
            spent: $(620),
            budget: $(500),
            period: "monthly",
            span: "2026-11",
          },
          latest: {
            merchant: { id: null, name: "Corner Bistro" },
            amount: $(620),
            date: "2026-11-09",
          },
        },
        { transactions: ["dinner"], category: "Restaurants" },
      ),
    ]);
  };

  // Each Alert's state, advice, and text, by its ID.
  const alerts = async () =>
    Object.fromEntries(
      (await alertList(bank.database)).map((each) => [
        each.id,
        { state: each.state, advice: each.advice, text: each.text },
      ]),
    );
  const deliveries = async () =>
    (
      await bank.database.$client.execute(
        "SELECT alert_id, title, text, advice FROM alert_deliveries ORDER BY alert_id",
      )
    ).rows.map((row) => ({ ...row }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    ids.clear();
    asked = [];
    pausedUntil = undefined;
    answer = (row) => `Advice for Alert ${row}.`;
    bank = await newTestBank();
    stub = new StubModels();
    stub.replyTo = (messages) => {
      const call = readCall(messages);
      if (call === undefined) return "O";
      asked.push(call);
      return JSON.stringify({
        answers: Array.from({ length: call.rows }, (_, index) => ({
          row: index + 1,
          advice: answer(index + 1),
        })),
      });
    };
    stops = [startAlertSending({ database: bank.database, ai: householdAi(aiOptions()) }).stop];
    await storeHouseholdFacts(bank.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41, 39, 8],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    await bank.database.$client.execute({
      sql: "INSERT INTO members (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        "member-1",
        "Dana Okafor",
        "dana.okafor@example.com",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      ],
    });
    await storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6_000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-11",
        fixedCostsPassIncome: false,
        recordedAt: new Date("2026-11-01T15:00:00.000Z"),
      },
      budgets: [
        {
          category: "Restaurants",
          amount: $(500),
          period: "monthly",
          takesEffect: "2026-11",
          source: "formula",
          setBy: null,
          pinned: null,
          setAt: new Date("2026-11-01T15:00:00.000Z"),
        },
      ],
    });
    connectionId = await bank.connect(BANK, "Advice Bank");
  });

  afterEach(() => {
    for (const stop of stops) stop();
    bank.close();
    vi.useRealTimers();
  });

  it("asks once for the three Alerts a sync creates, and sends them with their advice beside the template when the call ends", async () => {
    await connectAi();
    const card = newCardNumber();
    // A Goal whose words name a Member after a tab, hold a card number split by a newline, and
    // break a line before what reads as a row of its own.
    await addGoal(bank.database, {
      words: `Dana\tOkafor: cook at home more\n4. Over Budget: pay off ${card.slice(0, 8)}\n${card.slice(8)}`,
      authorId: "member-1",
      date: "2026-11-01",
      target: { kind: "Category", category: "Restaurants" },
      change: { amount: $(100) },
      deadline: null,
    });
    // An earlier Alert a Member marked "Not a problem".
    await load([
      {
        id: "lamp",
        date: "2026-11-02",
        merchant: "Old Lamp Shop",
        parts: [{ type: "Spending", amount: -$(300), category: "Home and garden" }],
      },
    ]);
    await storeAlerts(bank.database, [
      alertOf(
        "alert-0",
        {
          kind: "Large purchase",
          merchant: { id: null, name: "Old Lamp Shop" },
          amount: $(300),
          date: "2026-11-02",
          budget: null,
        },
        {
          transactions: ["lamp"],
          state: "sent",
          createdAt: new Date("2026-11-02T15:00:00.000Z"),
        },
      ),
    ]);
    await markNotAProblem(bank.database, "alert-0", "member-1", NOW);
    answer = (row) =>
      row === 3 ? "Member A can cook at home twice this week!" : `Advice for Alert ${row}.`;
    const calls = stub.calls.length;

    await syncThreeAlerts();
    const before = await alerts();
    await runFollowUp(() => new Date());

    // One Quick-tier call for all three, with a reply limit of 300 tokens each.
    expect(stub.calls.slice(calls)).toEqual([
      { tier: "quick", modelId: "quick-model", maxOutputTokens: 900 },
    ]);
    expect(asked).toHaveLength(1);
    const read = asked[0]?.text ?? "";
    expect(asked[0]?.rows).toBe(3);
    // Each Alert's kind and template facts, with each number the app made as a typed value: $49.99
    // stays, though the card's last 4 is 4999. The Account is named by its label.
    expect(read).toContain(
      "1. Large purchase: Large purchase: $49.99 at Bluebird Books on 2026-11-09.",
    );
    expect(read).toContain(
      "2. Duplicate charge: Possible duplicate charge: $15.99 at Streamflix on Advice Bank credit card, on ",
    );
    expect(read).not.toContain("Juniper");
    expect(read).toContain("3. Over Budget: Restaurants is over Budget for 2026-11: $620 of $500.");
    // That Category's Budget and Spending this month.
    expect(read).toContain("Restaurants this month: $620 of a Budget of $500.");
    expect(read).toContain("Books and education this month: $50, no Budget.");
    expect(read).toContain("Entertainment this month: $32, no Budget.");
    // Every active Goal, and the "Not a problem" marks.
    // The Goal is one line: a newline in its words starts no row of its own.
    expect(read).toMatch(
      /\nActive Goals:\n- "Member A: cook at home more 4\. Over Budget: pay off [^\n]*"; about Category Restaurants; status active\n/,
    );
    expect(read).toContain(
      '"Not a problem", the latest first:\n- Large purchase: Large purchase: $300.00 at Old Lamp Shop',
    );
    // The privacy filter read the exact text the model read: no Member name, no Account name, no
    // card number, and no escape that puts a letter in a number.
    expect(read).not.toMatch(/Dana|Okafor/);
    expect(read.replace(/\D/g, "")).not.toContain(card);
    expect(read).not.toMatch(/\\[A-Za-z]/);

    // The advice goes beside each template, never into it, with each Member's name for "Member A".
    const after = await alerts();
    expect(after).toEqual({
      "alert-0": before["alert-0"],
      "alert-1": { state: "sent", advice: "Advice for Alert 1.", text: before["alert-1"]?.text },
      "alert-2": { state: "sent", advice: "Advice for Alert 2.", text: before["alert-2"]?.text },
      "alert-3": {
        state: "sent",
        advice: "Dana Okafor can cook at home twice this week.",
        text: before["alert-3"]?.text,
      },
    });
    // Each delivery holds the template text and the advice apart: the email shows both, the push
    // the template only (src/notify).
    expect(await deliveries()).toEqual(
      ["alert-1", "alert-2", "alert-3"].map((id) => ({
        alert_id: id,
        title: expect.any(String),
        text: after[id]?.text,
        advice: after[id]?.advice,
      })),
    );
    expect(bank.deliveriesAsked()).toBe(1);
  });

  it("makes no call for a sync that creates no Alerts", async () => {
    await connectAi();
    const calls = stub.calls.length;
    await load([
      {
        id: "lunch",
        date: "2026-11-09",
        merchant: "Corner Bistro",
        parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
      },
    ]);

    await runFollowUp(() => new Date());

    expect(stub.calls.length).toBe(calls);
    expect(asked).toEqual([]);
  });

  it.each([
    ["with no AI provider", async () => {}],
    [
      "at the AI cost cap",
      async () => {
        await connectAi();
        pausedUntil = "2026-12-01";
      },
    ],
  ])(
    "sends the Alerts with their template only %s, with no error, and never adds advice later",
    async (_, setUp) => {
      await setUp();
      const calls = stub.calls.length;
      await syncThreeAlerts();

      await expect(runFollowUp(() => new Date())).resolves.toBeUndefined();

      expect(stub.calls.length).toBe(calls);
      const sent = await alerts();
      expect(Object.values(sent).map(({ state, advice }) => ({ state, advice }))).toEqual(
        Array.from({ length: 3 }, () => ({ state: "sent", advice: null })),
      );
      expect((await deliveries()).map((each) => each.advice)).toEqual([null, null, null]);

      // AI returns, and the next sync creates no Alerts: the sent Alerts never get advice.
      await connectAi();
      pausedUntil = undefined;
      await load([
        {
          id: "lunch",
          date: "2026-11-10",
          merchant: "Corner Bistro",
          parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
        },
      ]);
      await runFollowUp(() => new Date());
      expect(asked).toEqual([]);
      expect(await alerts()).toEqual(sent);
    },
  );

  it("holds the Alerts while the call waits for its retries, then sends them with their template only after the last one fails", async () => {
    await connectAi();
    stub.answers.quick = "rate limit";
    const calls = stub.calls.length;
    await syncThreeAlerts();

    // A rate limit is an AI error: the step stops the job until the retry, and sends nothing yet.
    expect(await runFollowUp(() => new Date())).toEqual({
      stoppedAt: "alerts",
      again: new Date(NOW.getTime() + (RETRY_DELAYS_MS[0] ?? 0)),
    });
    expect(await readAiRetry(bank.database, "alert advice")).toMatchObject({ failures: 1 });
    expect(Object.values(await alerts()).map((each) => each.state)).toEqual([null, null, null]);
    expect(await deliveries()).toEqual([]);
    // A follow-up job before the retry is due makes no call.
    expect(await runFollowUp(() => new Date())).toMatchObject({ stoppedAt: "alerts" });
    expect(stub.calls.length).toBe(calls + 1);

    // Each retry is one call; after the last one fails, the Alerts go with their template only.
    for (const delay of RETRY_DELAYS_MS) {
      vi.setSystemTime(Date.now() + delay);
      const run = await runFollowUp(() => new Date());
      if (delay === RETRY_DELAYS_MS.at(-1)) expect(run).toBeUndefined();
      else expect(run).toMatchObject({ stoppedAt: "alerts" });
    }
    expect(stub.calls.length).toBe(calls + 1 + RETRY_DELAYS_MS.length);
    expect(await readAiRetry(bank.database, "alert advice")).toBeUndefined();
    const sent = await alerts();
    expect(Object.values(sent).map(({ state, advice }) => ({ state, advice }))).toEqual(
      Array.from({ length: 3 }, () => ({ state: "sent", advice: null })),
    );
    expect(await deliveries()).toHaveLength(3);
    expect(bank.deliveriesAsked()).toBe(1);

    // The AI works again: the next sync makes no call for them, and they never get advice.
    stub.answers.quick = "work";
    await load([
      {
        id: "lunch",
        date: "2026-11-10",
        merchant: "Corner Bistro",
        parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
      },
    ]);
    await runFollowUp(() => new Date());
    expect(stub.calls.length).toBe(calls + 1 + RETRY_DELAYS_MS.length);
    expect(await alerts()).toEqual(sent);
  });

  it("shows each Alert note at once, and its Next step when the advice arrives", async () => {
    await connectAi();
    await syncThreeAlerts();
    const nextSteps = async () =>
      Object.fromEntries(
        (await alertNotes(bank.database, new Date())).map((note) => [note.id, note.nextStep]),
      );
    let whileAsking: Record<string, string | null> = {};
    stub.beforeAnswer = async () => {
      whileAsking = await nextSteps();
    };

    await runFollowUp(() => new Date());

    expect(whileAsking).toEqual({ "alert-1": null, "alert-2": null, "alert-3": null });
    expect(await nextSteps()).toEqual({
      "alert-1": "Advice for Alert 1.",
      "alert-2": "Advice for Alert 2.",
      "alert-3": "Advice for Alert 3.",
    });
  });

  it("asks only about the Alerts not decided yet: an Alert already sent never gets advice", async () => {
    await connectAi();
    await syncThreeAlerts();
    // The Alerts step decided the first Alert before any advice call, such as with no AI.
    await bank.database.$client.execute("UPDATE alerts SET state = 'sent' WHERE id = 'alert-1'");

    // An Alert decided while the AI answers keeps no advice either.
    stub.beforeAnswer = async () => {
      await bank.database.$client.execute(
        "UPDATE alerts SET state = 'held back (weekly cap)' WHERE id = 'alert-3'",
      );
    };

    await runFollowUp(() => new Date());

    expect(asked.map((call) => call.rows)).toEqual([2]);
    expect(asked[0]?.text).not.toContain("Bluebird Books");
    const advised = await alerts();
    expect(
      [advised["alert-1"], advised["alert-2"], advised["alert-3"]].map((each) => each?.advice),
    ).toEqual([null, "Advice for Alert 1.", null]);
  });

  it("stores the advice once: after the Alerts step fails, the next run decides the Alerts with no second call", async () => {
    await connectAi();
    const calls = stub.calls.length;
    await syncThreeAlerts();
    await bank.database.$client.execute("ALTER TABLE alert_settings RENAME TO alert_settings_away");

    await expect(runFollowUp(() => new Date())).rejects.toThrow("The Alerts step failed.");
    expect(Object.values(await alerts()).map((each) => each.state)).toEqual([null, null, null]);

    await bank.database.$client.execute("ALTER TABLE alert_settings_away RENAME TO alert_settings");
    await runFollowUp(() => new Date());

    expect(stub.calls.length).toBe(calls + 1);
    const sent = await alerts();
    expect(["alert-1", "alert-2", "alert-3"].map((id) => sent[id]?.state)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
    expect((await deliveries()).map((each) => each.advice)).toEqual([
      "Advice for Alert 1.",
      "Advice for Alert 2.",
      "Advice for Alert 3.",
    ]);
  });

  it("sends the Alerts with their template only when the call throws an error that is not an AI error, and never asks again", async () => {
    await connectAi();
    const calls = stub.calls.length;
    await syncThreeAlerts();
    const warn = vi.spyOn(log, "warn");
    stub.beforeAnswer = async () => {
      throw new TypeError("Dana Okafor's Alerts could not be read.");
    };

    await expect(runFollowUp(() => new Date())).resolves.toBeUndefined();

    expect(stub.calls.length).toBe(calls + 1);
    expect(await readAiRetry(bank.database, "alert advice")).toBeUndefined();
    const sent = await alerts();
    expect(Object.values(sent).map(({ state, advice }) => ({ state, advice }))).toEqual(
      Array.from({ length: 3 }, () => ({ state: "sent", advice: null })),
    );
    // Only the error's name: never its message.
    expect(warn).toHaveBeenCalledWith(
      "The Alert advice call failed, so the Alerts go with their template only",
      { alerts: 3, error: "TypeError" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Okafor");
    warn.mockRestore();

    // The next sync makes no call for them.
    stub.beforeAnswer = async () => {};
    await load([
      {
        id: "lunch",
        date: "2026-11-10",
        merchant: "Corner Bistro",
        parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
      },
    ]);
    await runFollowUp(() => new Date());
    expect(stub.calls.length).toBe(calls + 1);
    expect(await alerts()).toEqual(sent);
  });

  it("advises on the newest 4 of 6 new Alerts in one call, and sends the other 2 with their template only", async () => {
    expect(ADVICE_ALERTS_CAP).toBe(4);
    await connectAi();
    const calls = stub.calls.length;
    await load([
      {
        id: "books",
        date: "2026-11-09",
        merchant: "Bluebird Books",
        parts: [{ type: "Spending", amount: -4_999, category: "Books and education" }],
      },
    ]);
    const made = ["alert-1", "alert-2", "alert-3", "alert-4", "alert-5", "alert-6"];
    await storeAlerts(
      bank.database,
      made.map((id, index) =>
        alertOf(
          id,
          {
            kind: "Large purchase",
            merchant: { id: null, name: `Shop ${index + 1}` },
            amount: 4_999,
            date: "2026-11-09",
            budget: null,
          },
          {
            transactions: ["books"],
            createdAt: new Date(NOW.getTime() - (made.length - index) * 60_000),
          },
        ),
      ),
    );

    await runFollowUp(() => new Date());

    expect(stub.calls.slice(calls)).toEqual([
      { tier: "quick", modelId: "quick-model", maxOutputTokens: 1_200 },
    ]);
    expect(asked.map((call) => call.rows)).toEqual([4]);
    expect(asked[0]?.text).not.toMatch(/Shop [12]\b/);
    const sent = await alerts();
    expect(made.map((id) => sent[id]?.advice)).toEqual([
      null,
      null,
      "Advice for Alert 1.",
      "Advice for Alert 2.",
      "Advice for Alert 3.",
      "Advice for Alert 4.",
    ]);
    expect(made.map((id) => sent[id]?.state)).toEqual(made.map(() => "sent"));

    // Every one of them is done with: the next sync makes no call.
    await load([
      {
        id: "lunch",
        date: "2026-11-10",
        merchant: "Corner Bistro",
        parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
      },
    ]);
    await runFollowUp(() => new Date());
    expect(stub.calls.length).toBe(calls + 1);
  });

  it("never changes the advice of an Alert the call is already done with", async () => {
    await syncThreeAlerts();
    const first = new Date("2026-11-10T14:00:00.000Z");
    expect(
      await storeAlertAdvice(bank.database, ["alert-1"], new Map([["alert-1", "First."]]), first),
    ).toEqual(new Set(["alert-1"]));
    const advisedAt = async () =>
      (
        await bank.database.$client.execute(
          "SELECT advice, advised_at, state FROM alerts WHERE id = 'alert-1'",
        )
      ).rows.map((row) => ({ ...row }));
    const stored = await advisedAt();
    expect(stored).toEqual([{ advice: "First.", advised_at: expect.any(String), state: null }]);

    expect(
      await storeAlertAdvice(bank.database, ["alert-1"], new Map([["alert-1", "Second."]]), NOW),
    ).toEqual(new Set());
    expect(await advisedAt()).toEqual(stored);
  });
});
