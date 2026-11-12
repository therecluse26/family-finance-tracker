import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import {
  addShoppingListItem,
  type Database,
  readDealFinderSettings,
  storeDealFinderSettings,
  storeHouseholdFacts,
  storeMatchAnswers,
} from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import type { PriceSourceAdapter, ProductRead } from "./adapter.ts";
import { FakePriceSource } from "./fake.ts";
import { type FakePriceSourceServers, startFakePriceSourceServers } from "./fake-servers/index.ts";
import {
  brandAllowed,
  PRODUCT_MATCH_TASK,
  rememberMatchChoice,
  SEARCH_WORDS_TASK,
} from "./match.ts";
import { FakeProductData } from "./product-data.ts";
import { priceSourceReaders } from "./readers/index.ts";
import { WALMART_ACTOR } from "./readers/stores/walmart.ts";
import {
  checkProduct,
  PLAN_RUN_STALE_MS,
  type PlanRunNotices,
  type PlanRuns,
  planRuns,
  prunePriceHistory,
  storeFailingCondition,
} from "./run.ts";
import {
  COST_CAP_REACHED,
  COULD_NOT_READ,
  FIND_STORES_AGAIN,
  type PlanRunView,
  SOURCE_REASONS,
} from "./run-view.ts";
import { priceSourceSettings } from "./settings.ts";

// The plan run (spec 15, The Shopping plan; Search once, then re-read; Cost and limits; Failures)
// on the fake Price source and AI SDK test models. Every List item, Store, Product, price and key
// is made up when the test runs.

const START = new Date("2026-11-11T15:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZIP_CODE = "10001";
const PRICE = { input: 1_000_000, output: 2_000_000 };

const madeKey = (label: string) => `${label}_${crypto.randomUUID().replaceAll("-", "")}`;

type Row = Record<string, unknown> & { row: number };

// The user texts of a request, and its rows when it is the task's.
function rowsOf(messages: StubMessage[], task: string): Row[] | undefined {
  const texts = messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
    );
  if (!texts.includes(task)) return undefined;
  return texts.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text) as Row);
}

