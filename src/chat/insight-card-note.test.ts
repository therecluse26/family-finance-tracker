import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AiCall,
  aiCost,
  aiSettings,
  type HouseholdAi,
  householdAi,
  typedCount,
} from "../ai/index.ts";
import { newAiKey, newTestAi, type StubMessage, StubModels, type TestAi } from "../ai/testing.ts";
import { type AlertFacts, alertText } from "../anomalies/index.ts";
import {
  addUnconnectedAccount,
  loginTables,
  type NewInsightCard,
  replaceInsightCards,
  storeAlerts,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { type Chat, type ChatMember, chat } from "./index.ts";

// "Ask about this" on an Insight card (spec 08, Threads; spec 07, 1. AI box): a new Chat thread
// with the card attached, read from app.db by its ID, never from the browser. The card's figure
// goes as a typed value (known finding K16); every word on it is the AI's, stored with each
// Member's name, and goes through the privacy filter as the model reads it (K13, K14, K17). On AI
// SDK test models; no test calls an AI provider. The Household's names and numbers are made up.

const QUIET = createLogger(() => {}, { throwOnSecretField: true });
const PRICE = { input: 1_000_000, output: 2_000_000 };
// Oct 20, 2026, 4 PM UTC.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const DANA: ChatMember = { id: "m1", name: "Dana Whitfield" };

// What must never reach the AI: the Members' names, the Account's last 4, the ZIP code, and a card.
const PRIVATE = ["Dana", "Whitfield", "Ravi", "Okafor", "10001", "4111"];

// The text of a message the model read, part by part.
const textsOf = (message: StubMessage | undefined): string[] =>
  message === undefined
    ? []
    : typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text]));

const card = (fields: Partial<NewInsightCard> = {}): NewInsightCard => ({
  id: crypto.randomUUID(),
  position: 1,
  writtenAt: new Date(NOW.getTime() - HOUR),
  month: "2026-10",
  group: "worth_acting_on",
  about: "Restaurants",
  figure: 4821,
  figureKind: "dollars",
  figureLabel: "on takeout fees",
  title: "Delivery fees add up",
  why: "Six delivery orders this month each paid a fee.",
  nextStep: "Pick up two orders a week instead.",
  picture: null,
  ...fields,
});

