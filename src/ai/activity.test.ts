import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log.ts";
import type { AiActivityView } from "../redo/work-view.ts";
import {
  aiActivity,
  aiActivityWatchers,
  isActivityUse,
  showRunActivity,
  startAiActivity,
} from "./activity.ts";
import { aiCost } from "./cost.ts";
import { householdAi } from "./household-ai.ts";
import type { AiCall } from "./prompt.ts";
import { aiSettings } from "./settings.ts";
import { newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// The live AI status's record of background AI work (spec 08, Live AI status): what it holds, who
// hears each change, and that every call of a background use shows from its start to its end, a
// throw included. On AI SDK test models with a made-up key. No test calls an AI provider.

const PRICE = { input: 1_000_000, output: 2_000_000 };
const IDLE: AiActivityView = { run: null, uses: [] };

afterEach(() => {
  aiActivity.stop();
  showRunActivity(null);
});

describe("the live AI status's record", () => {
  it("holds each background use with a call in progress, in the order the calls started, with its count", () => {
    expect(aiActivity.now()).toEqual(IDLE);
    const cards = startAiActivity("insight cards");
    const fix = startAiActivity("category fix");
    const fixAgain = startAiActivity("category fix");
    expect(aiActivity.now()).toEqual({
      run: null,
      uses: [
        { use: "insight cards", calls: 1 },
        { use: "category fix", calls: 2 },
      ],
    });
    fix();
    // An end run twice ends its call once.
    fix();
    expect(aiActivity.now().uses).toEqual([
      { use: "insight cards", calls: 1 },
      { use: "category fix", calls: 1 },
    ]);
    cards();
    fixAgain();
    expect(aiActivity.now()).toEqual(IDLE);
  });

  it("tells each watcher every change, and a run once per change", () => {
    const seen: AiActivityView[] = [];
    const stop = aiActivity.watch(
      (view) => seen.push(view),
      () => {},
    );
    showRunActivity({ kind: "finish", step: "starting" });
    showRunActivity({ kind: "finish", step: "starting" });
    showRunActivity({ kind: "finish", step: "Categories" });
    const end = startAiActivity("category fix");
    end();
    showRunActivity(null);
    showRunActivity(null);
    stop();
    showRunActivity({ kind: null, step: "Merchant names" });

    expect(seen).toEqual([
      { run: { kind: "finish", step: "starting" }, uses: [] },
      { run: { kind: "finish", step: "Categories" }, uses: [] },
      { run: { kind: "finish", step: "Categories" }, uses: [{ use: "category fix", calls: 1 }] },
      { run: { kind: "finish", step: "Categories" }, uses: [] },
      IDLE,
    ]);
    expect(aiActivityWatchers()).toBe(0);
  });

  it("drops a watcher that throws, ends its stream once, and still tells the others", () => {
    const seen: string[] = [];
    let ended = 0;
    aiActivity.watch(
      () => {
        throw new Error("This stream broke.");
      },
      () => {
        ended += 1;
      },
    );
    aiActivity.watch(
      (view) => seen.push(view.uses.map((each) => each.use).join()),
      () => {},
    );
    const end = startAiActivity("monthly review");
    end();

    expect(seen).toEqual(["monthly review", ""]);
    expect(ended).toBe(1);
    expect(aiActivityWatchers()).toBe(1);
  });

  it("ends every watcher once when the app stops, and keeps none", () => {
    let ended = 0;
    const seen: AiActivityView[] = [];
    for (let n = 0; n < 3; n += 1) {
      aiActivity.watch(
        (view) => seen.push(view),
        () => {
          ended += 1;
        },
      );
    }
    aiActivity.stop();
    aiActivity.stop();
    startAiActivity("alert advice")();

    expect(ended).toBe(3);
    expect(seen).toEqual([]);
    expect(aiActivityWatchers()).toBe(0);
  });

  it("shows every background use, and not Chat or reading a Goal, which a Member starts", () => {
    expect(isActivityUse("category fix")).toBe(true);
    expect(isActivityUse("budget tailoring")).toBe(true);
    expect(isActivityUse("chat")).toBe(false);
    expect(isActivityUse("reading a goal")).toBe(false);
  });
});

describe("a background AI call on the live AI status", () => {
  let test: TestAi;
  let stub: StubModels;

  beforeEach(async () => {
    test = await newTestAi();
    stub = new StubModels();
  });

  afterEach(() => {
    test.close();
  });

  const optionsOf = () => ({
    database: test.database,
    secrets: test.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: test.database }),
    logger: createLogger(() => {}, { throwOnSecretField: true }),
    notices: { raise: async () => undefined, end: async () => undefined },
  });

  async function connect() {
    const options = optionsOf();
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

  const categoryFix: AiCall = {
    use: "category fix",
    task: "Suggest a Category for each Transaction.",
    batch: [{ merchant: "Bluebird Books", amount: -12.5 }],
  };

  it("shows the use while its call is out, with no Transaction detail, and hides it after the answer", async () => {
    const ai = await connect();
    const during: AiActivityView[] = [];
    stub.beforeAnswer = async () => {
      during.push(aiActivity.now());
    };

    const reply = await ai.generate(categoryFix);

    expect(reply.ready).toBe(true);
    expect(during).toEqual([{ run: null, uses: [{ use: "category fix", calls: 1 }] }]);
    expect(JSON.stringify(during)).not.toContain("Bluebird");
    expect(aiActivity.now()).toEqual(IDLE);
  });

  it("hides the use after a call that throws, and after an AI error", async () => {
    const ai = await connect();
    stub.beforeAnswer = async () => {
      throw new TypeError("The database is locked.");
    };
    await expect(ai.generate(categoryFix)).rejects.toThrow();
    expect(aiActivity.now()).toEqual(IDLE);

    stub.beforeAnswer = async () => {};
    stub.answers.quick = "rate limit";
    const reply = await ai.generate(categoryFix);
    expect(reply.ready).toBe(false);
    expect(aiActivity.now()).toEqual(IDLE);
  });

  it("never shows Chat or reading a Goal, and shows nothing for a use that pauses with no call", async () => {
    const ai = await connect();
    const during: AiActivityView[] = [];
    stub.beforeAnswer = async () => {
      during.push(aiActivity.now());
    };

    await ai.generate({ use: "reading a goal", task: "Read this Goal." });
    expect(during).toEqual([IDLE]);

    // No AI provider: the use pauses and makes no call.
    await aiSettings(optionsOf()).remove();
    const seen: AiActivityView[] = [];
    const stop = aiActivity.watch(
      (view) => seen.push(view),
      () => {},
    );
    expect(await ai.generate(categoryFix)).toMatchObject({ ready: false, pause: "no AI provider" });
    stop();
    expect(seen).toEqual([]);
  });
});
