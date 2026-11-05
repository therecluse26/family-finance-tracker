import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, StubModels } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { addGoal, listGoals, markSetupStep, storeAiSettings } from "../db/index.ts";
import { goalWriting, startGoal } from "../goals/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { GoalView } from "./goals-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Goals and their progress through the app's HTTP interface (spec 05, Goals). The first tests
// write each reading directly, with no AI; adding a Goal and editing its words read it with AI SDK
// test models behind the real privacy filter and cost gate.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-goals-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Goal routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let memberId: string;
  let saving: string;
  let noTarget: string;

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    memberId = member.id;
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await markSetupStep(test.database, "master key", "done");

    const reading = { authorId: memberId, date: "2026-10-01", deadline: null };
    saving = await addGoal(test.database, {
      ...reading,
      words: "Save $1,000",
      target: { kind: "Saving" },
      change: { amount: 100_000 },
    });
    await startGoal(test.database, saving);
    noTarget = await addGoal(test.database, {
      ...reading,
      words: "Be careful with money",
      target: null,
      change: null,
    });
  });

  afterEach(() => {
    test.close();
  });

  const goals = async () =>
    ((await (await browser.get("/api/goals")).json()) as { goals: GoalView[] }).goals;

  it("returns each Goal with its progress", async () => {
    expect(await goals()).toEqual([
      expect.objectContaining({
        id: saving,
        words: "Save $1,000",
        authorId: memberId,
        author: "Alice",
        date: "2026-10-01",
        status: "active",
        reading: { target: { kind: "Saving" }, change: { amount: 100_000 }, deadline: null },
        goalAmount: 100_000,
        list: "active",
        progress: {
          kind: "save toward an amount",
          percentage: 0,
          state: null,
          detail: "$0 of $1,000",
          estimated: false,
        },
      }),
      expect.objectContaining({ id: noTarget, list: "active", progress: null }),
    ]);
  });

  it("names each Goal's author, and no one once that Member is gone", async () => {
    const orphan = await addGoal(test.database, {
      words: "Spend less on books",
      authorId: null,
      date: "2026-10-02",
      target: null,
      change: null,
      deadline: null,
    });

    const named = new Map((await goals()).map((goal) => [goal.id, goal.author]));
    expect(named).toEqual(
      new Map([
        [saving, "Alice"],
        [noTarget, "Alice"],
        [orphan, null],
      ]),
    );
  });

  it("says whether the Household has an AI provider", async () => {
    const aiProvider = async () =>
      ((await (await browser.get("/api/goals")).json()) as { aiProvider: boolean }).aiProvider;

    expect(await aiProvider()).toBe(false);
    await storeAiSettings(
      test.database,
      {
        provider: "openai-compatible",
        apiKey: null,
        baseUrl: "http://127.0.0.1:9/v1",
        gatewayToken: null,
        quickModel: "test-quick",
        writerModel: "test-writer",
        keyRejectedAt: null,
      },
      0,
    );
    expect(await aiProvider()).toBe(true);
  });

  it("marks an active Goal done or dropped, by the signed-in Member", async () => {
    const res = await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "dropped" });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: GoalView };
    expect(goal).toMatchObject({ id: noTarget, status: "dropped", endedBy: memberId });
    expect(goal.list).toBe("dropped");

    const done = await browser.send("POST", `/api/goals/${saving}/status`, { status: "done" });
    expect(await done.json()).toEqual({
      goal: expect.objectContaining({
        status: "done",
        list: "active",
        progress: expect.objectContaining({ state: "Done", percentage: 100 }),
      }),
    });
    expect((await goals()).map((each) => each.id)).toEqual([saving, noTarget]);
  });

  it("answers 409 to a Goal that is not active, 404 to an unknown one, and 400 to a bad mark, and changes nothing", async () => {
    await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "dropped" });
    const before = await listGoals(test.database);

    const again = await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "done" });
    expect(again.status).toBe(409);
    expect(
      (await browser.send("POST", "/api/goals/no-such-goal/status", { status: "done" })).status,
    ).toBe(404);
    for (const body of [{ status: "active" }, { status: "done", by: "x" }, {}]) {
      expect((await browser.send("POST", `/api/goals/${saving}/status`, body)).status).toBe(400);
    }

    expect(await listGoals(test.database)).toEqual(before);
  });

  it("answers 401 with no session, 403 from another site, and 415 to a body that is not JSON, and changes nothing", async () => {
    const before = await listGoals(test.database);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const path = `/api/goals/${saving}/status`;
    const body = { status: "dropped" };

    expect((await signedOut.get("/api/goals")).status).toBe(401);
    expect((await signedOut.send("POST", path, body)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.send("POST", path, body, { origin })).status).toBe(403);
    }
    expect((await browser.send("POST", path, body, { "content-type": "text/plain" })).status).toBe(
      415,
    );

    expect(await listGoals(test.database)).toEqual(before);
  });
});

