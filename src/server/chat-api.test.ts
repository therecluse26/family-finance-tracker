import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chat as BrowserChat } from "@ai-sdk/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi, typedCount } from "../ai/index.ts";
import { newAiKey, StubModels } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { chat } from "../chat/index.ts";
import { markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { deleteThread, loadChat, loadThread, startThread } from "../web/chat.ts";
import { createApp } from "./app.ts";
import type { ChatThreadView } from "./chat-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Chat through the app's HTTP interface (spec 08, Chat; spec 07, Chat page): the thread list, a
// thread, a new thread, an answer streamed from POST /api/chat, and delete. On AI SDK test models:
// no route calls an AI provider.

const APP_URL = "http://nas.local:8080";
const PRICE = { input: 1_000_000, output: 2_000_000 };
const QUIET = createLogger(() => {}, { throwOnSecretField: true });

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-chat-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// A stream's text, as @ai-sdk/react reads it.
async function streamedText(res: Response): Promise<string> {
  return (await res.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; delta?: string })
    .map((part) => (part.type === "text-delta" ? part.delta : ""))
    .join("");
}

describe("the Chat routes", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubModels;
  let alice: TestBrowser;
  let bob: TestBrowser;
  let loaded: boolean;
  let capped: boolean;

  beforeEach(async () => {
    test = await newTestAuth(APP_URL, QUIET);
    stub = new StubModels();
    loaded = true;
    capped = false;
    const gates: AiGates = {
      historyLoaded: async () => loaded,
      costCapPausedUntil: async () => (capped ? "2099-01-01" : undefined),
    };
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: test.database }),
      gates,
      logger: QUIET,
      notices: { raise: async () => {}, end: async () => {} },
    };
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
    );
    const ai = householdAi(options);
    const talk = chat({
      database: test.database,
      ai,
      summary: {
        today: async () => ({ parts: ["Household summary: ", typedCount(2), " Members."] }),
      },
    });
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: QUIET }),
      test.auth,
      test.database,
      test.secrets,
      { chat: talk },
    );
    const aliceMember = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    const bobMember = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    alice = new TestBrowser(app, APP_URL, "192.168.1.20");
    await alice.signIn(aliceMember);
    bob = new TestBrowser(app, APP_URL, "192.168.1.21");
    await bob.signIn(bobMember);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    test.close();
  });

  // Every table but the sessions, which each request renews.
  const everyTable = async () => {
    const { sessions: _renewed, ...tables } = await readEveryTable(test.database);
    return tables;
  };

  // The model calls, after the two checks on save.
  const modelCalls = () => stub.calls.slice(2);

  const newThread = async (text = "How are we doing?", browser = alice) => {
    const res = await browser.post("/api/chat/threads", { text, note: null, sendAnyway: false });
    expect(res.status).toBe(201);
    return ((await res.json()) as { threadId: string }).threadId;
  };

  // What useChat sends for an answer.
  const answerBody = (id: string, text: string | null) => ({
    id,
    trigger: text === null ? "regenerate-message" : "submit-message",
    messages: text === null ? [] : [{ id: "m-1", role: "user", parts: [{ type: "text", text }] }],
    sendAnyway: false,
  });

  const threadOf = async (id: string, browser = alice) => {
    const res = await browser.get(`/api/chat/threads/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ChatThreadView;
  };

  it("streams an answer, and every Member sees every thread with who wrote each message", async () => {
    stub.reply = "Member A asked a good one.";
    const id = await newThread();
    expect(modelCalls()).toEqual([]);

    const res = await alice.post("/api/chat", answerBody(id, null));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamedText(res)).toBe("Alice asked a good one.");

    const more = await bob.post("/api/chat", answerBody(id, "And Bob?"));
    expect(await streamedText(more)).toBe("Alice asked a good one.");

    const thread = await threadOf(id, bob);
    expect(thread.messages.map(({ author, name, text }) => [author, name, text])).toEqual([
      ["Member", "Alice", "How are we doing?"],
      ["AI", "AI", "Alice asked a good one."],
      ["Member", "Bob", "And Bob?"],
      ["AI", "AI", "Alice asked a good one."],
    ]);
    // The page names the signed-in Member above a question while it is answered.
    expect([thread.you, (await threadOf(id, alice)).you]).toEqual(["Bob", "Alice"]);
    const list = await (await bob.get("/api/chat")).json();
    expect(list).toEqual({
      status: "ready",
      threads: [{ id, title: "How are we doing?", lastMessageAt: expect.any(String) }],
    });
    expect(modelCalls()).toHaveLength(2);
  });

  it("refuses each write without a session, from another site or no Origin, and with another content type, changing nothing", async () => {
    const id = await newThread();
    const before = await everyTable();
    const writes: [string, string, unknown][] = [
      ["POST", "/api/chat/threads", { text: "Hi", note: null, sendAnyway: false }],
      ["POST", "/api/chat", answerBody(id, "Hi")],
      ["DELETE", `/api/chat/threads/${id}`, undefined],
    ];
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.30");

    for (const [method, path, body] of writes) {
      expect([method, path, (await stranger.send(method, path, body)).status]).toEqual([
        method,
        path,
        401,
      ]);
      for (const origin of WRONG_ORIGINS) {
        expect([path, origin, (await alice.send(method, path, body, { origin })).status]).toEqual([
          path,
          origin,
          403,
        ]);
      }
    }
    for (const [method, path, body] of writes.slice(0, 2)) {
      const res = await alice.send(method, path, body, { "content-type": "text/plain" });
      expect([path, res.status]).toEqual([path, 415]);
    }
    expect(await stranger.get("/api/chat").then((res) => res.status)).toBe(401);
    expect(await stranger.get(`/api/chat/threads/${id}`).then((res) => res.status)).toBe(401);

    expect(await everyTable()).toEqual(before);
    expect(modelCalls()).toEqual([]);
  });

  it("changes nothing for a wrong thread ID, a wrong note ID, or a bad body", async () => {
    const id = await newThread();
    const before = await everyTable();

    expect((await alice.post("/api/chat", answerBody("no-such-thread", "Hi"))).status).toBe(404);
    expect((await alice.send("DELETE", "/api/chat/threads/no-such-thread")).status).toBe(404);
    expect((await alice.get("/api/chat/threads/no-such-thread")).status).toBe(404);
    const noted = await alice.post("/api/chat/threads", {
      text: "Tell me more",
      note: { kind: "Proposal", id: "no-such-proposal" },
      sendAnyway: false,
    });
    expect([noted.status, await noted.json()]).toEqual([
      404,
      { error: "This note is no longer in the AI box." },
    ]);
    for (const body of [
      { text: "Hi", note: null, sendAnyway: false, title: "Mine" },
      { text: "Hi", note: { kind: "Alert note", id: "x", lines: ["Made up"] }, sendAnyway: false },
      { text: "   ", note: null, sendAnyway: false },
      { text: "x".repeat(4_001), note: null, sendAnyway: false },
    ]) {
      expect((await alice.post("/api/chat/threads", body)).status).toBe(400);
    }
    expect((await alice.post("/api/chat", { ...answerBody(id, "Hi"), trigger: "x" })).status).toBe(
      400,
    );
    // A new message with no words is refused.
    expect((await alice.post("/api/chat", answerBody(id, " "))).status).toBe(400);

    expect(await everyTable()).toEqual(before);
    expect(modelCalls()).toEqual([]);
  });

  it("deletes a thread with its messages for any Member", async () => {
    const id = await newThread("Mine", alice);
    const kept = await newThread("Another", alice);
    expect(await (await bob.send("DELETE", `/api/chat/threads/${id}`)).json()).toEqual({
      deleted: true,
    });
    expect((await alice.get(`/api/chat/threads/${id}`)).status).toBe(404);
    const tables = await readEveryTable(test.database);
    expect(tables.chat_threads?.map((row) => (row as { id: string }).id)).toEqual([kept]);
    expect(tables.chat_messages).toHaveLength(1);
  });

  it('asks "Send anyway?" at the AI cost cap and stores nothing, and waits for history', async () => {
    const id = await newThread();
    capped = true;
    const before = await everyTable();

    expect(await (await alice.get("/api/chat")).json()).toMatchObject({ status: "send anyway?" });
    const refused = await alice.post("/api/chat", answerBody(id, "And?"));
    expect([refused.status, await refused.json()]).toEqual([
      409,
      { error: "Send anyway?", pause: "send anyway?" },
    ]);
    const start = await alice.post("/api/chat/threads", {
      text: "Hi",
      note: null,
      sendAnyway: false,
    });
    expect(start.status).toBe(409);
    expect(await everyTable()).toEqual(before);
    expect(modelCalls()).toEqual([]);

    const yes = await alice.post("/api/chat", { ...answerBody(id, null), sendAnyway: true });
    expect(await streamedText(yes)).toBe("O");

    capped = false;
    loaded = false;
    expect(await (await alice.get("/api/chat")).json()).toMatchObject({
      status: "waits for history",
    });
    const waits = await alice.post("/api/chat/threads", {
      text: "Hi",
      note: null,
      sendAnyway: true,
    });
    expect([waits.status, await waits.json()]).toEqual([
      409,
      { error: "Chat opens when your history has loaded.", pause: "waits for history" },
    ]);
  });

  it("acts through the page's own requests, and useChat's", async () => {
    const sent: { method: string; path: string; type: string | undefined; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const type = new Headers(init?.headers).get("content-type") ?? undefined;
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, type, body });
      return alice.send(method, `${url.pathname}${url.search}`, body, { "content-type": type });
    });

    expect(await loadChat()).toEqual({ status: "ready", threads: [] });
    // Send on a new thread: the thread first, then its first answer, as the page asks for it.
    const started = await startThread("What did we spend?", null, false);
    if (!("threadId" in started)) throw new Error(started.error);
    const browserChat = new BrowserChat({ id: started.threadId });
    browserChat.messages = [
      { id: "q", role: "user", parts: [{ type: "text", text: "What did we spend?" }] },
    ];
    await browserChat.regenerate({ body: { sendAnyway: false } });
    expect(browserChat.status).toBe("ready");
    expect(browserChat.messages.at(-1)?.parts).toContainEqual({
      type: "text",
      text: "O",
      state: "done",
    });

    // A message in the open thread.
    browserChat.messages = [];
    await browserChat.sendMessage({ text: "And last month?" }, { body: { sendAnyway: false } });
    expect(browserChat.error).toBeUndefined();
    const thread = await loadThread(started.threadId);
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "What did we spend?",
      "O",
      "And last month?",
      "O",
    ]);
    expect(await loadThread("no-such-thread")).toBeUndefined();

    // A refusal comes back as useChat's error, with the route's words.
    capped = true;
    await browserChat.sendMessage({ text: "More?" }, { body: { sendAnyway: false } });
    expect(JSON.parse(browserChat.error?.message ?? "")).toEqual({
      error: "Send anyway?",
      pause: "send anyway?",
    });
    capped = false;

    expect(await deleteThread(started.threadId)).toBeUndefined();
    expect(await deleteThread(started.threadId)).toBe("No Chat thread has this ID.");

    const json = "application/json";
    const writes = sent.filter((request) => request.method !== "GET");
    expect(writes.map(({ method, path, type }) => [method, path, type])).toEqual([
      ["POST", "/api/chat/threads", json],
      ["POST", "/api/chat", json],
      ["POST", "/api/chat", json],
      ["POST", "/api/chat", json],
      ["DELETE", `/api/chat/threads/${started.threadId}`, undefined],
      ["DELETE", `/api/chat/threads/${started.threadId}`, undefined],
    ]);
    expect(writes[0]?.body).toEqual({ text: "What did we spend?", note: null, sendAnyway: false });
    expect(writes[1]?.body).toMatchObject({
      id: started.threadId,
      trigger: "regenerate-message",
      sendAnyway: false,
    });
    expect(writes[2]?.body).toMatchObject({
      id: started.threadId,
      trigger: "submit-message",
      sendAnyway: false,
      messages: [{ role: "user", parts: [{ type: "text", text: "And last month?" }] }],
    });
  });
});
