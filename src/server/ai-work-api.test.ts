import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, StubModels } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { claimHistoryWaitEnd, markSetupStep, storeAiFailure } from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import {
  AI_WORK_REFUSALS,
  type AiWorkKind,
  type AiWorkView,
  aiWork,
  runRedoJob,
  startRedo,
} from "../redo/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings → AI's AI work routes (spec 08, AI work on your Transactions), through the app's HTTP
// interface, on the real redo module and AI SDK test models with a made-up key. A press starts its
// run's job: here `works` records it. No test calls an AI provider.

const APP_URL = "http://nas.local:8080";
const PRICE = { input: 1_000_000, output: 2_000_000 };
const PRESSES = ["/api/ai/work/finish", "/api/ai/work/all-history"] as const;
const INSIGHT_CARDS = JSON.stringify({
  cards: [1, 2, 3, 4].map((n) => ({
    group: "heads_up",
    about: `Topic ${n}`,
    figure: n,
    figureKind: "count",
    figureLabel: "this month",
    title: `Card ${n}`,
    why: `Why card ${n} matters.`,
    nextStep: `Step ${n}.`,
    picture: null,
  })),
});

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-ai-work-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the AI work routes", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubModels;
  let options: AiOptions;
  let alice: TestMember;
  let works: AiWorkKind[];
  let pausedUntil: string | undefined;
  let stopRedo: () => void;
  let clients = 0;

  beforeEach(async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    stub = new StubModels();
    works = [];
    pausedUntil = undefined;
    options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      gates: { historyLoaded: async () => true, costCapPausedUntil: async () => pausedUntil },
      notices: { raise: async () => undefined, end: async () => undefined },
      logger,
    };
    const notify = startNotify({
      database: test.database,
      delivery: {
        secrets: test.secrets,
        address: (path) => `${APP_URL}${path}`,
        startJob: async () => {},
      },
    });
    const redo = startRedo({
      database: test.database,
      ai: householdAi(options),
      now: () => new Date("2026-11-06T15:00:00.000Z"),
      startJob: async () => {},
      startWork: async (kind) => {
        works.push(kind);
      },
    });
    stopRedo = () => {
      redo.stop();
      notify.stop();
    };
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
      { ai: aiSettings(options), aiWork },
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
  });

  afterEach(() => {
    stopRedo();
    test.close();
  });

  // The wizard is done and the history has loaded: the first AI run is due, so a press has work.
  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
    await claimHistoryWaitEnd(test.database, new Date("2026-11-06T14:00:00.000Z"));
  }

  async function signedIn(): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(alice);
    return tab;
  }

  async function connectAi(): Promise<void> {
    const saved = await aiSettings(options).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
  }

  const workOf = async (res: Response) => ((await res.json()) as { work: AiWorkView }).work;

  it("answers 401 to a browser with no session, and starts nothing", async () => {
    await finishWizard();
    await connectAi();
    const calls = stub.calls.length;
    const tab = new TestBrowser(app, APP_URL, "192.168.1.200");

    expect((await tab.get("/api/ai/work")).status).toBe(401);
    for (const path of PRESSES) expect((await tab.post(path, {})).status).toBe(401);
    expect(works).toEqual([]);
    expect(stub.calls).toHaveLength(calls);
  });

  it("answers 403 to another site's Origin and to no Origin, and 415 to a body that is not JSON, and starts nothing", async () => {
    await finishWizard();
    await connectAi();
    const calls = stub.calls.length;
    const tab = await signedIn();

    for (const path of PRESSES) {
      for (const origin of ["http://evil.example", `${APP_URL}.evil.example`, undefined]) {
        expect((await tab.send("POST", path, {}, { origin })).status).toBe(403);
      }
      expect((await tab.send("POST", path, {}, { "content-type": "text/plain" })).status).toBe(415);
      expect((await tab.post(path, { kind: "all history" })).status).toBe(400);
    }
    expect(works).toEqual([]);
    expect(stub.calls).toHaveLength(calls);

    // None of them took the run's place.
    const pressed = await tab.post("/api/ai/work/all-history");
    expect(pressed.status).toBe(202);
    expect(works).toEqual(["all history"]);
  });

  it("refuses a press before the first-run wizard is done", async () => {
    await connectAi();
    const tab = await signedIn();

    expect((await tab.post("/api/ai/work/finish")).status).toBe(409);
    expect(works).toEqual([]);
  });

  it("shows the status line, and refuses a press while AI waits with its words and no call", async () => {
    await finishWizard();
    const tab = await signedIn();

    const line = await tab.get("/api/ai/work");
    expect(line.status).toBe(200);
    expect(await workOf(line)).toEqual({
      running: null,
      waits: "no AI provider",
      retryAt: null,
      waiting: 0,
      lastRun: null,
    });
    const refused = await tab.post("/api/ai/work/finish");
    expect([refused.status, await refused.json()]).toEqual([
      409,
      { error: AI_WORK_REFUSALS["no AI provider"] },
    ]);

    await connectAi();
    pausedUntil = "2026-12-01";
    const calls = stub.calls.length;
    const atCap = await tab.post("/api/ai/work/all-history");
    expect([atCap.status, await atCap.json()]).toEqual([
      409,
      { error: "The AI cost cap is reached. Raise the cap, or wait for the 1st." },
    ]);
    expect(works).toEqual([]);
    expect(stub.calls).toHaveLength(calls);
  });

  it("shows a retry wait on the status line, and a press skips it and starts the run", async () => {
    await finishWizard();
    await connectAi();
    // ZIP 10001: America/New_York, on Eastern Standard Time on Nov 6, 2026.
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40], rentOrOwn: "rent" },
      alice.id,
      new Date("2026-11-06T14:00:00.000Z"),
    );
    await storeAiFailure(
      test.database,
      "merchant cleanup",
      1,
      new Date("2026-11-06T15:01:00.000Z"),
    );
    await storeAiFailure(test.database, "category fix", 2, new Date("2026-11-06T15:05:00.000Z"));
    const tab = await signedIn();
    const calls = stub.calls.length;

    expect(await workOf(await tab.get("/api/ai/work"))).toMatchObject({
      running: null,
      waits: "retry wait",
      retryAt: "2026-11-06T15:05:00.000Z",
    });
    expect(stub.calls).toHaveLength(calls);
    const pressed = await tab.post(PRESSES[0]);
    expect(pressed.status).toBe(202);
    expect(works).toEqual(["finish"]);
  });

  it("starts one run, refuses a press while it runs, and shows the last run once it ends", async () => {
    await finishWizard();
    await connectAi();
    const tab = await signedIn();

    // Presses sent together start one run.
    const answers = await Promise.all([
      tab.post("/api/ai/work/finish"),
      tab.post("/api/ai/work/all-history"),
      tab.post("/api/ai/work/finish"),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([202, 409, 409]);
    expect(works).toHaveLength(1);
    const running = await workOf(await tab.get("/api/ai/work"));
    expect(running.running).toEqual({ kind: works[0], step: "starting" });
    const again = await tab.post("/api/ai/work/all-history");
    expect([again.status, await again.json()]).toEqual([409, { error: AI_WORK_REFUSALS.running }]);

    // The first AI run's one call here: its Insight card run, as the database holds no Transaction.
    stub.replyTo = () => INSIGHT_CARDS;
    await runRedoJob(works[0]);
    const done = await workOf(await tab.get("/api/ai/work"));
    expect(done).toMatchObject({
      running: null,
      waits: null,
      lastRun: {
        at: "2026-11-06T15:00:00.000Z",
        items: 0,
        aiCategories: 0,
        outcome: "finished",
      },
    });
    // The first AI run is done, and nothing is marked: "Finish AI work now" has nothing to do.
    const nothing = await tab.post("/api/ai/work/finish");
    expect([nothing.status, await nothing.json()]).toEqual([
      409,
      { error: "Nothing waits for the AI." },
    ]);
  });

  it("answers 404 when the app runs no redo", async () => {
    await finishWizard();
    app = createApp(
      webRoot,
      await loadSecurity(
        { APP_URL },
        { logger: createLogger(() => {}, { throwOnSecretField: true }) },
      ),
      test.auth,
      test.database,
      test.secrets,
      { ai: aiSettings(options) },
    );
    const tab = await signedIn();

    expect((await tab.get("/api/ai/work")).status).toBe(404);
    expect((await tab.post("/api/ai/work/finish")).status).toBe(404);
  });
});