describe("plan runs", () => {
  let test: TestDatabase;
  let database: Database;
  let secrets: Secrets;
  let fake: FakePriceSource;
  let stub: StubModels;
  let clock: Date;
  let started: string[];
  let notices: PlanRunNotices & { raised: string[]; ended: string[] };
  let lines: string[];
  let runs: PlanRuns;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await database.$client.execute({ sql: text, args })).rows;

  const gates: AiGates = {
    historyLoaded: async () => true,
    costCapPausedUntil: async () => undefined,
  };
  const aiOptions = () => ({
    database,
    secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database }),
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

  const makeRuns = (
    adapter: PriceSourceAdapter = fake,
    extra: Partial<Parameters<typeof planRuns>[0]> = {},
  ) =>
    planRuns({
      database,
      secrets,
      adapter,
      ai: householdAi(aiOptions()),
      logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
      now: () => clock,
      notices,
      startRun: async (planId) => {
        started.push(planId);
      },
      ...extra,
    });

  let place = 0;
  const addItem = async (words: string, extra: Partial<{ brandLock: string }> = {}) => {
    place += 1;
    const id = `item-${place}`;
    const added = await addShoppingListItem(
      database,
      {
        id,
        words,
        quantity: 1,
        unit: "each",
        brandLock: extra.brandLock ?? null,
        note: null,
        addedAt: clock,
        addedBy: null,
      },
      200,
    );
    expect(added).toBe(true);
    return id;
  };

  // Turns on only these Stores.
  async function turnOn(...storeIds: string[]) {
    await sql(`UPDATE deal_finder_stores SET "on" = 0`);
    const settings = priceSourceSettings({ database, secrets, adapter: fake });
    for (const id of storeIds) {
      expect(await settings.changeStore(id, { on: true })).toMatchObject({ outcome: "changed" });
    }
    fake.calls.length = 0;
  }

  // Presses "Find the best prices", confirms any cost, and runs the job.
  async function runPlan(): Promise<PlanRunView> {
    let answer = await runs.start(null);
    if (answer.outcome === "confirm") answer = await runs.start(null, answer.cost.costNanos);
    expect(answer.outcome).toBe("started");
    const planId = started.at(-1) as string;
    await runs.run(planId);
    return (await runs.view()) as PlanRunView;
  }

  // The fake Price source with some calls changed. It still reads the fake's made-up Home stores.
  const wrapped = (changes: Partial<PriceSourceAdapter>): PriceSourceAdapter => ({
    madeUpStores: true,
    checkAccount: fake.checkAccount.bind(fake),
    findLocations: fake.findLocations.bind(fake),
    searchStore: fake.searchStore.bind(fake),
    searchStoreMany: fake.searchStoreMany.bind(fake),
    readProduct: fake.readProduct.bind(fake),
    readProducts: fake.readProducts.bind(fake),
    readWeeklyAds: fake.readWeeklyAds.bind(fake),
    ...changes,
  });

  const storesOf = (view: PlanRunView) =>
    Object.fromEntries(view.stores.map((store) => [store.storeId, [store.state, store.reason]]));
  const matches = async () =>
    sql(
      `SELECT pm.list_item_id AS item, pm.store_id AS store, p.read_key AS readKey, pm.answer
       FROM product_matches pm JOIN deal_finder_products p ON p.id = pm.product_id
       ORDER BY pm.list_item_id, pm.store_id, p.read_key`,
    );
  const callsOf = () => fake.calls.map((call) => `${call.call} ${call.target}`);

  beforeEach(async () => {
    test = await newTestDatabase();
    database = test.database;
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    secrets = await unlockSecrets(database, newMasterKey().masterKey, { logger: quiet });
    fake = new FakePriceSource();
    stub = new StubModels();
    clock = START;
    started = [];
    lines = [];
    place = 0;
    const raised: string[] = [];
    const ended: string[] = [];
    notices = {
      raised,
      ended,
      raise: async (notice) => {
        raised.push("condition" in notice ? String(notice.condition) : "notice");
      },
      end: async (condition) => {
        ended.push(condition);
      },
    };
    await storeHouseholdFacts(database, {
      zipCode: ZIP_CODE,
      state: "NY",
      timeZone: "America/New_York",
      ages: [40, 38],
      rentOrOwn: "rent",
      updatedAt: START,
      updatedBy: null,
    });
    const settings = priceSourceSettings({ database, secrets, adapter: fake });
    await settings.saveApifyToken(madeKey("apify_api"));
    await settings.saveKrogerKeys({ clientId: madeKey("client"), clientSecret: madeKey("secret") });
    await settings.setUseZip(true);
    await settings.findStores(25);
    // Each test counts the month's cost from its own plan runs.
    await sql("DELETE FROM price_source_costs");
    fake.calls.length = 0;
    runs = makeRuns();
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  describe("starting", () => {
    it("asks for List items, then for a Store that is on", async () => {
      expect(await runs.start(null)).toEqual({ outcome: "no items" });
      await addItem("ground beef");
      await turnOn();
      expect(await runs.start(null)).toEqual({ outcome: "no stores" });
      expect(started).toEqual([]);
      expect(await sql("SELECT * FROM shopping_plans")).toEqual([]);
    });

    it("starts at once when only free Stores search, with no cost to confirm", async () => {
      await addItem("ground beef");
      await turnOn("kroger");

      const answer = await runs.start(null);

      expect(answer.outcome).toBe("started");
      expect(started).toHaveLength(1);
      expect(fake.calls).toEqual([]);
    });

    it("shows the expected cost of a full search at a Store that charges, and starts only once it is confirmed", async () => {
      await addItem("ground beef");
      await addItem("peanut butter");
      await turnOn("kroger", "walmart");

      const asked = await runs.start(null);
      expect(asked).toEqual({
        outcome: "confirm",
        cost: { fullSearch: true, costNanos: 4_000_000, monthCostNanos: 0, capCents: 500 },
      });
      expect(await runs.start(null, 3_999_999)).toMatchObject({ outcome: "confirm" });
      expect(started).toEqual([]);
      expect(await sql("SELECT * FROM shopping_plans")).toEqual([]);

      expect(await runs.start(null, 4_000_000)).toMatchObject({ outcome: "started" });
      expect(started).toHaveLength(1);
      expect(fake.calls).toEqual([]);
    });

    it("starts one plan run when presses come at once, and joins it later (K18)", async () => {
      await addItem("ground beef");
      await turnOn("kroger");

      const answers = await Promise.all(Array.from({ length: 6 }, () => runs.start(null)));
      const second = makeRuns();
      const other = await second.start(null);

      expect(answers.map((answer) => answer.outcome)).toEqual(Array(6).fill("started"));
      expect(other.outcome).toBe("joined");
      expect(started).toHaveLength(1);
      expect(await sql("SELECT id, state FROM shopping_plans")).toEqual([
        expect.objectContaining({ id: started[0], state: "running" }),
      ]);
    });

    it("ends a plan run that stopped an hour ago, and starts a new one (K4)", async () => {
      await addItem("ground beef");
      await turnOn("kroger");
      await runs.start(null);
      const [stopped] = started;

      clock = new Date(START.getTime() + PLAN_RUN_STALE_MS);
      // Its job, run again after the hour, ends it at once with no read.
      await runs.run(stopped as string);
      expect(fake.calls).toEqual([]);
      expect(
        await sql("SELECT state FROM shopping_plans WHERE id = ?", [stopped as string]),
      ).toEqual([expect.objectContaining({ state: "failed" })]);

      expect((await runs.start(null)).outcome).toBe("started");
      expect(started).toHaveLength(2);
    });
  });

  describe("reading", () => {
    it("searches each Store once, keeps the found Products as unchecked matches with no AI, and ends done", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger", "walmart", "aldi");

      const view = await runPlan();

      expect(view).toMatchObject({ running: false, phase: "done" });
      expect(storesOf(view)).toEqual({
        kroger: ["read", null],
        walmart: ["read", null],
        aldi: ["read", null],
      });
      expect(callsOf().sort()).toEqual([
        "searchStoreMany aldi",
        "searchStoreMany kroger",
        "searchStoreMany walmart",
      ]);
      expect(await matches()).toEqual([
        { item: beef, store: "aldi", readKey: "fake-aldi-7701", answer: "unchecked" },
        { item: beef, store: "kroger", readKey: "0001111000101", answer: "unchecked" },
        { item: beef, store: "walmart", readKey: "fake-wm-5501", answer: "unchecked" },
      ]);
      expect(await sql("SELECT count(*) AS n FROM deal_finder_price_reads")).toEqual([
        expect.objectContaining({ n: 3 }),
      ]);
      // The month's cost holds what Walmart and Aldi charged.
      expect(await sql("SELECT cost_nanos FROM price_source_costs")).toEqual([
        expect.objectContaining({ cost_nanos: 4_000_000 }),
      ]);
    });

    it("never searches a List item that is ticked off (K2)", async () => {
      await addItem("ground beef");
      await turnOn("kroger");
      await sql("UPDATE shopping_list_items SET ticked = 1");

      expect(await runs.start(null)).toEqual({ outcome: "no items" });
      expect(fake.calls).toEqual([]);
    });

    it("never changes a match a Member already answered (K2)", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger", "walmart");
      await runPlan();
      const products = await sql("SELECT id, store_id FROM deal_finder_products ORDER BY store_id");
      const [kroger, walmart] = products.map((row) => String(row.id));
      await rememberMatchChoice(database, {
        listItemId: beef,
        productId: kroger as string,
        choice: "confirmed",
        memberId: null,
      });

      await storeMatchAnswers(
        database,
        [kroger, walmart].map((productId) => ({
          listItemId: beef,
          productId: productId as string,
          answer: "no" as const,
          reason: null,
        })),
        [],
        clock,
      );

      expect((await matches()).map((row) => [row.store, row.answer])).toEqual([
        ["kroger", "match"],
        ["walmart", "no"],
      ]);
    });

    it("reuses prices read in the last 24 hours, and re-reads only a saved match after", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger", "walmart");
      await runPlan();
      const [kroger] = await sql(
        "SELECT id FROM deal_finder_products WHERE read_key = '0001111000101'",
      );
      expect(
        await rememberMatchChoice(database, {
          listItemId: beef,
          productId: String(kroger?.id),
          choice: "confirmed",
          memberId: null,
        }),
      ).toBe(true);
      fake.calls.length = 0;

      clock = new Date(START.getTime() + 23 * HOUR);
      const soon = await runPlan();
      expect(storesOf(soon)).toEqual({
        kroger: ["stored prices", null],
        walmart: ["stored prices", null],
      });
      expect(fake.calls).toEqual([]);

      clock = new Date(START.getTime() + 25 * HOUR);
      const later = await runPlan();
      expect(storesOf(later)).toEqual({
        kroger: ["read", null],
        walmart: ["stored prices", null],
      });
      expect(callsOf()).toEqual(["readProduct kroger"]);
      expect(await sql("SELECT count(*) AS n FROM deal_finder_price_reads")).toEqual([
        expect.objectContaining({ n: 3 }),
      ]);
    });

    it("searches a List item again 30 days after its last full search", async () => {
      await addItem("ground beef");
      await turnOn("kroger");
      await runPlan();
      fake.calls.length = 0;

      clock = new Date(START.getTime() + 30 * DAY);
      await runPlan();

      expect(callsOf()).toEqual(["searchStoreMany kroger"]);
    });

    it("skips the Stores that need the ZIP code while the switch is off", async () => {
      await addItem("ground beef");
      await turnOn("kroger", "walmart");
      await storeDealFinderSettings(database, { useZip: false });

      const view = await runPlan();

      expect(storesOf(view)).toEqual({
        kroger: ["skipped", "Needs your ZIP code"],
        walmart: ["read", null],
      });
      expect(callsOf()).toEqual(["searchStoreMany walmart"]);
    });

    it("never reads past the cost cap when two Stores read at once (K18)", async () => {
      await addItem("peanut butter");
      await turnOn("costco", "amazon");
      // Costco's 10 Products cost about $0.05 and Amazon's 5 about $0.0125: each fits under a
      // $0.06 cap, and both do not.
      await priceSourceSettings({ database, secrets }).setCostCap(6);
      let open!: () => void;
      fake.hold = new Promise((resolve) => {
        open = resolve;
      });

      let answer = await runs.start(null);
      if (answer.outcome === "confirm") answer = await runs.start(null, answer.cost.costNanos);
      const running = runs.run(started[0] as string);
      await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0));
      open();
      await running;

      // Whichever Store took its place first reads; the other is skipped.
      const view = (await runs.view()) as PlanRunView;
      const states = Object.values(storesOf(view));
      expect(states).toContainEqual(["read", null]);
      expect(states).toContainEqual(["skipped", COST_CAP_REACHED]);
      expect(fake.calls).toHaveLength(1);
    });

    it("skips every Store of a source that refused its key, and marks the key refused", async () => {
      await addItem("ground beef");
      await turnOn("kroger", "walmart", "aldi");
      fake.sourceErrors.set("apify", "refused key");

      const view = await runPlan();

      expect(storesOf(view)).toEqual({
        kroger: ["read", null],
        walmart: ["skipped", SOURCE_REASONS.apify["refused key"]],
        aldi: ["skipped", SOURCE_REASONS.apify["refused key"]],
      });
      expect(callsOf().filter((call) => !call.endsWith("kroger"))).toHaveLength(1);
      expect((await readDealFinderSettings(database)).apifyCheck).toBe("refused");
    });
  });

  describe("failures", () => {
    it("tries a failing Store once more, then ends it failed and keeps the other Stores' reads (K5)", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger", "walmart");
      fake.failingStores.add("walmart");

      const view = await runPlan();

      expect(view).toMatchObject({ phase: "done" });
      expect(storesOf(view)).toEqual({
        kroger: ["read", null],
        walmart: ["failed", COULD_NOT_READ],
      });
      expect(callsOf().sort()).toEqual([
        "searchStoreMany kroger",
        "searchStoreMany walmart",
        "searchStoreMany walmart",
      ]);
      expect(await matches()).toEqual([
        { item: beef, store: "kroger", readKey: "0001111000101", answer: "unchecked" },
      ]);
      expect(await sql("SELECT store_failures FROM shopping_plans")).toEqual([
        { store_failures: JSON.stringify([{ storeId: "walmart", reason: COULD_NOT_READ }]) },
      ]);

      // The next run reads only the Store that failed: Kroger keeps its stored prices.
      fake.failingStores.clear();
      fake.calls.length = 0;
      clock = new Date(START.getTime() + HOUR);
      const retry = await runPlan();

      expect(storesOf(retry)).toEqual({
        kroger: ["stored prices", null],
        walmart: ["read", null],
      });
      expect(callsOf()).toEqual(["searchStoreMany walmart"]);
      expect(await matches()).toHaveLength(2);
    });

    it("raises one System notice when a Store fails 3 plan runs in a row, and ends it at a good read (K4)", async () => {
      await addItem("ground beef");
      await turnOn("walmart");
      fake.failingStores.add("walmart");

      for (const hours of [0, 1, 2]) {
        clock = new Date(START.getTime() + hours * HOUR);
        expect(notices.raised).toEqual([]);
        await runPlan();
      }
      expect(notices.raised).toEqual([storeFailingCondition("walmart")]);
      // Every run tried twice, and stopped.
      expect(callsOf()).toEqual(Array(6).fill("searchStoreMany walmart"));
      expect(await sql("SELECT state FROM shopping_plans")).toEqual(
        Array(3).fill(expect.objectContaining({ state: "done" })),
      );

      fake.failingStores.clear();
      clock = new Date(START.getTime() + 3 * HOUR);
      await runPlan();
      expect(notices.ended).toContain(storeFailingCondition("walmart"));
    });

    it("ends a run whose work throws as failed, with no raw error in the log", async () => {
      await addItem("ground beef");
      await turnOn("kroger");
      const failing = makeRuns(fake, {
        buildPlan: async () => {
          throw new Error(`a made-up failure with ${ZIP_CODE}`);
        },
      });

      let answer = await failing.start(null);
      if (answer.outcome === "confirm") answer = await failing.start(null, answer.cost.costNanos);
      await failing.run(started[0] as string);

      expect(await failing.view()).toMatchObject({ phase: "failed", running: false });
      expect(lines.join("\n")).not.toContain(ZIP_CODE);
      expect((await failing.start(null)).outcome).toBe("started");
    });
  });

  describe("matching", () => {
    let asked: { task: string; rows: Row[]; texts: string }[];

    beforeEach(async () => {
      asked = [];
      stub.replyTo = (messages) => {
        const texts = JSON.stringify(messages);
        const words = rowsOf(messages, SEARCH_WORDS_TASK);
        if (words !== undefined) {
          asked.push({ task: "search words", rows: words, texts });
          return JSON.stringify({
            answers: words.map((row) => ({ row: row.row, searchWords: String(row.item) })),
          });
        }
        const rows = rowsOf(messages, PRODUCT_MATCH_TASK);
        // Saving the AI settings tests the models.
        if (rows === undefined) return "ok";
        asked.push({ task: "product match", rows, texts });
        return JSON.stringify({
          answers: rows.map((row) => ({
            row: row.row,
            answer: String(row.product).includes("Budget") ? "no" : "match",
            reason: null,
            size: null,
          })),
        });
      };
      await connectAi();
      asked = [];
      runs = makeRuns();
    });

    it("writes each List item's search words once, then answers each found Product", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger", "walmart", "aldi");
      await storeDealFinderSettings(database, { dietaryNeeds: "no pork" });

      await runPlan();

      expect(asked.map((one) => one.task)).toEqual(["search words", "product match"]);
      expect(await sql("SELECT search_words FROM shopping_list_items")).toEqual([
        { search_words: "ground beef" },
      ]);
      expect(await matches()).toEqual([
        { item: beef, store: "aldi", readKey: "fake-aldi-7701", answer: "no" },
        { item: beef, store: "kroger", readKey: "0001111000101", answer: "match" },
        { item: beef, store: "walmart", readKey: "fake-wm-5501", answer: "match" },
      ]);
      const match = asked[1] as (typeof asked)[number];
      expect(match.texts).toContain("The Household's dietary needs: no pork");
      // The AI never gets the ZIP code or a key.
      for (const one of asked) expect(one.texts).not.toContain(ZIP_CODE);
      expect(asked.flatMap((one) => one.rows)).not.toContainEqual(
        expect.objectContaining({ store: expect.stringContaining(ZIP_CODE) }),
      );
    });

    it("answers from a Member's remembered choice, and asks the AI only about the rest", async () => {
      const first = await addItem("ground beef");
      await turnOn("kroger");
      await runPlan();
      const [kroger] = await sql("SELECT id FROM deal_finder_products");
      await rememberMatchChoice(database, {
        listItemId: first,
        productId: String(kroger?.id),
        choice: "rejected",
        memberId: null,
      });
      await sql("UPDATE shopping_list_items SET ticked = 1");
      asked = [];

      const again = await addItem("Ground  Beef");
      await turnOn("kroger", "walmart");
      await runPlan();

      expect(
        asked.filter((one) => one.task === "product match").flatMap((one) => one.rows),
      ).toEqual([expect.objectContaining({ product: "Ground Beef 80% Lean, 1 lb" })]);
      expect((await matches()).filter((row) => row.item === again)).toEqual([
        { item: again, store: "kroger", readKey: "0001111000101", answer: "no" },
        { item: again, store: "walmart", readKey: "fake-wm-5501", answer: "match" },
      ]);
    });

    it("answers no for another brand under a brand lock, with no AI call for it", async () => {
      expect(
        brandAllowed("Sample", { brand: "Fake Farms", name: "Fake Farms Peanut Butter" }),
      ).toBe(false);
      expect(brandAllowed("Sample", { brand: null, name: "Sample Creamy Peanut Butter" })).toBe(
        true,
      );
      expect(brandAllowed("Sample", { brand: null, name: "Peanut Butter" })).toBeUndefined();
      expect(brandAllowed(null, { brand: "Any", name: "Peanut Butter" })).toBe(true);
    });

    it("looks up each barcode's label once when Open Food Facts is on, and gives the AI its facts", async () => {
      const barcode = "012345678905";
      await addItem("peanut butter");
      await turnOn("kroger");
      await storeDealFinderSettings(database, { openFoodFacts: true });
      const productData = new FakeProductData();
      productData.facts.set(barcode, { ingredients: "peanuts, salt", allergens: ["peanuts"] });
      const withBarcode = wrapped({
        searchStoreMany: async (input) => {
          const found = await fake.searchStoreMany(input);
          return {
            ...found,
            value: found.value.map((list) => list.map((one) => ({ ...one, upc: barcode }))),
          };
        },
      });
      runs = makeRuns(withBarcode, { productData });

      await runPlan();
      clock = new Date(START.getTime() + 31 * DAY);
      await runPlan();

      expect(productData.calls).toEqual([barcode]);
      const rows = asked.filter((one) => one.task === "product match").flatMap((one) => one.rows);
      expect(rows).toEqual([
        expect.objectContaining({ ingredients: "peanuts, salt", allergens: "peanuts" }),
      ]);
    });

    it("keeps a found Product unchecked when the Product data source fails", async () => {
      await addItem("peanut butter");
      await turnOn("kroger");
      await storeDealFinderSettings(database, { openFoodFacts: true });
      const productData = new FakeProductData();
      productData.failing = true;
      const withBarcode = wrapped({
        searchStoreMany: async (input) => {
          const found = await fake.searchStoreMany(input);
          return {
            ...found,
            value: found.value.map((list) => list.map((one) => ({ ...one, upc: "012345678905" }))),
          };
        },
      });
      runs = makeRuns(withBarcode, { productData });

      const view = await runPlan();

      expect(view.phase).toBe("done");
      expect((await matches()).map((row) => row.answer)).toEqual(["match"]);
      expect(lines.filter((line) => line.includes("Product data lookups failed"))).toHaveLength(1);
    });
  });

  describe("costs", () => {
    const monthCost = async () =>
      Number((await sql("SELECT sum(cost_nanos) AS n FROM price_source_costs"))[0]?.n ?? 0);

    it("counts what a failed run charged, then what its retry charged", async () => {
      await addItem("ground beef");
      await turnOn("walmart");
      fake.failingTimes.set("walmart", 1);
      fake.failedRunCostNanos = 7_000_000;

      const view = await runPlan();

      expect(storesOf(view)).toEqual({ walmart: ["read", null] });
      expect(callsOf()).toEqual(["searchStoreMany walmart", "searchStoreMany walmart"]);
      expect(await monthCost()).toBe(7_000_000 + 2_000_000);
    });

    it("counts each try of a Store that always fails, and the cost cap then stops the next run", async () => {
      await addItem("ground beef");
      await turnOn("walmart");
      await priceSourceSettings({ database, secrets }).setCostCap(1);
      fake.failingStores.add("walmart");
      fake.failedRunCostNanos = 7_000_000;

      const first = await runPlan();
      expect(storesOf(first)).toEqual({ walmart: ["failed", COULD_NOT_READ] });
      expect(await monthCost()).toBe(14_000_000);

      fake.calls.length = 0;
      clock = new Date(START.getTime() + HOUR);
      const next = await runPlan();
      expect(storesOf(next)).toEqual({ walmart: ["skipped", COST_CAP_REACHED] });
      expect(fake.calls).toEqual([]);
      expect(await monthCost()).toBe(14_000_000);
    });

    it("keeps the Store failures of a run that fails after its reads", async () => {
      await addItem("ground beef");
      await turnOn("kroger", "walmart");
      fake.failingStores.add("walmart");
      const failing = makeRuns(fake, {
        buildPlan: async () => {
          throw new Error("a made-up failure");
        },
      });

      let answer = await failing.start(null);
      if (answer.outcome === "confirm") answer = await failing.start(null, answer.cost.costNanos);
      await failing.run(started[0] as string);

      expect(await sql("SELECT state, store_failures FROM shopping_plans")).toEqual([
        {
          state: "failed",
          store_failures: JSON.stringify([{ storeId: "walmart", reason: COULD_NOT_READ }]),
        },
      ]);
    });
  });

  describe("a failed match", () => {
    it("forgets a match the Store no longer has, and searches its List item again next run (K2)", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger");
      await runPlan();
      const [kroger] = await sql("SELECT id FROM deal_finder_products");
      await rememberMatchChoice(database, {
        listItemId: beef,
        productId: String(kroger?.id),
        choice: "confirmed",
        memberId: null,
      });
      // Another Store's match with the same read key, and its search: neither is Kroger's.
      await sql(
        `INSERT INTO deal_finder_products (id, store_id, read_key, name, added_at)
         VALUES ('product-other', 'walmart', '0001111000101', 'Made-up Ground Beef', ?)`,
        [START.toISOString()],
      );
      await sql(
        `INSERT INTO product_matches (list_item_id, product_id, store_id, answer, read_key,
           last_full_search_at, matched_at)
         VALUES (?, 'product-other', 'walmart', 'match', '0001111000101', ?, ?)`,
        [beef, START.toISOString(), START.toISOString()],
      );
      await sql(
        "INSERT INTO list_item_searches (list_item_id, store_id, searched_at) VALUES (?, 'walmart', ?)",
        [beef, START.toISOString()],
      );
      runs = makeRuns(wrapped({ readProduct: async () => ({ value: null, costNanos: null }) }));
      fake.calls.length = 0;

      clock = new Date(START.getTime() + 25 * HOUR);
      await runPlan();

      expect(await matches()).toEqual([
        { item: beef, store: "walmart", readKey: "0001111000101", answer: "match" },
      ]);
      expect(
        await sql("SELECT list_item_id AS item, store_id AS store FROM list_item_searches"),
      ).toEqual([{ item: beef, store: "walmart" }]);

      runs = makeRuns();
      clock = new Date(START.getTime() + 26 * HOUR);
      await runPlan();
      expect(callsOf()).toEqual(["searchStoreMany kroger"]);
      // Found again, it takes the Member's remembered choice.
      expect((await matches()).map((row) => [row.store, row.answer])).toEqual([
        ["kroger", "match"],
        ["walmart", "match"],
      ]);
    });

    it("forgets a match the Store gives no price for", async () => {
      const beef = await addItem("ground beef");
      await turnOn("kroger");
      await runPlan();
      const [kroger] = await sql("SELECT id FROM deal_finder_products");
      await rememberMatchChoice(database, {
        listItemId: beef,
        productId: String(kroger?.id),
        choice: "confirmed",
        memberId: null,
      });
      runs = makeRuns(
        wrapped({
          readProduct: async (input) => {
            const read = await fake.readProduct(input);
            const product = read.value === null ? null : { ...read.value, regularPrice: null };
            return { value: product && { ...product, dealPrice: null }, costNanos: null };
          },
        }),
      );

      clock = new Date(START.getTime() + 25 * HOUR);
      await runPlan();

      expect(await matches()).toEqual([]);
      expect(await sql("SELECT * FROM list_item_searches")).toEqual([]);
    });
  });

  describe("the weekly ads", () => {
    it("reads 5 Deals for each List item at weekly-ad-only Stores, and searches again a day later", async () => {
      const beef = await addItem("ground beef");
      const butter = await addItem("peanut butter");
      await turnOn("ad-hilltop-market");

      const asked = await runs.start(null);
      expect(asked).toEqual({
        outcome: "confirm",
        cost: { fullSearch: true, costNanos: 20_000_000, monthCostNanos: 0, capCents: 500 },
      });
      const view = await runPlan();

      expect(storesOf(view)).toEqual({ "ad-hilltop-market": ["read", null] });
      expect(callsOf()).toEqual([`readWeeklyAds ${ZIP_CODE}`]);
      expect(await matches()).toEqual([
        {
          item: beef,
          store: "ad-hilltop-market",
          readKey: "ad:2026-11-17:Hilltop Ground Beef, per lb",
          answer: "unchecked",
        },
      ]);
      expect(
        await sql(
          `SELECT r.regular_price, r.deal_price, r.deal_ends_on FROM deal_finder_price_reads r`,
        ),
      ).toEqual([{ regular_price: null, deal_price: 399, deal_ends_on: "2026-11-17" }]);
      expect(
        (await sql("SELECT list_item_id FROM list_item_searches ORDER BY list_item_id")).map(
          (row) => row.list_item_id,
        ),
      ).toEqual([beef, butter]);

      // Within a day, it keeps its Deals, with no cost to confirm.
      fake.calls.length = 0;
      clock = new Date(START.getTime() + 23 * HOUR);
      expect((await runs.start(null)).outcome).toBe("started");
      await runs.run(started.at(-1) as string);
      expect(storesOf((await runs.view()) as PlanRunView)).toEqual({
        "ad-hilltop-market": ["stored prices", null],
      });
      expect(fake.calls).toEqual([]);

      // A day on, it searches again, still with no cost to confirm.
      clock = new Date(START.getTime() + 25 * HOUR);
      expect((await runs.start(null)).outcome).toBe("started");
      await runs.run(started.at(-1) as string);
      expect(callsOf()).toEqual([`readWeeklyAds ${ZIP_CODE}`]);
    });

    it("keeps at most 5 Deals for a List item", async () => {
      await addItem("ground beef");
      await turnOn("ad-hilltop-market");
      runs = makeRuns(
        wrapped({
          readWeeklyAds: async () => ({
            value: Array.from({ length: 8 }, (_, n) => ({
              storeId: "ad-hilltop-market",
              name: `Made-up Ground Beef ${n}, per lb`,
              dealPrice: 300 + n,
              regularPrice: null,
              validFrom: "2026-11-11",
              validTo: "2026-11-17",
            })),
            costNanos: null,
          }),
        }),
      );

      await runPlan();

      expect(await matches()).toHaveLength(5);
    });

    it("skips the weekly ads while the ZIP code switch is off", async () => {
      await addItem("ground beef");
      await turnOn("ad-hilltop-market");
      await storeDealFinderSettings(database, { useZip: false });

      expect((await runs.start(null)).outcome).toBe("started");
      await runs.run(started[0] as string);

      expect(storesOf((await runs.view()) as PlanRunView)).toEqual({
        "ad-hilltop-market": ["skipped", "Needs your ZIP code"],
      });
      expect(fake.calls).toEqual([]);
    });
  });

  describe("Products per search", () => {
    it("asks for and keeps 15 at Kroger, Walmart and Target, 10 at Costco and Aldi, and 5 at Amazon", async () => {
      await addItem("ground beef");
      await turnOn("kroger", "walmart", "target", "costco", "aldi", "amazon");
      const asked: Record<string, number> = {};
      runs = makeRuns(
        wrapped({
          searchStoreMany: async (input) => {
            asked[input.storeId] = input.searches[0]?.productCount ?? 0;
            return {
              value: input.searches.map((search) =>
                Array.from({ length: 20 }, (_, k) => ({
                  readKey: `${input.storeId}-${k}`,
                  name: `Made-up ${search.words} ${k}, 1 lb`,
                  brand: null,
                  size: "1 lb",
                  upc: null,
                  link: null,
                  regularPrice: 500 + k,
                  dealPrice: null,
                  dealEndsOn: null,
                  onlinePrice: null,
                })),
              ),
              costNanos: null,
            };
          },
        }),
      );

      await runPlan();

      const counts = { kroger: 15, walmart: 15, target: 15, costco: 10, aldi: 10, amazon: 5 };
      expect(asked).toEqual(counts);
      const kept = await sql(
        "SELECT store_id, count(*) AS n FROM product_matches GROUP BY store_id",
      );
      expect(Object.fromEntries(kept.map((row) => [row.store_id, Number(row.n)]))).toEqual(counts);
    });
  });

  describe("the checks on every price", () => {
    const base: ProductRead = {
      readKey: "made-up-1",
      name: "Made-up Peanut Butter, 16 oz",
      brand: "Made-up",
      size: "16 oz",
      upc: "012345678905",
      link: "https://www.example.com/p/1",
      regularPrice: 299,
      dealPrice: null,
      dealEndsOn: null,
      onlinePrice: null,
    };

    it("keeps a Product with whole cents in range", () => {
      expect(checkProduct(base)).toMatchObject({ readKey: "made-up-1", regularPrice: 299 });
      expect(checkProduct({ ...base, regularPrice: 1 })).toMatchObject({ regularPrice: 1 });
      expect(checkProduct({ ...base, regularPrice: 999_999 })).toMatchObject({
        regularPrice: 999_999,
      });
    });

    it.each([
      ["a price of $0.00", { regularPrice: 0 }],
      ["a price of $10,000.00", { regularPrice: 1_000_000 }],
      ["a price that is not whole cents", { regularPrice: 1.5 }],
      ["a price below zero", { regularPrice: -299 }],
      ["a bad Deal price", { dealPrice: 0 }],
      ["no price at all", { regularPrice: null, dealPrice: null, onlinePrice: null }],
      ["no name", { name: "   " }],
      ["no read key", { readKey: " " }],
    ] as [string, Partial<ProductRead>][])("drops a Product with %s", (_, change) => {
      expect(checkProduct({ ...base, ...change })).toBeUndefined();
    });

    it("cuts text to 200 characters, and drops a date that is not real, a bad barcode and a long link", () => {
      const checked = checkProduct({
        ...base,
        name: `Made-up ${"x".repeat(300)}`,
        brand: "y".repeat(250),
        dealPrice: 249,
        dealEndsOn: "2026-02-30",
        upc: "12-34",
        link: `https://www.example.com/${"z".repeat(250)}`,
      });

      expect(checked?.name).toHaveLength(200);
      expect(checked?.brand).toHaveLength(200);
      expect(checked).toMatchObject({ dealEndsOn: null, upc: null, link: null, dealPrice: 249 });
      expect(checkProduct({ ...base, dealEndsOn: "2026-11-18" })?.dealEndsOn).toBe("2026-11-18");
    });
  });

  describe("with the real readers on the local fake servers", () => {
    let servers: FakePriceSourceServers;
    const monthCost = async () =>
      Number((await sql("SELECT sum(cost_nanos) AS n FROM price_source_costs"))[0]?.n ?? 0);
    const walmartRuns = () => servers.apify.inputsOf(WALMART_ACTOR);

    beforeEach(async () => {
      servers = await startFakePriceSourceServers();
      // The keys this test saved are made up, so the fake servers take any key.
      servers.apify.acceptAnyKey = true;
      servers.kroger.acceptAnyKey = true;
      const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
      readers = priceSourceReaders({ ...servers.addresses, logger, now: () => clock });
      runs = makeRuns(readers);
      await addItem("peanut butter");
      await turnOn("walmart");
      // The Stores found again with the real readers, in place of the fake's made-up Home stores.
      await findWithReaders();
    });

    afterEach(async () => {
      await servers.close();
    });

    let readers: PriceSourceAdapter;
    const findWithReaders = async () => {
      const settings = priceSourceSettings({ database, secrets, adapter: readers });
      expect(await settings.findStores(25)).toMatchObject({ outcome: "found" });
      await sql("DELETE FROM price_source_costs");
      servers.apify.requests.length = 0;
      servers.kroger.requests.length = 0;
    };
    const homeStoreOf = async (storeId: string) =>
      (await sql("SELECT home_store_id FROM deal_finder_stores WHERE id = ?", [storeId]))[0]
        ?.home_store_id;

    it("never sends a Home store the fake adapter found, and asks for Find Stores near us again", async () => {
      await sql(
        "UPDATE deal_finder_stores SET home_store_id = 'fake-walmart-4401' WHERE id = 'walmart'",
      );

      const view = await runPlan();

      expect(storesOf(view)).toEqual({ walmart: ["skipped", FIND_STORES_AGAIN] });
      expect(walmartRuns()).toEqual([]);
      expect(JSON.stringify(servers.apify.requests)).not.toContain("fake-walmart");
      // Find Stores near us with the real readers picks a real Home store, and the next run reads.
      await findWithReaders();
      expect(await homeStoreOf("walmart")).not.toMatch(/^fake-/);
      clock = new Date(START.getTime() + HOUR);
      expect(storesOf(await runPlan())).toEqual({ walmart: ["read", null] });
    });

    it("sends a Home store the readers found, which does not start with fake-", async () => {
      expect(await homeStoreOf("walmart")).not.toMatch(/^fake-/);

      expect(storesOf(await runPlan())).toEqual({ walmart: ["read", null] });
      expect(walmartRuns()).not.toEqual([]);
    });

    it("counts what a timed-out search charged, tries once more, then ends the Store failed", async () => {
      servers.apify.runStatus.set(WALMART_ACTOR, "TIMED-OUT");

      const view = await runPlan();

      expect(storesOf(view)).toEqual({ walmart: ["failed", COULD_NOT_READ] });
      expect(walmartRuns()).toHaveLength(2);
      expect(await monthCost()).toBe(2 * 12_300_000);
    });

    it("counts what a failed re-read charged, tries once more, then ends the Store failed", async () => {
      expect(storesOf(await runPlan())).toEqual({ walmart: ["read", null] });
      await sql("UPDATE product_matches SET answer = 'match'");
      await sql("DELETE FROM price_source_costs");
      const searches = walmartRuns().length;
      // Two days on, the prices are old, so the next run re-reads each saved match.
      clock = new Date(START.getTime() + 2 * DAY);
      servers.apify.runStatus.set(WALMART_ACTOR, "FAILED");

      const view = await runPlan();

      expect(storesOf(view)).toEqual({ walmart: ["failed", COULD_NOT_READ] });
      expect(walmartRuns()).toHaveLength(searches + 2);
      expect(await monthCost()).toBe(2 * 12_300_000);
    });

    it("sends the ZIP code to the readers only while the switch is on", async () => {
      await storeDealFinderSettings(database, { useZip: false });
      expect(storesOf(await runPlan())).toEqual({ walmart: ["read", null] });
      expect(JSON.stringify(walmartRuns())).not.toContain(ZIP_CODE);

      await storeDealFinderSettings(database, { useZip: true });
      await addItem("ground beef");
      clock = new Date(START.getTime() + HOUR);
      expect(storesOf(await runPlan())).toEqual({ walmart: ["read", null] });
      expect(walmartRuns().at(-1)).toMatchObject({ zipcode: ZIP_CODE });
    });
  });

  it("removes every List item search with Delete all deal finder data, and keeps the Shopping list", async () => {
    await addItem("ground beef");
    await turnOn("kroger");
    await runPlan();
    expect(await sql("SELECT * FROM list_item_searches")).toHaveLength(1);

    await priceSourceSettings({ database, secrets }).deleteAll();

    expect(await sql("SELECT * FROM list_item_searches")).toEqual([]);
    expect(await sql("SELECT * FROM shopping_list_items")).toHaveLength(1);
  });

  it("reads 100 List items at 12 Stores of 15 Products each in a few seconds (K3)", async () => {
    await sql(`UPDATE deal_finder_stores SET "on" = 0`);
    const storeIds = Array.from({ length: 12 }, (_, n) => `store-${n}`);
    await database.insert(schema.dealFinderStores).values(
      storeIds.map((id) => ({
        id,
        name: `Made-up Store ${id}`,
        kind: "in person" as const,
        reader: "Store API" as const,
        on: true,
        nearby: true,
        locations: [],
        homeStoreId: `${id}-home`,
        foundAt: START,
      })),
    );
    for (let n = 0; n < 100; n += 1) await addItem(`made-up item ${n}`);
    const product = (storeId: string, words: string, k: number): ProductRead => ({
      readKey: `${storeId}:${words}:${k}`,
      name: `${words} brand ${k}, 16 oz`,
      brand: null,
      size: "16 oz",
      upc: null,
      link: null,
      regularPrice: 100 + k,
      dealPrice: null,
      dealEndsOn: null,
      onlinePrice: null,
    });
    const big = wrapped({
      searchStore: async (input) => ({
        value: Array.from({ length: 15 }, (_, k) => product(input.storeId, input.words, k)),
        costNanos: null,
      }),
      searchStoreMany: async (input) => ({
        value: input.searches.map((search) =>
          Array.from({ length: 15 }, (_, k) => product(input.storeId, search.words, k)),
        ),
        costNanos: null,
      }),
    });
    runs = makeRuns(big);

    const began = performance.now();
    const view = await runPlan();
    const took = performance.now() - began;

    expect(view.phase).toBe("done");
    expect(await sql("SELECT count(*) AS n FROM product_matches")).toEqual([
      expect.objectContaining({ n: 18_000 }),
    ]);
    expect(took).toBeLessThan(8_000);
  }, 30_000);

  it("deletes price reads older than 400 days, and keeps the rest", async () => {
    await addItem("ground beef");
    await turnOn("kroger");
    await runPlan();
    const [product] = await sql("SELECT id FROM deal_finder_products");
    await database.insert(schema.dealFinderPriceReads).values(
      [401, 399].map((days) => ({
        productId: String(product?.id),
        readAt: new Date(START.getTime() - days * DAY),
        regularPrice: 500,
        dealPrice: null,
      })),
    );

    expect(await prunePriceHistory(database, START)).toBe(1);
    expect(await sql("SELECT count(*) AS n FROM deal_finder_price_reads")).toEqual([
      expect.objectContaining({ n: 2 }),
    ]);
  });
});
