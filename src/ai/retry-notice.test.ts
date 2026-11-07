import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAiRetry } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import type { AiSettings } from "./ai-view.ts";
import { aiCost } from "./cost.ts";
import { type HouseholdAi, householdAi } from "./household-ai.ts";
import type { AiCall } from "./prompt.ts";
import { RETRY_DELAYS_MS, retriesRanOutCondition, retriesRanOutText } from "./retries.ts";
import { aiSettings } from "./settings.ts";
import { newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// The System notice when a background AI use runs out of retries (spec 08, Failures; spec 06,
// System notices; known finding K4): one notice at the cap for each run of failures, which ends
// when the use works again. On AI SDK test models through the real notify module, with a fake
// clock. No test calls an AI provider.

const PRICE = { input: 1_000_000, output: 2_000_000 };
const START = new Date("2026-11-04T15:00:00Z").getTime();

describe("a background AI use that runs out of retries", () => {
  let test: TestAi;
  let stub: StubModels;
  let ai: HouseholdAi;
  let settings: AiSettings;
  let lines: string[];
  let stopNotify: () => void;
  let at: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    at = START;
    test = await newTestAi();
    stub = new StubModels();
    lines = [];
    stopNotify = startNotify({ database: test.database }).stop;
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
    };
    settings = aiSettings(options);
    expect(
      await settings.save({
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: PRICE, writer: PRICE },
      }),
    ).toMatchObject({ saved: true });
    ai = householdAi(options);
  });

  afterEach(() => {
    stopNotify();
    vi.useRealTimers();
    test.close();
  });

  const call = (use: "category fix" | "merchant cleanup"): AiCall => ({
    use,
    task: "Suggest a Category for each Transaction.",
    batch: [{ merchant: "Bluebird Books", amount: -12.5 }],
  });

  // Each call of a run of failures, at its retry time: the first call and its 3 retries.
  async function failsToTheCap(use: "category fix" | "merchant cleanup" = "category fix") {
    const replies = [];
    for (let index = 0; index <= RETRY_DELAYS_MS.length; index += 1) {
      replies.push(await ai.generate(call(use)));
      at += RETRY_DELAYS_MS[index] ?? 0;
      vi.setSystemTime(at);
    }
    return replies;
  }

  const notices = async () =>
    (
      await test.database.$client.execute(
        "SELECT kind, text, condition, closed_at FROM system_notices ORDER BY raised_at, rowid",
      )
    ).rows.map((row) => ({
      kind: row.kind,
      text: row.text,
      condition: row.condition,
      open: row.closed_at === null,
    }));

  const ranOut = (open: boolean) => ({
    kind: "condition",
    text: "AI could not help with Categories after 3 retries, so the app went on without it. It tries AI again at the next sync.",
    condition: retriesRanOutCondition("category fix"),
    open,
  });

  it("stops at its cap when its call always throws, and raises one System notice", async () => {
    stub.answers.quick = "fail";

    const replies = await failsToTheCap();

    expect(replies.at(-1)).toEqual({ ready: false, failed: "server error" });
    expect(replies.slice(0, -1).every((reply) => "retryAt" in reply)).toBe(true);
    // The first call and its 3 retries: no more.
    expect(stub.calls.slice(2)).toHaveLength(4);
    expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
    expect(await notices()).toEqual([ranOut(true)]);
    // The notice and the log hold no error text.
    expect(JSON.stringify(await notices())).not.toMatch(/Refused|Error|500/u);
    expect(lines.join("\n")).not.toContain("Refused");
  });

  it("raises no more for the same run of failures, ends when the use works, and raises one again for a new run", async () => {
    stub.answers.quick = "fail";
    await failsToTheCap();
    // The use's next call starts a new round of retries in the same outage: still one notice.
    await failsToTheCap();
    expect(await notices()).toEqual([ranOut(true)]);

    stub.answers.quick = "work";
    expect(await ai.generate(call("category fix"))).toMatchObject({ ready: true });
    expect(await notices()).toEqual([ranOut(false)]);

    stub.answers.quick = "fail";
    await failsToTheCap();
    expect(await notices()).toEqual([ranOut(false), ranOut(true)]);
  });

  it("ends the notice when a Member removes the AI provider, as every use then calls no AI", async () => {
    stub.answers.quick = "fail";
    await failsToTheCap();
    expect(await notices()).toEqual([ranOut(true)]);

    await settings.remove();

    expect(await notices()).toEqual([ranOut(false)]);
    expect(await ai.generate(call("category fix"))).toEqual({
      ready: false,
      pause: "no AI provider",
    });
  });

  it("says when each use tries AI again", () => {
    expect(retriesRanOutText("budget tailoring")).toBe(
      "AI could not help with Budget tailoring after 3 retries, so the app went on without it. It tries AI again at the next Budget tailoring run.",
    );
  });

  it("keeps each use's notice apart, and raises none before the cap", async () => {
    stub.answers.quick = "fail";
    await ai.generate(call("merchant cleanup"));
    expect(await notices()).toEqual([]);

    await failsToTheCap("category fix");
    stub.answers.quick = "work";
    at += RETRY_DELAYS_MS[0];
    vi.setSystemTime(at);
    expect(await ai.generate(call("merchant cleanup"))).toMatchObject({ ready: true });

    // Merchant cleanup working never ends the notice for Category fixes.
    expect(await notices()).toEqual([ranOut(true)]);
  });

  it("raises none for a use that never ran out, when it works", async () => {
    expect(await ai.generate(call("category fix"))).toMatchObject({ ready: true });
    expect(await notices()).toEqual([]);
  });
});
