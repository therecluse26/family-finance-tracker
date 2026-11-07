import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiOptions,
  aiActivity,
  aiActivityWatchers,
  aiCost,
  aiSettings,
  householdAi,
  startAiActivity,
} from "../ai/index.ts";
import { newAiKey, StubModels } from "../ai/testing.ts";
import { SESSION_SECONDS, sessionEndWatchers } from "../auth/index.ts";
import { tellSessionsEnded } from "../auth/session-ends.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { claimHistoryWaitEnd, markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import {
  type AiActivityView,
  type AiWorkKind,
  aiWork,
  REDO_ATTEMPTS,
  registerRedoStep,
  runRedoJob,
  startRedo,
} from "../redo/index.ts";
import { HEARTBEAT_MS, MAX_STREAMS_PER_SESSION, openAiActivityStreams } from "./ai-activity.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { startServer } from "./server.ts";
import { type App, TestBrowser } from "./testing.ts";

// The live AI status's feed, GET /api/ai/activity/stream (spec 08, Live AI status), through the
// app's HTTP interface, on the real redo module and AI SDK test models with a made-up key. A press
// starts its run's job: here `works` records it, and the test runs the job. No test calls an AI
// provider.

const APP_URL = "http://nas.local:8080";
const STREAM = "/api/ai/activity/stream";
const PRICE = { input: 1_000_000, output: 2_000_000 };
const IDLE: AiActivityView = { run: null, uses: [] };
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

// The events of one open stream, as a browser's EventSource reads them: each data event as its
// view, and each comment line.
class EventReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  readonly comments: string[] = [];

  constructor(res: Response) {
    if (res.body === null) throw new Error("The stream has no body.");
    this.reader = res.body.getReader();
  }

  // The next block, or undefined once the stream ends.
  private async block(): Promise<string | undefined> {
    for (;;) {
      const cut = this.buffer.indexOf("\n\n");
      if (cut >= 0) {
        const block = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut + 2);
        return block;
      }
      const { done, value } = await this.reader.read();
      if (done) return undefined;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  // The next data event's view, or undefined once the stream ends. Comment lines are kept.
  async next(): Promise<AiActivityView | undefined> {
    for (;;) {
      const block = await this.block();
      if (block === undefined) return undefined;
      if (block.startsWith(":")) {
        this.comments.push(block);
        continue;
      }
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("\n");
      return JSON.parse(data) as AiActivityView;
    }
  }

  // The browser leaves.
  async leave(): Promise<void> {
    await this.reader.cancel();
  }
}

