import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi, typedCount } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels, type StubToolCall } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { chat } from "../chat/index.ts";
import { markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import {
  MAX_EDIT_CHANGES,
  SHOPPING_LIST_RULES,
  type ShoppingListView,
} from "../deal-finder/index.ts";
import { createLogger } from "../log.ts";
import {
  addListItem,
  answerOf,
  changeListItem,
  clearTickedItems,
  loadShoppingList,
  removeListItem,
  saveDietaryNeeds,
  saveTripSaving,
  undoShoppingListChange,
} from "../web/shopping-list.ts";
import { createApp } from "./app.ts";
import type { ChatThreadView } from "./chat-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Shopping list through the app's HTTP interface (spec 15, Shopping list; Chat tools): the
// page's writes, Chat's edit_shopping_list on AI SDK test models with its card and Undo, and the
// session, Origin and content-type checks on every write. No route calls an AI provider. Every List
// item and Member is made up.

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
  webRoot = mkdtempSync(join(tmpdir(), "fft-shopping-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

const toolResults = (messages: StubMessage[] = []) =>
  messages.flatMap((message) =>
    message.role === "tool" && typeof message.content !== "string"
      ? message.content.map((part) => part.output)
      : [],
  );

const toolRounds = (messages: StubMessage[]) =>
  messages.filter((message) => message.role === "tool").length;

describe("the Shopping list routes", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubModels;
  let alice: TestBrowser;
  let bob: TestBrowser;

  beforeEach(async () => {
    test = await newTestAuth(APP_URL, QUIET);
    stub = new StubModels();
    const gates: AiGates = {
      historyLoaded: async () => true,
      costCapPausedUntil: async () => undefined,
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
    await aiSettings(options).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    const talk = chat({
      database: test.database,
      ai: householdAi(options),
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

  const listOf = async (browser = alice): Promise<ShoppingListView> => {
    const res = await browser.get("/api/shopping-list");
    expect(res.status).toBe(200);
    return ((await res.json()) as { shoppingList: ShoppingListView }).shoppingList;
  };

  const add = async (words: string, browser = alice) => {
    const res = await browser.post("/api/shopping-list/items", {
      words,
      quantity: 1,
      unit: "each",
    });
    expect(res.status).toBe(200);
    const view = ((await res.json()) as { shoppingList: ShoppingListView }).shoppingList;
    return view.items.at(-1)?.id ?? "";
  };

  // A thread with one question, and its answer from test models that call these tools, one round
  // each, then answer "O".
  async function answeredWith(rounds: StubToolCall[][]): Promise<ChatThreadView> {
    const started = await alice.post("/api/chat/threads", {
      text: "Add avocados to the list",
      note: null,
      sendAnyway: false,
    });
    const { threadId } = (await started.json()) as { threadId: string };
    stub.callTools = (messages) => rounds[toolRounds(messages)] ?? [];
    const res = await alice.post("/api/chat", {
      id: threadId,
      trigger: "regenerate-message",
      messages: [],
      sendAnyway: false,
    });
    expect(res.status).toBe(200);
    await res.text();
    const thread = await alice.get(`/api/chat/threads/${threadId}`);
    return (await thread.json()) as ChatThreadView;
  }

  it("adds, edits, ticks, removes and clears List items, and saves the dietary needs and the trip setting, for every Member", async () => {
    expect(await listOf()).toEqual({
      items: [],
      dietaryNeeds: "",
      tripSaving: 1000,
      maxItems: 100,
    });
    const beef = await add("ground beef");
    const eggs = await add("eggs", bob);

    expect(
      (await alice.send("PUT", `/api/shopping-list/items/${eggs}`, { quantity: 12, unit: "ct" }))
        .status,
    ).toBe(200);
    expect(
      (await bob.send("PUT", `/api/shopping-list/items/${beef}`, { ticked: true })).status,
    ).toBe(200);
    expect(
      (await bob.send("PUT", "/api/shopping-list/dietary-needs", { dietaryNeeds: "no peanuts" }))
        .status,
    ).toBe(200);
    expect(
      (await alice.send("PUT", "/api/shopping-list/trip-setting", { tripSaving: 500 })).status,
    ).toBe(200);
    expect(await listOf(bob)).toEqual({
      items: [
        expect.objectContaining({ id: beef, words: "ground beef", ticked: true }),
        expect.objectContaining({ id: eggs, quantity: 12, unit: "ct", ticked: false }),
      ],
      dietaryNeeds: "no peanuts",
      tripSaving: 500,
      maxItems: 100,
    });

    expect((await alice.post("/api/shopping-list/clear-ticked", {})).status).toBe(200);
    expect((await listOf()).items.map((item) => item.id)).toEqual([eggs]);
    expect((await alice.send("DELETE", `/api/shopping-list/items/${eggs}`)).status).toBe(200);
    expect((await listOf()).items).toEqual([]);
  });

  it("names the broken rule, answers 404 to a wrong ID and 400 to a bad body, and changes nothing", async () => {
    const beef = await add("ground beef");
    const before = await everyTable();
    const refusals: [string, string, unknown, number, string?][] = [
      [
        "POST",
        "/api/shopping-list/items",
        { words: "", quantity: 1, unit: "each" },
        400,
        SHOPPING_LIST_RULES.words,
      ],
      [
        "POST",
        "/api/shopping-list/items",
        { words: "eggs", quantity: 0, unit: "each" },
        400,
        SHOPPING_LIST_RULES.quantity,
      ],
      ["POST", "/api/shopping-list/items", { words: "eggs", quantity: 1, unit: "kg" }, 400],
      ["POST", "/api/shopping-list/items", { words: "eggs", quantity: 1, unit: "each", x: 1 }, 400],
      ["PUT", `/api/shopping-list/items/${beef}`, { note: "n".repeat(201) }, 400],
      ["PUT", `/api/shopping-list/items/${beef}`, {}, 400, SHOPPING_LIST_RULES.nothing],
      ["PUT", "/api/shopping-list/items/no-such-item", { ticked: true }, 404],
      ["PUT", "/api/shopping-list/items/bad%20id", { ticked: true }, 404],
      ["DELETE", "/api/shopping-list/items/no-such-item", undefined, 404],
      ["POST", "/api/shopping-list/clear-ticked", { all: true }, 400],
      ["PUT", "/api/shopping-list/trip-setting", { tripSaving: -1 }, 400],
      ["PUT", "/api/shopping-list/trip-setting", { tripSaving: "10" }, 400],
      ["PUT", "/api/shopping-list/dietary-needs", { dietaryNeeds: "d".repeat(301) }, 400],
      ["POST", "/api/shopping-list/changes/no-such-change/undo", {}, 404],
    ];
    for (const [method, path, body, status, error] of refusals) {
      const res = await alice.send(method, path, body);
      const answer = (await res.json()) as { error?: string };
      expect([method, path, res.status]).toEqual([method, path, status]);
      if (error !== undefined) expect(answer.error).toBe(error);
    }
    expect(await everyTable()).toEqual(before);
  });

  it("refuses a 101st List item with 409, and adds sent together stop at 100", async () => {
    const adds = await Promise.all(
      Array.from({ length: 103 }, (_, n) =>
        alice.post("/api/shopping-list/items", { words: `item ${n}`, quantity: 1, unit: "each" }),
      ),
    );
    expect(adds.filter((res) => res.status === 200)).toHaveLength(100);
    const refused = adds.filter((res) => res.status === 409);
    expect(refused).toHaveLength(3);
    expect(await refused[0]?.json()).toEqual({ error: SHOPPING_LIST_RULES.full });
    expect((await listOf()).items).toHaveLength(100);
  });

  it("refuses each write without a session, from another site or no Origin, and with another content type, changing nothing", async () => {
    const beef = await add("ground beef");
    const thread = await answeredWith([
      [{ toolName: "edit_shopping_list", input: { changes: [change({ id: beef, quantity: 3 })] } }],
    ]);
    const changeId = thread.shoppingListChanges[0]?.id ?? "";
    expect(changeId).not.toBe("");
    const before = await everyTable();
    const writes: [string, string, unknown][] = [
      ["POST", "/api/shopping-list/items", { words: "eggs", quantity: 1, unit: "each" }],
      ["PUT", `/api/shopping-list/items/${beef}`, { ticked: true }],
      ["DELETE", `/api/shopping-list/items/${beef}`, undefined],
      ["POST", "/api/shopping-list/clear-ticked", {}],
      ["PUT", "/api/shopping-list/dietary-needs", { dietaryNeeds: "vegan" }],
      ["PUT", "/api/shopping-list/trip-setting", { tripSaving: 0 }],
      ["POST", `/api/shopping-list/changes/${changeId}/undo`, {}],
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
      if (body !== undefined) {
        const res = await alice.send(method, path, body, { "content-type": "text/plain" });
        expect([method, path, res.status]).toEqual([method, path, 415]);
      }
    }
    expect((await stranger.get("/api/shopping-list")).status).toBe(401);
    expect(await everyTable()).toEqual(before);
  });

  describe("in Chat", () => {
    it("reads the list and applies an edit at once, shows its card under the answer, and Undo by any Member puts back the exact list", async () => {
      const beef = await add("ground beef");
      const milk = await add("milk");
      await alice.send("PUT", "/api/shopping-list/dietary-needs", { dietaryNeeds: "no peanuts" });
      const before = await listOf();

      const thread = await answeredWith([
        [{ toolName: "get_shopping_list", input: {} }],
        [
          {
            toolName: "edit_shopping_list",
            input: {
              changes: [
                change({ action: "add", words: "avocados", quantity: 3, unit: "each" }),
                change({ id: beef, quantity: 2, unit: "lb" }),
                change({ action: "remove", id: milk }),
              ],
            },
          },
        ],
        [{ toolName: "get_shopping_plan", input: {} }],
      ]);

      const results = toolResults(stub.prompts.at(-1));
      expect(results[0]).toEqual({
        type: "json",
        value: {
          listItems: before.items.map((item) => ({ ...item })),
          dietaryNeeds: "no peanuts",
        },
      });
      const [card] = thread.shoppingListChanges;
      expect(results.slice(1)).toEqual([
        { type: "json", value: { result: "done", card: card?.id } },
        {
          type: "json",
          value: {
            plan: null,
            note: "No Shopping plan yet. A Member presses Find the best prices.",
          },
        },
      ]);
      expect(card).toEqual({
        id: expect.any(String),
        answerId: thread.messages.at(-1)?.id,
        lines: ["Added 3 avocados", "Changed 1 ground beef to 2 lb ground beef", "Removed 1 milk"],
        undoneAt: null,
      });
      expect((await listOf()).items.map((item) => item.words)).toEqual(["ground beef", "avocados"]);

      const undone = await bob.post(`/api/shopping-list/changes/${card?.id}/undo`, {});
      expect(undone.status).toBe(200);
      expect(await listOf()).toEqual(before);
      const again = await alice.post(`/api/shopping-list/changes/${card?.id}/undo`, {});
      expect([again.status, await again.json()]).toEqual([
        409,
        { error: "This change is undone already." },
      ]);
      const shown = (await (
        await alice.get(`/api/chat/threads/${thread.id}`)
      ).json()) as ChatThreadView;
      expect(shown.shoppingListChanges).toEqual([
        { ...card, undoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ]);
    });

    it("answers an error that names the broken rule, and changes nothing", async () => {
      const beef = await add("ground beef");
      const before = await everyTable();
      const adds = (count: number) =>
        Array.from({ length: count }, () =>
          change({ action: "add", words: "eggs", quantity: 1, unit: "each" }),
        );

      const thread = await answeredWith([
        [{ toolName: "edit_shopping_list", input: { changes: adds(MAX_EDIT_CHANGES + 1) } }],
        [
          {
            toolName: "edit_shopping_list",
            input: { changes: [change({ id: null, quantity: 3 })] },
          },
        ],
        [
          {
            toolName: "edit_shopping_list",
            input: { changes: [change({ action: "add", words: "eggs", unit: "each" })] },
          },
        ],
        [
          {
            toolName: "edit_shopping_list",
            input: { changes: [...adds(2), change({ id: beef, quantity: -2 })] },
          },
        ],
      ]);

      expect(toolResults(stub.prompts.at(-1))).toEqual(
        [
          SHOPPING_LIST_RULES.changes,
          SHOPPING_LIST_RULES.id,
          SHOPPING_LIST_RULES.add,
          SHOPPING_LIST_RULES.quantity,
        ].map((error) => ({ type: "json", value: { error } })),
      );
      expect(thread.shoppingListChanges).toEqual([]);
      const after = await everyTable();
      for (const table of ["shopping_list_items", "shopping_list_changes", "product_matches"]) {
        expect([table, after[table]]).toEqual([table, before[table]]);
      }
      expect(after.shopping_list_changes).toEqual([]);
    });

    it("refuses an Undo after a Member changed a List item it touched, and changes nothing", async () => {
      const beef = await add("ground beef");
      const thread = await answeredWith([
        [
          {
            toolName: "edit_shopping_list",
            input: { changes: [change({ id: beef, quantity: 4 })] },
          },
        ],
      ]);
      await bob.send("PUT", `/api/shopping-list/items/${beef}`, { ticked: true });
      const before = await everyTable();

      const res = await alice.post(
        `/api/shopping-list/changes/${thread.shoppingListChanges[0]?.id}/undo`,
        {},
      );

      expect(res.status).toBe(409);
      expect(await everyTable()).toEqual(before);
    });
  });

  it("acts through the page's own requests", async () => {
    const sent: { method: string; path: string; type: string | undefined }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const type = new Headers(init?.headers).get("content-type") ?? undefined;
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, type });
      return alice.send(method, url.pathname, body, { "content-type": type });
    });

    const added = await answerOf(
      await addListItem({ words: "ground beef", quantity: 2, unit: "lb", brandLock: "", note: "" }),
    );
    if (!("view" in added)) throw new Error(added.error);
    const beef = added.view.items[0]?.id ?? "";
    await changeListItem(beef, { ticked: true });
    await saveDietaryNeeds("gluten-free");
    await saveTripSaving(250);
    await answerOf(await addListItem({ words: "eggs", quantity: 12, unit: "ct" }));
    await clearTickedItems();
    const loaded = (await (await loadShoppingList()).json()).shoppingList;
    expect(loaded).toEqual({
      items: [expect.objectContaining({ words: "eggs" })],
      dietaryNeeds: "gluten-free",
      tripSaving: 250,
      maxItems: 100,
    });
    await removeListItem(loaded.items[0]?.id ?? "");
    expect(await answerOf(await undoShoppingListChange("no-such-change"))).toEqual({
      error: "No Shopping list change has this ID.",
    });
    expect((await listOf()).items).toEqual([]);
    expect(sent.map(({ method, path, type }) => [method, path, type])).toEqual([
      ["POST", "/api/shopping-list/items", "application/json"],
      ["PUT", `/api/shopping-list/items/${beef}`, "application/json"],
      ["PUT", "/api/shopping-list/dietary-needs", "application/json"],
      ["PUT", "/api/shopping-list/trip-setting", "application/json"],
      ["POST", "/api/shopping-list/items", "application/json"],
      ["POST", "/api/shopping-list/clear-ticked", "application/json"],
      ["GET", "/api/shopping-list", undefined],
      ["DELETE", expect.stringMatching(/^\/api\/shopping-list\/items\//), undefined],
      ["POST", "/api/shopping-list/changes/no-such-change/undo", "application/json"],
    ]);
  });
});

// One edit_shopping_list change as the AI sends it: every field, null when not given.
function change(fields: Record<string, unknown>) {
  return {
    action: "change",
    id: null,
    words: null,
    quantity: null,
    unit: null,
    brandLock: null,
    note: null,
    ticked: null,
    ...fields,
  };
}