describe("adding a Goal and editing its words", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stub: StubModels;
  let historyLoaded: boolean;
  let pausedUntil: string | undefined;
  let goalRuns: string[];
  let callsBefore: number;

  // The restaurants Goal's reading. Any other Goal reads as saying nothing of a target.
  const RESTAURANTS = {
    target: { kind: "Category", category: "Restaurants", merchant: null, accounts: null },
    change: { amount: null, percent: 20 },
    deadline: null,
  };

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    stub = new StubModels();
    stub.replyTo = (messages) => {
      const last = messages.at(-1)?.content;
      const words = typeof last === "string" ? last : (last?.[0]?.text ?? "");
      return JSON.stringify(
        words.includes("restaurants")
          ? RESTAURANTS
          : // A deadline long passed.
            { target: null, change: null, deadline: words.includes("2001") ? "2001-01-31" : null },
      );
    };
    historyLoaded = true;
    pausedUntil = undefined;
    goalRuns = [];
    const aiOptions = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      gates: {
        historyLoaded: async () => historyLoaded,
        costCapPausedUntil: async () => pausedUntil,
      },
      notices: { raise: async () => undefined, end: async () => undefined },
    };
    await markSetupStep(test.database, "master key", "done");
    const saved = await aiSettings(aiOptions).save(
      {
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: { input: 1, output: 1 }, writer: { input: 1, output: 1 } },
      },
      { freshCode: true },
    );
    expect(saved).toMatchObject({ saved: true });
    callsBefore = stub.calls.length;
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
      {
        goalWriting: goalWriting({
          database: test.database,
          ai: householdAi(aiOptions),
          requestGoalRun: async (goalId) => {
            goalRuns.push(goalId);
          },
        }),
      },
    );
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    test.close();
  });

  const calls = () => stub.calls.length - callsBefore;
  const words = "I want to spend 20% less on restaurants.";

  it("adds a Goal with its reading, and edits its words, as the page sends them", async () => {
    const res = await browser.send("POST", "/api/goals", { words, sendAnyway: false });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: GoalView };
    expect(goal).toMatchObject({
      words,
      author: "Alice",
      status: "active",
      reading: {
        target: { kind: "Category", category: "Restaurants" },
        change: { percent: 20 },
        deadline: null,
      },
      list: "active",
    });

    const edited = await browser.send("POST", `/api/goals/${goal.id}/words`, {
      words: "Be careful with money",
      sendAnyway: false,
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({
      goal: expect.objectContaining({
        id: goal.id,
        words: "Be careful with money",
        reading: { target: null, change: null, deadline: null },
      }),
    });
    expect(calls()).toBe(2);
    expect(goalRuns).toEqual([goal.id, goal.id]);
  });

  it('answers "Send anyway?" at the AI cost cap, and a failed reading with "Try again", storing nothing', async () => {
    pausedUntil = "2026-12-01";
    const capped = await browser.send("POST", "/api/goals", { words, sendAnyway: false });
    expect(capped.status).toBe(409);
    expect(await capped.json()).toEqual({
      error: "Reading this Goal is past the AI cost cap. Send anyway?",
      pause: "send anyway?",
    });
    expect(calls()).toBe(0);

    stub.answers.quick = "fail";
    const failed = await browser.send("POST", "/api/goals", { words, sendAnyway: true });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "The AI provider did not answer.",
      tryAgain: true,
    });
    stub.answers.quick = "rate limit";
    const busy = await browser.send("POST", "/api/goals", { words, sendAnyway: true });
    expect(busy.status).toBe(429);
    expect(calls()).toBe(2);
    expect(await listGoals(test.database)).toEqual([]);
    expect(goalRuns).toEqual([]);
  });

  it("refuses until history has loaded, and with no AI provider, and says so", async () => {
    historyLoaded = false;
    expect(await (await browser.get("/api/goals")).json()).toMatchObject({
      aiProvider: true,
      waitsForHistory: true,
    });
    const waiting = await browser.send("POST", "/api/goals", { words, sendAnyway: false });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({
      error: "Goals open when your history has loaded.",
      pause: "waits for history",
    });

    // An app with no AI adds no Goal.
    const noAi = createApp(
      webRoot,
      await loadSecurity(
        { APP_URL },
        { logger: createLogger(() => {}, { throwOnSecretField: true }) },
      ),
      test.auth,
      test.database,
      test.secrets,
    );
    const other = new TestBrowser(noAi, APP_URL, "192.168.1.22");
    await other.signIn(await addMember(test.auth, { name: "Bea", email: "bea@example.com" }));
    const refused = await other.send("POST", "/api/goals", { words, sendAnyway: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "Goals need an AI provider",
      pause: "no AI provider",
    });
    expect(calls()).toBe(0);
    expect(await listGoals(test.database)).toEqual([]);
  });

  it("edits only an active Goal, and answers 404 to an unknown one, with no call (K2)", async () => {
    const added = await browser.send("POST", "/api/goals", { words, sendAnyway: false });
    const { goal } = (await added.json()) as { goal: GoalView };
    await browser.send("POST", `/api/goals/${goal.id}/status`, { status: "dropped" });
    const before = await listGoals(test.database);

    const body = { words: "Spend less", sendAnyway: false };
    const dropped = await browser.send("POST", `/api/goals/${goal.id}/words`, body);
    expect(dropped.status).toBe(409);
    expect(await dropped.json()).toEqual({ error: "Only an active Goal's words can be edited." });
    expect((await browser.send("POST", "/api/goals/no-such-goal/words", body)).status).toBe(404);

    expect(calls()).toBe(1);
    expect(await listGoals(test.database)).toEqual(before);
  });

  it("answers 400 to words whose deadline has passed, and stores nothing", async () => {
    const res = await browser.send("POST", "/api/goals", {
      words: "Save by January 2001",
      sendAnyway: false,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The deadline in these words has passed. Write a date from today on.",
    });
    expect(await listGoals(test.database)).toEqual([]);
    expect(goalRuns).toEqual([]);
  });

  it("answers 400 to a body that is not a Goal's words, with no call", async () => {
    for (const body of [
      {},
      { words },
      { words, sendAnyway: "yes" },
      { words, sendAnyway: false, goalId: "x" },
      { words: "", sendAnyway: false },
      { words: "x".repeat(301), sendAnyway: false },
    ]) {
      const res = await browser.send("POST", "/api/goals", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls()).toBe(0);
    expect(await listGoals(test.database)).toEqual([]);
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, and changes nothing (K1)", async () => {
    const added = await browser.send("POST", "/api/goals", { words, sendAnyway: false });
    const { goal } = (await added.json()) as { goal: GoalView };
    const before = await listGoals(test.database);
    const callsNow = calls();
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const body = { words: "Spend less", sendAnyway: true };

    for (const path of ["/api/goals", `/api/goals/${goal.id}/words`]) {
      expect((await signedOut.send("POST", path, body)).status, path).toBe(401);
      for (const origin of ["http://evil.example", undefined]) {
        expect((await browser.send("POST", path, body, { origin })).status, path).toBe(403);
      }
      const plain = await browser.send("POST", path, body, { "content-type": "text/plain" });
      expect(plain.status, path).toBe(415);
    }

    expect(calls()).toBe(callsNow);
    expect(await listGoals(test.database)).toEqual(before);
    expect(goalRuns).toEqual([goal.id]);
  });
});