const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Lets the stream's own steps run, such as its end after the browser leaves.
const settle = () => new Promise((done) => setTimeout(done, 20));

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-ai-activity-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the live AI status's feed", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubModels;
  let options: AiOptions;
  let alice: TestMember;
  let bob: TestMember;
  let works: AiWorkKind[];
  let stopRedo: () => void;
  let readers: EventReader[];
  let clients = 0;

  beforeEach(async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    stub = new StubModels();
    works = [];
    readers = [];
    options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      gates: { historyLoaded: async () => true, costCapPausedUntil: async () => undefined },
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
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const reader of readers) await reader.leave().catch(() => {});
    await settle();
    stopRedo();
    test.close();
  });

  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
    await claimHistoryWaitEnd(test.database, new Date("2026-11-06T14:00:00.000Z"));
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

  async function signedIn(member: TestMember = alice): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    return tab;
  }

  // A browser's EventSource sends no Origin for its own page's stream.
  async function open(tab: TestBrowser): Promise<EventReader> {
    const res = await tab.send("GET", STREAM, undefined, { origin: undefined });
    expect(res.status).toBe(200);
    const reader = new EventReader(res);
    readers.push(reader);
    return reader;
  }

  it("answers 401 to a browser with no session, and opens nothing", async () => {
    const tab = new TestBrowser(app, APP_URL, "192.168.1.200");

    const res = await tab.send("GET", STREAM, undefined, { origin: undefined });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(aiActivityWatchers()).toBe(0);
    expect(openAiActivityStreams()).toBe(0);
  });

  it("answers 403 to another site's Origin and to a request the browser marks as from another site, and takes no place", async () => {
    const tab = await signedIn();
    const refused = [
      { origin: "http://evil.example" },
      { origin: `${APP_URL}.evil.example` },
      { origin: "http://nas.local:8081" },
      { origin: undefined, "sec-fetch-site": "cross-site" },
      { origin: undefined, "sec-fetch-site": "same-site" },
    ];
    for (const headers of refused) {
      for (let n = 0; n <= MAX_STREAMS_PER_SESSION; n += 1) {
        const res = await tab.send("GET", STREAM, undefined, headers);
        expect(res.status).toBe(403);
      }
    }
    expect(aiActivityWatchers()).toBe(0);
    expect(openAiActivityStreams()).toBe(0);

    // The app's own Origin, and a same-origin request, pass, and none of the refusals took a place.
    await open(tab);
    const own = await tab.send("GET", STREAM, undefined, { "sec-fetch-site": "same-origin" });
    expect(own.status).toBe(200);
    readers.push(new EventReader(own));
    expect(openAiActivityStreams()).toBe(2);
  });

  it("sends the work as it is now at once, as server-sent events, and makes no AI call", async () => {
    await finishWizard();
    await connectAi();
    const calls = stub.calls.length;
    const tab = await signedIn();
    const working = startAiActivity("monthly review");

    const res = await tab.send("GET", STREAM, undefined, { origin: undefined });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = new EventReader(res);
    readers.push(reader);

    expect(await reader.next()).toEqual({
      run: null,
      uses: [{ use: "monthly review", calls: 1 }],
    });
    working();
    expect(await reader.next()).toEqual(IDLE);
    expect(stub.calls).toHaveLength(calls);
  });

  it("follows a press of Finish AI work now through its steps to its end, with no Transaction detail", async () => {
    await finishWizard();
    await connectAi();
    const tab = await signedIn();
    const reader = await open(tab);
    expect(await reader.next()).toEqual(IDLE);
    let stepCalls = 0;
    const unregister = registerRedoStep("Categories", async () => {
      stepCalls += 1;
      return [];
    });
    // Each change, as the record tells it.
    const told: AiActivityView[] = [];
    const stopWatching = aiActivity.watch(
      (view) => told.push(view),
      () => {},
    );

    try {
      expect((await tab.post("/api/ai/work/finish")).status).toBe(202);
      expect(await reader.next()).toEqual({ run: { kind: "finish", step: "starting" }, uses: [] });

      // The first AI run's one AI call here: its Insight card run.
      stub.replyTo = () => INSIGHT_CARDS;
      await runRedoJob(works[0]);
    } finally {
      unregister();
      stopWatching();
    }

    expect(stepCalls).toBe(1);
    // The press waits as "starting" from its press until its job's run starts, and again from the
    // run's end until its job ends the press, as the status line of Settings, AI says.
    const starting = { run: { kind: "finish", step: "starting" }, uses: [] };
    expect(told).toEqual([
      starting,
      { run: { kind: "finish", step: "Categories" }, uses: [] },
      { run: { kind: "finish", step: "Insight cards" }, uses: [] },
      {
        run: { kind: "finish", step: "Insight cards" },
        uses: [{ use: "insight cards", calls: 1 }],
      },
      { run: { kind: "finish", step: "Insight cards" }, uses: [] },
      starting,
      IDLE,
    ]);
    // The stream sends the newest view once the one before has gone, so a browser that reads
    // slowly may skip a view, in order, and always gets the last.
    const streamed: AiActivityView[] = [];
    for (;;) {
      const view = await reader.next();
      if (view === undefined) break;
      streamed.push(view);
      if (view.run === null && view.uses.length === 0) break;
    }
    let from = 1;
    for (const view of streamed) {
      const at = told.findIndex((each, index) => index >= from && isEqual(each, view));
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
    expect(streamed.at(-1)).toEqual(IDLE);
    // Only names and counts.
    const text = JSON.stringify([told, streamed]);
    expect(text).not.toMatch(/Card 1|Topic|Alice|\$/u);
  });

  it("shows a redo the app starts only once it is due with AI on, and clears it after a step that throws", async () => {
    const tab = await signedIn();
    const reader = await open(tab);
    expect(await reader.next()).toEqual(IDLE);

    // Not due: the history has not loaded, so the redo shows nothing.
    await runRedoJob();
    expect(aiActivity.now()).toEqual(IDLE);

    await finishWizard();
    await connectAi();
    const unregister = registerRedoStep("Money movement", async () => {
      throw new Error("The step failed.");
    });
    try {
      await expect(runRedoJob()).rejects.toThrow("The step failed.");
    } finally {
      unregister();
    }
    expect(await reader.next()).toEqual({ run: { kind: null, step: "starting" }, uses: [] });
    expect(await reader.next()).toEqual({ run: { kind: null, step: "Money movement" }, uses: [] });
    expect(await reader.next()).toEqual(IDLE);
    expect(aiActivity.now()).toEqual(IDLE);
  });

  it("keeps a press shown between its job's attempts, and clears it after the last one", async () => {
    await finishWizard();
    await connectAi();
    const tab = await signedIn();
    const unregister = registerRedoStep("Merchant names", async () => {
      throw new Error("The step failed.");
    });
    try {
      expect((await tab.post("/api/ai/work/finish")).status).toBe(202);
      for (let attempt = 1; attempt < REDO_ATTEMPTS; attempt += 1) {
        await expect(runRedoJob("finish")).rejects.toThrow("The step failed.");
        expect(aiActivity.now().run).toEqual({ kind: "finish", step: "starting" });
      }
      // The last attempt ends the run with its System notice, and does not throw.
      await runRedoJob("finish");
    } finally {
      unregister();
    }
    expect(aiActivity.now()).toEqual(IDLE);
  });

  it("gives a refused press's place back on the feed", async () => {
    await finishWizard();
    const tab = await signedIn();
    const reader = await open(tab);
    expect(await reader.next()).toEqual(IDLE);

    // No AI provider: the press is refused.
    expect((await tab.post("/api/ai/work/finish")).status).toBe(409);
    expect(await reader.next()).toEqual({ run: { kind: "finish", step: "starting" }, uses: [] });
    expect(await reader.next()).toEqual(IDLE);
  });

  it("sends a comment line every 25 seconds while nothing changes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const tab = await signedIn();
    const reader = await open(tab);
    expect(await reader.next()).toEqual(IDLE);

    // Each comment line goes once a check finds the session still open.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await settle();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await settle();
    const end = startAiActivity("budget tailoring");
    expect(await reader.next()).toEqual({
      run: null,
      uses: [{ use: "budget tailoring", calls: 1 }],
    });
    end();

    expect(reader.comments).toEqual([": still here", ": still here"]);
  });

  it("leaves no watcher and no place once each browser leaves", async () => {
    const tab = await signedIn();
    for (let round = 0; round < 10; round += 1) {
      const open4 = await Promise.all(
        Array.from({ length: MAX_STREAMS_PER_SESSION }, () => open(tab)),
      );
      for (const reader of open4) expect(await reader.next()).toEqual(IDLE);
      expect(aiActivityWatchers()).toBe(MAX_STREAMS_PER_SESSION);
      for (const reader of open4) await reader.leave();
      await settle();
      expect(aiActivityWatchers()).toBe(0);
      expect(openAiActivityStreams()).toBe(0);
    }
    readers = [];
  });

  it("refuses a 5th feed for a session with 429, also when feeds open together, and opens one again after one ends", async () => {
    const tab = await signedIn();
    const other = await signedIn(bob);

    const answers = await Promise.all(
      Array.from({ length: MAX_STREAMS_PER_SESSION + 3 }, () =>
        tab.send("GET", STREAM, undefined, { origin: undefined }),
      ),
    );
    const opened = answers.filter((res) => res.status === 200);
    for (const res of opened) readers.push(new EventReader(res));
    expect(answers.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 429, 429, 429]);
    const refused = answers.find((res) => res.status === 429);
    expect(await refused?.json()).toEqual({
      error: "Too many AI status streams are open. Close a tab, then try again.",
    });
    expect(aiActivityWatchers()).toBe(MAX_STREAMS_PER_SESSION);

    // Another session has its own places.
    await open(other);
    expect(openAiActivityStreams()).toBe(MAX_STREAMS_PER_SESSION + 1);

    // One tab leaves, and its place opens again.
    await readers[0]?.leave();
    await settle();
    await open(tab);
    expect((await tab.send("GET", STREAM, undefined, { origin: undefined })).status).toBe(429);
  });

  it("ends every open feed when the app stops", async () => {
    const tab = await signedIn();
    const reader = await open(tab);
    const second = await open(tab);
    expect(await reader.next()).toEqual(IDLE);
    expect(await second.next()).toEqual(IDLE);

    aiActivity.stop();

    expect(await reader.next()).toBeUndefined();
    expect(await second.next()).toBeUndefined();
    await settle();
    expect(aiActivityWatchers()).toBe(0);
    expect(openAiActivityStreams()).toBe(0);
  });

  it("answers 404 when the app runs no AI work", async () => {
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

    expect((await tab.send("GET", STREAM, undefined, { origin: undefined })).status).toBe(404);
    expect(openAiActivityStreams()).toBe(0);
  });

  it("does not hold up the server's close, and ends the stream of a browser that leaves the real server", async () => {
    const tab = await signedIn();
    const cookie = [...tab.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const server = await startServer({
      port: 0,
      webRoot,
      security: await loadSecurity(
        { APP_URL },
        { logger: createLogger(() => {}, { throwOnSecretField: true }) },
      ),
      auth: test.auth,
      database: test.database,
      secrets: test.secrets,
      ai: aiSettings(options),
      aiWork,
    });
    const openOnServer = () =>
      new Promise<{ res: IncomingMessage; first: string }>((resolve, reject) => {
        const sent = httpRequest(
          `http://127.0.0.1:${server.port}${STREAM}`,
          { headers: { host: new URL(APP_URL).host, cookie } },
          (res) => {
            res.setEncoding("utf8");
            res.once("data", (first: string) => resolve({ res, first }));
          },
        );
        sent.on("error", reject);
        sent.end();
      });

    // A browser that leaves the real server.
    const leaving = await openOnServer();
    expect(leaving.first).toBe(`data: ${JSON.stringify(IDLE)}\n\n`);
    leaving.res.destroy();
    await vi.waitFor(() => expect(aiActivityWatchers()).toBe(0));
    expect(openAiActivityStreams()).toBe(0);

    // A browser that stays while the app stops.
    const staying = await openOnServer();
    const ended = new Promise<void>((done) => staying.res.once("end", () => done()));
    const started = Date.now();
    await server.close();
    await ended;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aiActivityWatchers()).toBe(0);
    expect(openAiActivityStreams()).toBe(0);
  });
  describe("when its session ends", () => {
    // Each TOTP code works once, so each sign-in of the same Member takes its own 30-second step.
    async function signedInOnItsOwnStep(member: TestMember = alice): Promise<TestBrowser> {
      vi.setSystemTime(Date.now() + 30_000);
      return signedIn(member);
    }

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      await finishWizard();
    });

    // The stream ends with no further event, even for work that starts right after the session
    // ended, and gives back its watcher and place.
    async function endsWithNoMoreData(reader: EventReader, left: number): Promise<void> {
      const end = startAiActivity("alert advice");
      expect(await reader.next()).toBeUndefined();
      end();
      await settle();
      expect(aiActivityWatchers()).toBe(left);
      expect(openAiActivityStreams()).toBe(left);
      expect(sessionEndWatchers()).toBe(left);
    }

    it("ends the other devices' streams on Sign out everywhere else, and keeps this device's", async () => {
      const here = await signedInOnItsOwnStep();
      const there = await signedInOnItsOwnStep();
      const mine = await open(here);
      const theirs = await open(there);
      expect(await mine.next()).toEqual(IDLE);
      expect(await theirs.next()).toEqual(IDLE);

      expect((await here.post("/api/my-login/sign-out-other-devices", {})).status).toBe(200);

      await endsWithNoMoreData(theirs, 1);
      expect(await mine.next()).toEqual({ run: null, uses: [{ use: "alert advice", calls: 1 }] });
      expect((await there.get("/api/ai/work")).status).toBe(401);
    });

    it("ends that device's stream on its Sign out in Signed-in devices", async () => {
      const here = await signedInOnItsOwnStep();
      const there = await signedInOnItsOwnStep();
      const theirs = await open(there);
      expect(await theirs.next()).toEqual(IDLE);
      const { devices } = (await (await here.get("/api/my-login/devices")).json()) as {
        devices: { id: string; thisDevice: boolean }[];
      };
      const other = devices.find((device) => !device.thisDevice);

      expect((await here.post(`/api/my-login/devices/${other?.id}/sign-out`, {})).status).toBe(200);

      await endsWithNoMoreData(theirs, 0);
    });

    it("ends the stream on its own Sign out, and keeps another Member's", async () => {
      const tab = await signedIn();
      const other = await signedIn(bob);
      const mine = await open(tab);
      const bobs = await open(other);
      expect(await mine.next()).toEqual(IDLE);
      expect(await bobs.next()).toEqual(IDLE);

      expect((await tab.post("/api/auth/sign-out", {})).status).toBe(200);

      await endsWithNoMoreData(mine, 1);
      expect(await bobs.next()).toEqual({ run: null, uses: [{ use: "alert advice", calls: 1 }] });
    });

    it.each([
      ["a Login reset", "reset-login"],
      ["the Member's removal", "remove"],
    ])("ends the Member's streams at %s", async (_name, action) => {
      const tab = await signedIn();
      const other = await signedIn(bob);
      const bobs = await open(other);
      expect(await bobs.next()).toEqual(IDLE);

      expect((await tab.post(`/api/members/${bob.id}/${action}`, {})).status).toBe(200);

      await endsWithNoMoreData(bobs, 0);
    });

    it("holds work that starts during a session check, and sends it once the session is still open", async () => {
      const reader = await open(await signedIn());
      expect(await reader.next()).toEqual(IDLE);

      tellSessionsEnded();
      const end = startAiActivity("alert advice");

      expect(await reader.next()).toEqual({ run: null, uses: [{ use: "alert advice", calls: 1 }] });
      end();
      expect(await reader.next()).toEqual(IDLE);
    });

    it("checks once more when the session ends during a check, and ends the stream", async () => {
      const reader = await open(await signedIn());
      expect(await reader.next()).toEqual(IDLE);

      tellSessionsEnded();
      vi.setSystemTime(Date.now() + SESSION_SECONDS * 1000);
      tellSessionsEnded();

      await endsWithNoMoreData(reader, 0);
    });

    it("ends the stream at the first comment line after the session expires, and writes no comment line then", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: Date.now() });
      const tab = await signedIn();
      const reader = await open(tab);
      expect(await reader.next()).toEqual(IDLE);
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await settle();

      vi.setSystemTime(Date.now() + SESSION_SECONDS * 1000);
      vi.advanceTimersByTime(HEARTBEAT_MS);

      expect(await reader.next()).toBeUndefined();
      expect(reader.comments).toEqual([": still here"]);
      await settle();
      expect(aiActivityWatchers()).toBe(0);
      expect(openAiActivityStreams()).toBe(0);
      expect(sessionEndWatchers()).toBe(0);
    });
  });
});
