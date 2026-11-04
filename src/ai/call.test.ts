import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUnconnectedAccount, loginTables } from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import type { AiProviderName, AiSettingsInput, AiTier } from "./ai-view.ts";
import { type AiCall, privateModels } from "./call.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { householdAi } from "./household-ai.ts";
import type { OutboundCall } from "./outbound.ts";
import { memberPrice } from "./prices.ts";
import { PrivacyRefusal } from "./privacy.ts";
import { type AiModelMaker, makeFetchModels } from "./providers.ts";
import { aiSettings } from "./settings.ts";
import { CapturingFetch, newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// The one AI call path (spec 08, Privacy filter; Counting cost), on a fetch that captures each
// request as it leaves, and on AI SDK test models. No test calls an AI provider. The Household's
// names, addresses, numbers, and facts are made up.

const QUIET = createLogger(() => {}, { throwOnSecretField: true });

// What must never leave, in any request.
const PRIVATE = [
  "Dana",
  "Whitfield",
  "Ravi",
  "dana.w@example.com",
  "ravi@example.org",
  "4821",
  "7730",
  "10001",
  "Rainy day fund",
];

// Every input the security review wrote (review 2 and its probes), each as a Chat message, with
// the text that must leave. The look-alike letters (Cyrillic, small capitals, "1OOO1"), "Danas",
// and a last 4 written among amounts are the review's notes: the filter does not see them.
const REVIEWED: [string, string][] = [
  ["Card 4111 -2222\n- 3333 -\r\n5555 end", "Card [removed] end"],
  ["Card 4111--2222--3333--5555 end", "Card [removed] end"],
  ["Card 4111 -- 2222 -- 3333 -- 5555 end", "Card [removed] end"],
  ["Card 4111 – 2222 – 3333 – 5555 end", "Card [removed] end"],
  ["Card 4111—2222—3333—5555 end", "Card [removed] end"],
  ["Card 4111‐2222‐3333‐5555 end", "Card [removed] end"],
  ["Card 4111−2222−3333−5555 end", "Card [removed] end"],
  ["Card 4111|2222|3333|5555 end", "Card [removed] end"],
  ["Card 4111 | 2222 | 3333 | 5555 end", "Card [removed] end"],
  ["Card 4111;2222;3333;5555 end", "Card [removed] end"],
  ["Card 4111:2222:3333:5555 end", "Card [removed] end"],
  ["Card 4111 : 2222 : 3333 : 5555 end", "Card [removed] end"],
  ["Card (4111) 2222-3333-5555 end", "Card ([removed] end"],
  ["Card 4111'2222'3333'5555 end", "Card [removed] end"],
  ["Card 4111=2222=3333=5555 end", "Card [removed] end"],
  ["Card 4111\\2222\\3333\\5555 end", "Card [removed] end"],
  ["Card 4111·2222·3333·5555 end", "Card [removed] end"],
  ["Card [4111][2222][3333][5555] end", "Card [[removed]] end"],
  ['Card "4111" "2222" "3333" "5555" end', 'Card "[removed]" end'],
  ["Card 4111, 2222; 3333 / 5555 end", "Card [removed] end"],
  ["Card 4111 .\n2222 ,\t3333 +\r\n5555 end", "Card [removed] end"],
  [
    "Card \uFF14\uFF11\uFF11\uFF11 \uFF12\uFF12\uFF12\uFF12 \uFF13\uFF13\uFF13\uFF13 \uFF15\uFF15\uFF15\uFF15 end",
    "Card [removed] end",
  ],
  ["Card ٤١١١ ٢٢٢٢ ٣٣٣٣ ٥٥٥٥ end", "Card [removed] end"],
  ["Card ۴۱۱۱ ۲۲۲۲ ۳۳۳۳ ۵۵۵۵ end", "Card [removed] end"],
  ["Card ४१११ २२२२ ३३३३ ५५५५ end", "Card [removed] end"],
  ["Card 𝟒𝟏𝟏𝟏 𝟐𝟐𝟐𝟐 𝟑𝟑𝟑𝟑 𝟓𝟓𝟓𝟓 end", "Card [removed] end"],
  [
    "Card 4\u03011\u03011\u03011\u0301 2\u03012\u03012\u03012\u0301 3\u03013\u03013\u03013\u0301 5\u03015\u03015\u03015\u0301 end",
    "Card [removed] end",
  ],
  [
    "Card 4\u03321\u03321\u03321\u0332 2\u03322\u03322\u03322\u0332 3\u03323\u03323\u03323\u0332 5\u03325\u03325\u03325\u0332 end",
    "Card [removed] end",
  ],
  [
    "Card 4\uFE0F\u20E31\uFE0F\u20E31\uFE0F\u20E31\uFE0F\u20E3 2\uFE0F\u20E32\uFE0F\u20E32\uFE0F\u20E32\uFE0F\u20E3 3\uFE0F\u20E33\uFE0F\u20E33\uFE0F\u20E33\uFE0F\u20E3 5\uFE0F\u20E35\uFE0F\u20E35\uFE0F\u20E35\uFE0F\u20E3 end",
    "Card [removed] end",
  ],
  [
    "Card 4\u200D1\u200D1\u200D1\u200D2\u200D2\u200D2\u200D2\u200D3\u200D3\u200D3\u200D3\u200D5\u200D5\u200D5\u200D5\u200D end",
    "Card [removed] end",
  ],
  ["Card ④①①① ②②②② ③③③③ ⑤⑤⑤⑤ end", "Card [removed] end"],
  ["Card ⁴¹¹¹ ²²²² ³³³³ ⁵⁵⁵⁵ end", "Card [removed] end"],
  [
    "See https://pay.example.test/c/4111222233335555?x=1 end",
    "See https://pay.example.test/c/[removed]?x=1 end",
  ],
  [
    "See https://pay.example.test/c/4111-2222-3333-5555/x end",
    "See https://pay.example.test/c/[removed]/x end",
  ],
  ["Mail 4111222233335555@example.test end", "Mail [removed] end"],
  ['JSON {"card":[4111,2222,3333,5555]} end', 'JSON {"card":[[removed]]} end'],
  [
    'JSON {"card":"4111 2222 3333 5555","last4":"4821"} end',
    'JSON {"card":"[removed]","last4":"[removed]"} end',
  ],
  ["Card 41.11 22.22 33.33 48.21 end", "Card 41.11 22.22 33.33 [removed] end"],
  ["Card 4111 2222 XX33 3355 55 end", "Card [removed] [removed] end"],
  [
    "acct4821 card4821x x4821y #4821 4821abc DANA4821",
    "acct[removed] card[removed]x [removed]y [removed]abc Member A[removed]",
  ],
  ["acct-4821 acct_4821 acct:4821", "acct-[removed] acct_[removed] acct:[removed]"],
  ["ending in 4821, last four: 7730", "ending in [removed], last four: [removed]"],
  ["ending 4,821; card 4,821", "ending [removed]; card [removed]"],
  ["card 48:21", "card [removed]"],
  ["card ٤٨٢١ and ७७३०", "card [removed] and [removed]"],
  ["card 4\u03018\u03012\u03011\u0301", "card [removed]"],
  ["card 4\uFF18\uFF121", "card [removed]"],
  ["card 48 \n 21", "card [removed]"],
  ["https://x.test/acct/4821/7730", "https://x.test/acct/[removed]"],
  ["10001-1234 and 10001 1234 and 100011234", "[removed] and [removed] and [removed]"],
  ["10001–1234", "[removed]"],
  ["1 0 0 0 1", "[removed]"],
  ["١٠٠٠١", "[removed]"],
  ["1\u03010\u03010\u03010\u03011\u0301", "[removed]"],
  ["zip:10001 NY10001 10001NY", "zip:[removed] NY[removed]NY"],
  ["ZIP 10,001 and $10,001.00 and 10001.00", "ZIP [removed] and $[removed].00 and [removed].00"],
  ["https://x.test/?zip=10001&p=1", "https://x.test/?zip=[removed]&p=1"],
  ['JSON {"postcode":"10001"}', 'JSON {"postcode":"[removed]"}'],
  ["1OOO1 and 1000l", "1OOO1 and 1000l"],
  ["ages forty-one, thirty-nine and eight", "ages [removed]"],
  ["age is 41; 41 years of age; aged: 39", "age is [removed] years of age; aged: [removed]"],
  ["41yrs, 39 y/o, 8-yr-old", "[removed]yrs, [removed]-yr-old"],
  ["ages ٤١ and ٣٩", "ages [removed]"],
  ['JSON {"a":41,"b":39,"c":8}', 'JSON {"a":[removed]}'],
  ["ages 41.0, 39.0 and 8.0", "ages [removed]"],
  ["41/39/8 and 8/41", "[removed]"],
  ["We are 41 39 8", "We are [removed]"],
  ["age is 41.", "age is [removed]."],
  ["41 years of age", "[removed] years of age"],
  ["Son is eight years old", "Son is [removed] years old"],
  ["aged eight", "aged [removed]"],
  ["kids are eight and thirty-nine", "kids are [removed]"],
  ["Dana is forty-one years old", "Member A is [removed] years old"],
  ["Dana is 41 and Ravi is 39, kid is 8", "Member A is [removed] and Member B is [removed]"],
  ["DANA dana Dána Dana's", "Member A Member A Member A Member A's"],
  [
    "DANAWHITFIELD and dana_whitfield and Dana2 and @danawhitfield",
    "Member A and Member A and Member A2 and @Member A",
  ],
  ["Da\u200Dna and Da\u034Fna", "Member A and Member A"],
  ["𝐃𝐚𝐧𝐚 bold", "Member A bold"],
  ["Ⓓⓐⓝⓐ circled", "Member A circled"],
  ["Whitfield's and WHITFIELD HARDWARE", "Member A's and Member A HARDWARE"],
  ["VENMO *DANA WHITFIELD and ZELLE TO WHITFIELD D", "VENMO *Member A and ZELLE TO Member A D"],
  [
    "Okafor-Whitfield and Ravi\u00ADOkafor and R.Okafor",
    "Member B-Member A and Member B and Member B",
  ],
  ["Dana-Whitfield-3", "Member A-3"],
  ["Rávi and RAVİ", "Member B and Member B"],
  ["DANA.W@EXAMPLE.COM and dana.w\uFF20example.com", "[removed] and [removed]"],
  [
    "dana.w at example dot com and dana.w(at)example.com",
    "Member A at example dot com and Member A(at)example.com",
  ],
  ["Dana\u200BWhitfield", "Member A"],
  ["Dana\u00ADWhitfield", "Member A"],
  ["Ravi\u2060Okafor", "Member B"],
  ["DANAWHITFIELD", "Member A"],
  ["OKAFORRAVI", "Member B"],
  ["@danawhitfield", "@Member A"],
  ["dana_whitfield", "Member A"],
  ["Ravi_Okafor", "Member B"],
  ["Dana2", "Member A2"],
  [
    "Ravi_Okafor rokafor RaviO OKAFORRAVI R. Okafor",
    "Member B Member B Member B Member B Member B",
  ],
  ["DANA WHITFIELD's card", "Member A's card"],
  ["dana.whitfield and dana-whitfield", "Member A and Member A"],
  ["Dana’s", "Member A’s"],
  ["ZELLE FROM DANA W ON 10/14", "ZELLE FROM Member A ON 10/14"],
  ["WHITFIELD HARDWARE #1005", "Member A HARDWARE [removed]"],
  ["Danas", "Danas"],
  ["D a n a", "Member A"],
  ["Dаna (Cyrillic a)", "Dаna (Cyrillic a)"],
  ["ᴅᴀɴᴀ small caps", "ᴅᴀɴᴀ small caps"],
  ["Da-\nna and Whit field and Wh1tfield", "Member A and Member A and Wh1tfield"],
  ["ʀᴀᴠɪ", "ʀᴀᴠɪ"],
  ["Card 4111 2222 3333 5555 / 4111—2222", "Card [removed]"],
  ["Card 4111–2222–3333–4821", "Card [removed]"],
  ["Card 4111|2222|3333|7730", "Card [removed]"],
  ["acct 12345678 and 1234 5678 and 1234-56-78", "acct [removed] and [removed] and [removed]"],
];

// Inputs the builder tried after the review, in the same spirit: mixed digit scripts, separators
// inside separators, symbols and emoji between groups, marks and keycaps, names glued or turned
// round, and ages in words.
const PROBED: [string, string][] = [
  ["Card ٤١١١ २२२२ \uFF13\uFF13\uFF13\uFF13 5555 mixed scripts", "Card [removed] mixed scripts"],
  ["Card 4111 -/- 2222 -/- 3333 -/- 5555", "Card [removed]"],
  ["Card 4111 ( 2222 ) 3333 { 5555 }", "Card [removed] }"],
  ["Card 4111¦2222¦3333¦5555", "Card [removed]"],
  ["Card 4111→2222→3333→5555", "Card [removed]"],
  ["Card 4111🙂2222🙂3333🙂5555", "Card [removed]"],
  ["Card 4111٫2222٬3333٫5555", "Card [removed]"],
  ["Card 4111、2222、3333、5555", "Card [removed]"],
  ["Card 4\uFE0E111 2\uFE0E222 3333 5555", "Card [removed]"],
  ["Card 4\u20DD1\u20DD1\u20DD1\u20DD 2222 3333 5555", "Card [removed]"],
  ["Card ๔๑๑๑ ๒๒๒๒ ๓๓๓๓ ๕๕๕๕", "Card [removed]"],
  ["Card \uFF14111–٢٢٢٢|3333 ५५५५", "Card [removed]"],
  ["acct 4\u0332 8\u0332 2 1", "acct [removed]"],
  ["acct 48٫21", "acct [removed]"],
  ["acct ४८२१", "acct [removed]"],
  [
    "Lives in 1\uFE0F\u20E30\uFE0F\u20E30\uFE0F\u20E30\uFE0F\u20E31\uFE0F\u20E3",
    "Lives in [removed]",
  ],
  ["Lives in 10001–1234 now", "Lives in [removed] now"],
  ["D\u0301a\u0301n\u0301a\u0301 paid", "Member A paid"],
  [
    "\uFF24\uFF21\uFF2E\uFF21_\uFF37\uFF28\uFF29\uFF34\uFF26\uFF29\uFF25\uFF2C\uFF242 paid",
    "Member A2 paid",
  ],
  ["Whitfield, Dana paid", "Member A paid"],
  ["d.a.n.a.w.h.i.t.f.i.e.l.d paid", "Member A paid"],
  ["Dana\nWhitfield paid", "Member A paid"],
  ["ages forty one, thirty nine, and eight", "ages [removed]"],
  ["Ravi turned thirty-nine", "Member B turned [removed]"],
  ["FORTY-ONE years old", "[removed] years old"],
  ["Dana's age is now forty-one", "Member A's age is now [removed]"],
  ["ages 4\u03011 and 3\u03019", "ages [removed]"],
  ["Dana was 41 last year", "Member A was [removed] last year"],
  ["ages fortyone and thirtynine", "ages [removed]"],
  ["Card 4111----2222----3333----5555", "Card [removed]"],
  ['JSON {"a":"4111","b":"1111","c":"1111","d":"1111"} end', 'JSON {"a":"[removed]"} end'],
  ["See https://x.test/?a=4111&b=1111&c=1111&d=1111 end", "See https://x.test/?a=[removed] end"],
  ["Card 4111 ~~~~ 1111 .... 1111 ---- 1111 + 77", "Card [removed]"],
];

const SYSTEM = "You help Dana and Ravi. Never name a company.";
const SUMMARY = [
  "Household summary: Dana (dana.w@example.com) and Ravi, ages 41, 39 and 8, ZIP 10001.",
  "Ally savings 4821 (Rainy day fund) holds $12,400.50 on 2026-10-31.",
].join("\n");
const NOTE = "Note from Ravi: card XXXX7730 was replaced; new number 4111 1111 1111 1111.";

// A price for the made-up models: $1 and $2 per million tokens, in millionths of a dollar.
const PRICE = { input: 1_000_000, output: 2_000_000 };

// A tool-free reply from a test model, of 5 input tokens and 1 output token.
const REPLY = {
  content: [{ type: "text" as const, text: "Done" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

const CONNECTION = {
  provider: "anthropic" as const,
  baseUrl: null,
  gatewayToken: undefined,
};

describe("the one AI call path", () => {
  let test: TestAi;
  let capture: CapturingFetch;
  let cost: AiCost;
  let rainyDayFund: string;

  beforeEach(async () => {
    test = await newTestAi();
    capture = new CapturingFetch();
    cost = aiCost({ database: test.database });
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values([
      {
        id: "m2",
        name: "Ravi Okafor",
        email: "ravi@example.org",
        createdAt: new Date("2026-03-04T00:00:00Z"),
        updatedAt: joined,
      },
      {
        id: "m1",
        name: "Dana Whitfield",
        email: "dana.w@example.com",
        createdAt: joined,
        updatedAt: joined,
      },
    ]);
    const savings = { subtype: "savings", institutionName: "Ally" };
    rainyDayFund = await addUnconnectedAccount(test.database, {
      ...savings,
      name: "Rainy day fund",
      mask: "4821",
    });
    await addUnconnectedAccount(test.database, {
      ...savings,
      name: "Ally Online Savings",
      mask: "7730",
    });
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [41, 39, 8], rentOrOwn: "own" },
      "m1",
    );
  });

  afterEach(() => {
    test.close();
  });

  const settingsFor = (provider: AiProviderName): AiSettingsInput => ({
    provider,
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });

  const options = (makeModels?: AiModelMaker) => ({
    database: test.database,
    secrets: test.secrets,
    makeModels,
    cost,
    logger: QUIET,
  });

  async function connect(provider: AiProviderName, makeModels = makeFetchModels(capture.fetch)) {
    const settings = aiSettings(options(makeModels));
    expect(await settings.save(settingsFor(provider), { freshCode: true })).toMatchObject({
      saved: true,
    });
    return householdAi(options(makeModels));
  }

  // The uses of the calls counted this month, oldest first.
  const counted = async () => (await cost.usage()).calls.map((call) => call.use).reverse();

  // A gate that notes each time it is asked, and lets every call through.
  function countedAs(events: string[]): (tier: AiTier) => OutboundCall {
    return (tier) => ({
      use: "chat",
      provider: "anthropic",
      model: `${tier}-model`,
      price: memberPrice(PRICE.input, PRICE.output),
      gate: async () => {
        events.push("gate");
        return undefined;
      },
      cost,
    });
  }

  const call: AiCall = {
    use: "chat",
    system: SYSTEM,
    messages: [
      { role: "user" as const, text: SUMMARY },
      { role: "assistant" as const, text: "Dana spent less than Ravi in October." },
      { role: "user" as const, text: NOTE },
    ],
  };

  it("sends Anthropic every part of a call through the filter", async () => {
    const ai = await connect("anthropic");

    await ai.generate(call);

    // "Ally savings" or "Ally savings 2", by the Accounts' IDs.
    const label = (await ai.accountLabels()).get(rainyDayFund);
    const sent = capture.requests.at(-1);
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.body.system).toEqual([
      { type: "text", text: "You help Member A and Member B. Never name a company." },
    ]);
    expect(sent?.body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Household summary: Member A ([removed]) and Member B, ages [removed], ZIP [removed].",
              `Ally savings [removed] (${label}) holds $12,400.50 on 2026-10-31.`,
            ].join("\n"),
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Member A spent less than Member B in October." }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Note from Member B: card [removed] was replaced; new number [removed].",
          },
        ],
      },
    ]);
  });

  it.each(["anthropic", "openai", "openrouter"] as const)(
    "sends %s no Member name, email address, Account number, or Household fact",
    async (provider) => {
      const ai = await connect(provider);

      expect(await ai.generate(call)).toEqual({ ready: true, text: "O" });

      // The two checks on save, then the call.
      expect(capture.requests).toHaveLength(3);
      for (const request of capture.requests) {
        const body = JSON.stringify(request.body);
        for (const value of PRIVATE) expect(body).not.toContain(value);
        expect(body).not.toMatch(/41\D{1,12}39\D{1,12}8/);
      }
      expect(JSON.stringify(capture.requests.at(-1)?.body)).toContain("Member A");
    },
  );

  it("filters every tool result before it goes back to the AI provider", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        if (prompts.length === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "payers",
                input: '{"month":"2026-10"}',
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "Done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const models = privateModels(
      test.database,
      () => ({ quick: model, writer: model }),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs([]),
    );

    await generateText({
      model: models.writer,
      prompt: "Who paid?",
      stopWhen: stepCountIs(2),
      tools: {
        payers: tool({
          description: "Who paid what in a month",
          inputSchema: jsonSchema<{ month: string }>({
            type: "object",
            properties: { month: { type: "string" } },
          }),
          execute: async () => ({
            payers: [
              { who: "Ravi Okafor", memo: "Zelle from Jordan Pike, card ****7730", cents: 4821 },
              { who: "dana", memo: "ACH 12-34-56-78 to dana.w@example.com", cents: 1250 },
            ],
          }),
        }),
      },
    });

    expect(prompts).toHaveLength(2);
    const second = prompts[1] as { role: string; content: { type: string; output?: unknown }[] }[];
    const result = second.find((message) => message.role === "tool")?.content[0];
    expect(result).toMatchObject({
      type: "tool-result",
      output: {
        type: "json",
        value: {
          payers: [
            { who: "Member B", memo: "Zelle from Jordan Pike, card [removed]", cents: "[removed]" },
            { who: "Member A", memo: "ACH [removed] to [removed]", cents: 1250 },
          ],
        },
      },
    });
  });

  it("refuses a file, so the call does not go out and does not count", async () => {
    const events: string[] = [];
    const models = privateModels(
      test.database,
      makeFetchModels(capture.fetch),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs(events),
    );

    await expect(
      generateText({
        model: models.quick,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "file", data: new TextEncoder().encode("Dana"), mediaType: "text/plain" },
            ],
          },
        ],
      }),
    ).rejects.toThrow(PrivacyRefusal);
    expect(capture.requests).toHaveLength(0);
    expect(events).toEqual([]);
    expect(await counted()).toEqual([]);
  });

  it("refuses a request that still holds a Household fact where the filter does not rewrite", async () => {
    const events: string[] = [];
    const models = privateModels(
      test.database,
      makeFetchModels(capture.fetch),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs(events),
    );

    await expect(
      generateText({
        model: models.quick,
        maxRetries: 0,
        prompt: "Hello",
        tools: {
          zip_10001: tool({ inputSchema: jsonSchema({ type: "object" }) }),
        },
      }),
    ).rejects.toThrow(PrivacyRefusal);
    expect(capture.requests).toHaveLength(0);
    expect(events).toEqual([]);
    expect(await counted()).toEqual([]);
  });

  it("passes a call through the filter, then the cost gate, and counts it once", async () => {
    const events: string[] = [];
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (sent) => {
        events.push("sent");
        prompts.push(sent.prompt);
        return REPLY;
      },
    });
    const models = privateModels(
      test.database,
      () => ({ quick: model, writer: model }),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs(events),
    );

    await generateText({ model: models.writer, prompt: "How did Dana do?", maxRetries: 0 });

    expect(events).toEqual(["gate", "sent"]);
    expect(prompts).toEqual([
      [{ role: "user", content: [{ type: "text", text: "How did Member A do?" }] }],
    ]);
    expect((await cost.usage()).calls).toMatchObject([
      { use: "chat", model: "writer-model", noCacheTokens: 5, outputTokens: 1, costNanos: 7_000 },
    ]);
  });

  it("refuses a call the filter cannot pass before the cost gate", async () => {
    const events: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        events.push("sent");
        return REPLY;
      },
    });
    const models = privateModels(
      test.database,
      () => ({ quick: model, writer: model }),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs(events),
    );

    await expect(
      generateText({
        model: models.writer,
        maxRetries: 0,
        prompt: "Hello",
        tools: { zip_10001: tool({ inputSchema: jsonSchema({ type: "object" }) }) },
      }),
    ).rejects.toThrow(PrivacyRefusal);

    expect(events).toEqual([]);
    expect(await counted()).toEqual([]);
  });

  it("counts the check on save and each call once, each passed through the filter", async () => {
    const ai = await connect("anthropic");

    expect(await ai.generate(call)).toEqual({ ready: true, text: "O" });

    expect(await counted()).toEqual(["check on save", "check on save", "chat"]);
    expect(capture.requests).toHaveLength(3);
    expect(JSON.stringify(capture.requests.at(-1)?.body)).toContain("Member A");
  });

  // Each way a Member could write a card number, a last 4, the ZIP code, the ages, or a name
  // that the filter must still see through, as it leaves in a Chat message.
  it.each([
    ["Card 4111  2222  3333  5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111\t2222\t3333\t5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111\u00A02222\u00A03333\u00A05555 was replaced", "Card [removed] was replaced"],
    ["Card 4111,2222,3333,5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111+2222+3333+5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111~2222~3333~5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111/2222/3333/5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111 . 2222 . 3333 . 5555 was replaced", "Card [removed] was replaced"],
    ["Card \uFF14\uFF11\uFF11\uFF11 2222 3333 5555 was replaced", "Card [removed] was replaced"],
    ["Card 41\u200B11 2222 3333 5555 was replaced", "Card [removed] was replaced"],
    ["Savings 48 21 or 48-21, and 77\t30", "Savings [removed] or [removed], and [removed]"],
    [
      "ZIP 10001.00, 100 01, and \uFF11\uFF10\uFF10\uFF10\uFF11",
      "ZIP [removed].00, [removed], and [removed]",
    ],
    ["We are 8, 41, 39", "We are [removed]"],
    ["Kids 39 and 8", "Kids [removed]"],
    ["The Whitfield household", "The Member A household"],
    [
      "Paid D.a.n.a, Da\u200Bna, and \uFF24\uFF41\uFF4E\uFF41",
      "Paid Member A, Member A, and Member A",
    ],
    // Split across line breaks, which stay in the message sent.
    ["Card 4111\n1111\n1111\n1111\nwas replaced", "Card [removed]\nwas replaced"],
    ["Card 4111-\r\n1111 1111 1111\r\nwas replaced", "Card [removed]\r\nwas replaced"],
    ["Card 4111\r1111\u20281111\u20291111 was replaced", "Card [removed] was replaced"],
    ["Card 4111\n 2222\n 3333\n 5555", "Card [removed]"],
    ["Savings 48\n21\nand 77\r\n30", "Savings [removed]\nand [removed]"],
    ["ZIP 100\n01\nthen 10\r\n 001", "ZIP [removed]\nthen [removed]"],
    ["We are\n8,\n41,\r\n39\nin all", "We are\n[removed]\nin all"],
  ])("sends %j as %j", async (written, sent) => {
    const ai = await connect("anthropic");

    expect(
      await ai.generate({
        use: "chat",
        system: "Help.",
        messages: [{ role: "user", text: written }],
      }),
    ).toEqual({ ready: true, text: "O" });

    expect(capture.requests.at(-1)?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: sent }] },
    ]);
  });

  it.each([
    ["the security review", REVIEWED],
    ["the builder's probe", PROBED],
  ])("sends each input from %s as the filter rewrote it", async (_, rows) => {
    const ai = await connect("anthropic");
    const sent: [string, unknown][] = [];

    for (const [written] of rows) {
      await ai.generate({
        use: "chat",
        system: "Help.",
        messages: [{ role: "user", text: written }],
      });
      const body = capture.requests.at(-1)?.body;
      expect(body?.system).toEqual([{ type: "text", text: "Help." }]);
      const messages = body?.messages as { content: { text: string }[] }[];
      sent.push([written, messages.length === 1 ? messages[0]?.content[0]?.text : messages]);
    }

    expect(sent).toEqual(rows);
  });

  it("filters the system prompt and each message, and refuses a fact split between them", async () => {
    const ai = await connect("anthropic");

    await ai.generate({
      use: "chat",
      system: "Help Dana (ages 41, 39 and 8), card 4111\u20142222\u20143333\u20145555, zip 10001.",
      messages: [
        { role: "user", text: "I am Dana" },
        { role: "assistant", text: "Hi Ravi, your card 4111 -- 2222 -- 3333 -- 4821" },
        { role: "user", text: "zip 10001" },
      ],
    });
    expect(capture.requests.at(-1)?.body).toMatchObject({
      system: [
        { type: "text", text: "Help Member A (ages [removed]), card [removed], zip [removed]." },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "I am Member A" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi Member B, your card [removed]" }],
        },
        { role: "user", content: [{ type: "text", text: "zip [removed]" }] },
      ],
    });

    // Each half of a card number goes, as each holds 8 digits.
    await ai.generate({
      use: "chat",
      system: "Card 4111 1111",
      messages: [{ role: "user", text: "1111 1111 end" }],
    });
    expect(capture.requests.at(-1)?.body).toMatchObject({
      system: [{ type: "text", text: "Card [removed]" }],
      messages: [{ role: "user", content: [{ type: "text", text: "[removed] end" }] }],
    });

    // A fact that no single app-built part holds is found in the prompt read as one text, and
    // refused.
    const sentBefore = capture.requests.length;
    for (const messages of [
      ["Lives in 100", "01 now"],
      ["Card 4111 11", "11 1111 1", "111 end"],
      ["Paid Da", "na yesterday"],
    ]) {
      await expect(
        ai.generate({
          use: "chat",
          system: "Help.",
          messages: messages.map((text, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text,
          })),
        }),
      ).rejects.toThrow(PrivacyRefusal);
    }
    expect(capture.requests).toHaveLength(sentBefore);
  });

  it("sends Member-typed text as the filter rewrote it, and never refuses it", async () => {
    const ai = await connect("anthropic");
    // A card number and two stored ages, each split across a Chat's messages.
    const history = ["Card 4111 11", "11 1111 1", "111. We are 8 and", "41 now"];
    const chat = (typed: boolean): AiCall => ({
      use: "chat",
      system: "Help.",
      messages: history.map((text, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text,
        ...(typed ? { typed } : {}),
      })),
    });
    const sentTexts = () =>
      ((capture.requests.at(-1)?.body.messages ?? []) as { content: { text: string }[] }[]).map(
        (message) => message.content[0]?.text,
      );

    // As app-built text, the final check finds both and refuses the call.
    const sentBefore = capture.requests.length;
    await expect(ai.generate(chat(false))).rejects.toThrow(PrivacyRefusal);
    expect(capture.requests).toHaveLength(sentBefore);

    // As Member-typed text, the call goes out, and the filter's mark does not.
    expect(await ai.generate(chat(true))).toEqual({ ready: true, text: "O" });
    expect(sentTexts()).toEqual(history);
    expect(JSON.stringify(capture.requests.at(-1)?.body)).not.toContain("privacyFilter");

    // The filter still does its best on each message.
    await ai.generate({
      use: "chat",
      system: "Help.",
      messages: [
        { role: "user", text: "I am 41, Ravi is 39. Card 4111 1111 1111 1111", typed: true },
      ],
    });
    expect(sentTexts()).toEqual(["I am 41, Member B is [removed]. Card [removed]"]);
  });

  it.each([false, true])(
    "sends a Chat with a year, then an amount, with typed %s",
    async (typed) => {
      const ai = await connect("anthropic");
      const history = ["How much did we spend in 2025?", "$41,203 in total.", "And in 2024?"];

      expect(
        await ai.generate({
          use: "chat",
          system: "Help.",
          messages: history.map((text, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text,
            typed,
          })),
        }),
      ).toEqual({ ready: true, text: "O" });
    },
  );

  it.each([
    [
      { who: "Dana", card: "4111--2222--3333--5555", n: "7730", m: "4\u03018\u03012\u03011\u0301" },
      { owner: "Dana", card: "4111 2222 3333 5555", m: "4\u03018\u03012\u03011\u0301" },
      { who: "Member A", card: "[removed]", n: "[removed]", m: "[removed]" },
      { owner: "Member A", card: "[removed]", m: "[removed]" },
    ],
    [
      { month: "10" },
      { parts: [4111, 1111, 1111, 1111], family: [41, 39, 8] },
      { month: "10" },
      { parts: Array(4).fill("[removed]"), family: Array(3).fill("[removed]") },
    ],
    [
      { n: 4821 },
      { where: 10001, acct: 7730.0, a: 4111, b: 1111, c: 1111, d: 1111 },
      { n: "[removed]" },
      {
        where: "[removed]",
        acct: "[removed]",
        a: "[removed]",
        b: "[removed]",
        c: "[removed]",
        d: "[removed]",
      },
    ],
  ])(
    "sends tool input %j and tool result %j as filtered JSON",
    async (input, output, sentInput, sentOutput) => {
      await generateText({
        model: privateModels(
          test.database,
          makeFetchModels(capture.fetch),
          { ...CONNECTION, apiKey: newAiKey() },
          { quick: "q", writer: "w" },
          countedAs([]),
        ).writer,
        maxRetries: 0,
        messages: [
          { role: "user", content: "Who paid?" },
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call", toolName: "lookup", input }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call",
                toolName: "lookup",
                output: { type: "json", value: output },
              },
            ],
          },
        ],
      });

      const [, call, result] = (capture.requests.at(-1)?.body.messages ?? []) as {
        content: { input?: unknown; content?: string }[];
      }[];
      expect(call?.content[0]?.input).toEqual(sentInput);
      expect(JSON.parse(String(result?.content[0]?.content))).toEqual(sentOutput);
    },
  );

  it("filters the headers, provider options, and stop sequences", async () => {
    await generateText({
      model: privateModels(
        test.database,
        makeFetchModels(capture.fetch),
        { ...CONNECTION, apiKey: newAiKey() },
        { quick: "q", writer: "w" },
        countedAs([]),
      ).writer,
      maxRetries: 0,
      prompt: "Hello",
      headers: { "x-note": "Dana 10001 card 4111|2222|3333|5555" },
      providerOptions: { anthropic: { metadata: { userId: "ravi@example.org" } } },
      stopSequences: ["Ravi", "10001"],
    });

    const sent = capture.requests.at(-1);
    expect(sent?.headers["x-note"]).toBe("Member A [removed] card [removed]");
    expect(sent?.body).toMatchObject({
      stop_sequences: ["Member B", "[removed]"],
      metadata: { user_id: "[removed]" },
    });
  });

  it("takes no tools and no response schema, so none goes out", async () => {
    const ai = await connect("anthropic");
    const parameters = jsonSchema({ type: "object", properties: { name: { const: "Dana" } } });

    await expect(
      // @ts-expect-error An AI call takes no tools.
      ai.generate({ ...call, tools: { payers: tool({ inputSchema: parameters }) } }),
    ).rejects.toThrow(TypeError);
    await expect(
      // @ts-expect-error An AI call takes no response schema.
      ai.generate({ ...call, responseFormat: { type: "json", schema: parameters } }),
    ).rejects.toThrow(TypeError);
    await expect(
      ai.generate({
        ...call,
        // @ts-expect-error A message holds only its role and text.
        messages: [{ role: "user", text: "Hi", providerOptions: { anthropic: {} } }],
      }),
    ).rejects.toThrow(TypeError);

    // Only the two checks on save.
    expect(capture.requests).toHaveLength(2);
    expect(await counted()).toEqual(["check on save", "check on save"]);
  });

  it("sends nothing, and checks nothing on save, when it cannot read what it hides", async () => {
    const stub = new StubModels();
    const settings = aiSettings(options(stub.makeModels));
    await settings.save(settingsFor("anthropic"), { freshCode: true });
    expect(stub.calls).toHaveLength(2);
    await test.database.$client.execute("ALTER TABLE members RENAME TO members_away");

    const ai = householdAi(options(stub.makeModels));
    await expect(ai.generate(call)).rejects.toThrow();
    const saved = await settings.save(
      { ...settingsFor("anthropic"), quickModel: "other" },
      { freshCode: true },
    );

    expect(saved).toMatchObject({ saved: true, check: { quick: "failed", writer: "failed" } });
    expect(stub.calls).toHaveLength(2);
    expect(await counted()).toEqual(["check on save", "check on save"]);
  });

  it("takes the no-AI path with no AI provider", async () => {
    const ai = householdAi(options(makeFetchModels(capture.fetch)));

    expect(await ai.generate(call)).toEqual({ ready: false, pause: "no AI provider" });
    expect(capture.requests).toEqual([]);
  });

  it("shows Members their names in AI text, and labels each Account", async () => {
    const ai = householdAi(options());

    expect(await ai.showMemberNames("Member B spent less than Member A.")).toBe(
      "Ravi Okafor spent less than Dana Whitfield.",
    );
    expect([...(await ai.accountLabels()).values()].sort()).toEqual([
      "Ally savings",
      "Ally savings 2",
    ]);
  });
});