describe("an Insight card in Chat", () => {
  let test: TestAi;
  let stub: StubModels;
  let ai: HouseholdAi;
  let calls: AiCall[];
  let talk: Chat;

  beforeEach(async () => {
    test = await newTestAi();
    stub = new StubModels();
    calls = [];
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values([
      {
        id: "m1",
        name: "Dana Whitfield",
        email: "dana@example.com",
        createdAt: joined,
        updatedAt: joined,
      },
      {
        id: "m2",
        name: "Ravi Okafor",
        email: "ravi@example.org",
        createdAt: joined,
        updatedAt: joined,
      },
    ]);
    await addUnconnectedAccount(test.database, {
      subtype: "savings",
      institutionName: "Ally",
      name: "Rainy day fund",
      mask: "4821",
    });
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [41, 39, 8], rentOrOwn: "own" },
      "m1",
    );
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      gates: { historyLoaded: async () => true, costCapPausedUntil: async () => undefined },
      logger: QUIET,
      notices: { raise: async () => {}, end: async () => {} },
    };
    expect(
      await aiSettings(options).save(
        {
          provider: "anthropic",
          apiKey: newAiKey(),
          baseUrl: null,
          quickModel: "quick-model",
          writerModel: "writer-model",
          prices: { quick: PRICE, writer: PRICE },
        },
        { freshCode: true },
      ),
    ).toMatchObject({ saved: true });
    ai = householdAi(options);
    talk = chat({
      database: test.database,
      ai: {
        ...ai,
        stream: (call, hooks) => {
          calls.push(call);
          return ai.stream(call, hooks);
        },
      },
      summary: {
        today: async () => ({ parts: ["Household summary: ", typedCount(2), " Members."] }),
      },
      now: () => NOW,
    });
  });

  afterEach(() => {
    test.close();
  });

  const prompts = () => stub.prompts.slice(2);

  // Starts a thread about the card, and has the AI answer, as the page does after Send.
  async function askAbout(id: string, title: string) {
    const result = await talk.start(DANA, {
      text: `Tell me more about this: ${title}`,
      note: { kind: "Insight card", id },
      sendAnyway: false,
    });
    if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
    const response = await talk.answer(DANA, result.threadId, { text: null, sendAnyway: false });
    if (!(response instanceof Response)) throw new Error(`Refused: ${response.refused}`);
    await response.text();
    return result.threadId;
  }

  it("starts a new thread with the card attached and its figure typed, even one that matches an Account's last 4", async () => {
    const shown = card();
    await replaceInsightCards(test.database, [shown]);

    const id = await askAbout(shown.id, shown.title);

    expect((await talk.thread(id))?.note).toEqual({
      kind: "Insight card",
      title: "Delivery fees add up",
      lines: [
        "Six delivery orders this month each paid a fee.",
        "Next step: Pick up two orders a week instead.",
      ],
    });
    const [, , , note, question] = prompts().at(-1) ?? [];
    // $4,821 matches the Account's last 4, 4821, but goes as a typed value, as the app checked it.
    expect(textsOf(note).join("")).toBe(
      "The Member asks about this note from the AI box.\nAn Insight card in Worth acting on, about Restaurants: Delivery fees add up\n- Its figure: $4821 on takeout fees\n- Why: Six delivery orders this month each paid a fee.\n- Next step: Pick up two orders a week instead.",
    );
    expect(textsOf(question)).toEqual(["Tell me more about this: Delivery fees add up"]);
    const typed = (calls.at(-1)?.note ?? []).filter((part) => typeof part !== "string");
    expect(typed).toHaveLength(1);
  });

  it("sends a percent and a count typed, and a Good news card's last words with no Next step label", async () => {
    const good = card({
      group: "good_news",
      figure: 12,
      figureKind: "percent",
      figureLabel: "less on groceries",
      title: "Groceries came down",
      nextStep: "That leaves room for the Goal.",
    });
    await replaceInsightCards(test.database, [good]);

    const id = await askAbout(good.id, good.title);

    expect((await talk.thread(id))?.note?.lines).toEqual([
      "Six delivery orders this month each paid a fee.",
      "That leaves room for the Goal.",
    ]);
    const [, , , note] = prompts().at(-1) ?? [];
    expect(textsOf(note).join("")).toContain(
      "- Its figure: 12% less on groceries\n- Why: Six delivery orders this month each paid a fee.\n- What it means: That leaves room for the Goal.",
    );
  });

  it("refuses a made-up card ID, another kind's ID, or a card from an old run, and stores nothing", async () => {
    const old = card();
    await replaceInsightCards(test.database, [old]);
    const facts: AlertFacts = {
      kind: "Duplicate charge",
      merchant: { id: null, name: "Shell" },
      account: "Rewards Card",
      amount: 4_821,
      dates: ["2026-10-17", "2026-10-18"],
    };
    await storeAlerts(test.database, [
      {
        id: "alert-1",
        kind: facts.kind,
        createdAt: new Date(NOW.getTime() - HOUR),
        facts,
        text: alertText(facts, "2026-10-20"),
        category: null,
        state: "sent",
        transactionIds: [],
      },
    ]);
    // The next run replaces every card.
    const current = card({ title: "Groceries came down" });
    await replaceInsightCards(test.database, [current]);
    const before = await readEveryTable(test.database);

    for (const note of [
      { kind: "Insight card", id: "no-such-card" },
      { kind: "Insight card", id: "alert-1" },
      { kind: "Insight card", id: old.id },
      { kind: "Alert note", id: current.id },
      { kind: "Proposal", id: current.id },
    ] as const) {
      expect(await talk.start(DANA, { text: "Tell me more", note, sendAnyway: false })).toEqual({
        refused: "note gone",
      });
    }

    expect(await readEveryTable(test.database)).toEqual(before);
    expect(prompts()).toEqual([]);
  });

  it("leaves out a Member's name next to a Merchant name and a card number split by a newline", async () => {
    const shown = card({
      about: "Dana Whitfield Photo",
      title: "Shell and\tRavi Okafor Cafe add up",
      why: "Paid at DanaWhitfield Photo with card 4111\n1111\n1111\n1111 twice.",
      figureLabel: "at\tRavi Okafor Cafe",
    });
    await replaceInsightCards(test.database, [shown]);

    await askAbout(shown.id, "Delivery fees add up");

    const [, , , note] = prompts().at(-1) ?? [];
    const text = textsOf(note).join("");
    expect(text).toContain("about Member A Photo: Shell and Member B Cafe add up");
    expect(text).toContain("at Member B Cafe");
    expect(text).not.toMatch(/\t|1111/u);
    // The filter read the exact characters the model reads: no control character but the note's
    // own line breaks, so no escape puts a letter inside the card number or before a name.
    expect([...text].filter((char) => char < " " && char !== "\n")).toEqual([]);
    const sent = JSON.stringify(prompts());
    for (const word of PRIVATE) expect(sent).not.toContain(word);
  });
});
