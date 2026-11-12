import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiCost, householdAi } from "../ai/index.ts";
import { StubModels } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { addShoppingListItem, markSetupStep, storeHouseholdFacts } from "../db/index.ts";
import { FakePriceSource } from "../deal-finder/fake.ts";
import {
  type PlanRunStart,
  type PlanRuns,
  type PlanRunView,
  planRuns,
  priceSourceSettings,
} from "../deal-finder/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { buildStoredShoppingPlan } from "./shopping-plan.ts";
import type { ShoppingPlanView } from "./shopping-plan-views.ts";
import { type App, TestBrowser } from "./testing.ts";

// "Find the best prices" through the app's HTTP interface (spec 15, The Shopping plan): the start,
// the cost to confirm, and each Store's progress. Every key, List item, Store and price is made up
// when the test runs.

const APP_URL = "http://nas.local:8080";
const ZIP_CODE = "10001";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-plan-run-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

const madeKey = (label: string) => `${label}_${crypto.randomUUID().replaceAll("-", "")}`;

type Answer = PlanRunStart & { error?: string };

describe("the plan run routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;
  let fake: FakePriceSource;
  let runs: PlanRuns;
  let started: string[];

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await test.database.$client.execute({ sql: text, args })).rows;
  const press = (body: unknown = {}) => browser.post("/api/shopping-plan/run", body);
  const progress = async () =>
    ((await (await browser.get("/api/shopping-plan/run")).json()) as { run: PlanRunView | null })
      .run;
  const tables = async () => ({
    plans: await sql("SELECT * FROM shopping_plans ORDER BY id"),
    products: await sql("SELECT * FROM deal_finder_products ORDER BY id"),
    matches: await sql("SELECT * FROM product_matches ORDER BY list_item_id"),
    costs: await sql("SELECT * FROM price_source_costs"),
  });

  async function turnOn(...storeIds: string[]) {
    const settings = priceSourceSettings({ database: test.database, secrets: test.secrets });
    for (const id of storeIds) await settings.changeStore(id, { on: true });
  }

  const addItem = (id: string, words: string) =>
    addShoppingListItem(
      test.database,
      {
        id,
        words,
        quantity: 1,
        unit: "each",
        brandLock: null,
        note: null,
        addedAt: new Date(),
        addedBy: member.id,
      },
      200,
    );

  beforeEach(async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    fake = new FakePriceSource();
    started = [];
    runs = planRuns({
      database: test.database,
      secrets: test.secrets,
      adapter: fake,
      ai: householdAi({
        database: test.database,
        secrets: test.secrets,
        makeModels: new StubModels().makeModels,
        cost: aiCost({ database: test.database }),
        gates: { historyLoaded: async () => true, costCapPausedUntil: async () => undefined },
        notices: { raise: async () => undefined, end: async () => undefined },
      }),
      logger,
      notices: { raise: async () => undefined, end: async () => undefined },
      startRun: async (planId) => {
        started.push(planId);
      },
      // As the app's start does: a plan run that ends its reads and matches builds the plan.
      buildPlan: async (planId) => {
        await buildStoredShoppingPlan(test.database, planId);
      },
    });
    const security = await loadSecurity({ APP_URL }, { logger });
    app = createApp(webRoot, security, test.auth, test.database, test.secrets, {
      priceSources: fake,
      planRuns: runs,
    });
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await storeHouseholdFacts(test.database, {
      zipCode: ZIP_CODE,
      state: "NY",
      timeZone: "America/New_York",
      ages: [40, 38],
      rentOrOwn: "rent",
      updatedAt: new Date(),
      updatedBy: null,
    });
    const settings = priceSourceSettings({
      database: test.database,
      secrets: test.secrets,
      adapter: fake,
    });
    await settings.saveApifyToken(madeKey("apify_api"));
    await settings.saveKrogerKeys({ clientId: madeKey("client"), clientSecret: madeKey("secret") });
    await settings.setUseZip(true);
    await settings.findStores(25);
    await sql("DELETE FROM price_source_costs");
    fake.calls.length = 0;
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  it("shows no plan run before the first", async () => {
    expect(await progress()).toBeNull();
  });

  it("asks for List items, then for a Store that is on", async () => {
    let res = await press();
    expect(res.status).toBe(409);
    expect(((await res.json()) as Answer).error).toBe("Add List items to the Shopping list first.");

    await addItem("item-beef", "ground beef");
    res = await press();
    expect(res.status).toBe(409);
    expect(((await res.json()) as Answer).error).toBe(
      "Turn on a Store on the Price sources page first.",
    );
    expect(started).toEqual([]);
  });

  it("starts a plan run, shows each Store's progress, and joins it on a second press", async () => {
    await addItem("item-beef", "ground beef");
    await turnOn("kroger");

    const res = await press();
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Answer;
    expect(answer).toMatchObject({
      outcome: "started",
      run: {
        running: true,
        phase: "reading",
        stores: [{ storeId: "kroger", name: "Kroger", state: "waiting", reason: null }],
      },
    });
    expect(((await (await press()).json()) as Answer).outcome).toBe("joined");
    expect(started).toHaveLength(1);

    await runs.run(started[0] as string);

    expect(await progress()).toMatchObject({
      running: false,
      phase: "done",
      stores: [{ storeId: "kroger", state: "read" }],
    });
  });

  it("builds the Shopping plan when a run ends, and a Member's pick of an unchecked Product goes in the next plan", async () => {
    await addItem("item-beef", "ground beef");
    await turnOn("kroger");
    const plan = async () =>
      (
        (await (await browser.get("/api/shopping-plan")).json()) as {
          plan: ShoppingPlanView | null;
        }
      ).plan;
    expect(await plan()).toBeNull();

    await press();
    await runs.run(started[0] as string);

    // With no AI, every found Product waits for a Member.
    const built = await plan();
    expect(built?.notFound).toEqual([{ place: 0, words: "ground beef" }]);
    const [item] = built?.unchecked ?? [];
    const [product] = item?.products ?? [];
    expect(item?.listItemId).toBe("item-beef");
    expect(product?.storeName).toBe("Kroger");

    const chose = await browser.send("POST", "/api/shopping-plan/matches", {
      listItemId: "item-beef",
      productId: product?.productId,
      choice: "confirmed",
    });
    expect(chose.status).toBe(200);
    await press();
    await runs.run(started[1] as string);
    expect((await plan())?.stores.map((store) => store.lines.map((line) => line.words))).toEqual([
      ["ground beef"],
    ]);
  });

  it("answers the expected cost of a full search at a Store that charges, and starts once the Member confirms it", async () => {
    await addItem("item-beef", "ground beef");
    await turnOn("walmart");

    const asked = (await (await press()).json()) as Answer;
    expect(asked).toEqual({
      outcome: "confirm",
      cost: { fullSearch: true, costNanos: 80_000_000, monthCostNanos: 0, capCents: 500 },
    });
    expect(started).toEqual([]);

    const confirmed = (await (await press({ confirmedCostNanos: 80_000_000 })).json()) as Answer;
    expect(confirmed.outcome).toBe("started");
    expect(started).toHaveLength(1);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [{ confirmedCostNanos: -1 }],
    [{ confirmedCostNanos: 1.5 }],
    [{ confirmedCostNanos: "2000000" }],
    [{ other: true }],
    [[]],
  ])("answers 400 to the body %j, changing nothing", async (body) => {
    await addItem("item-beef", "ground beef");
    await turnOn("walmart");
    const before = await tables();

    expect((await press(body)).status).toBe(400);

    expect(await tables()).toEqual(before);
    expect(started).toEqual([]);
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, changing nothing (K1)", async () => {
    await addItem("item-beef", "ground beef");
    await turnOn("kroger");
    const before = await tables();
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.30");
    const path = "/api/shopping-plan/run";

    expect((await signedOut.send("POST", path, {})).status).toBe(401);
    expect((await signedOut.send("GET", path)).status).toBe(401);
    expect((await browser.send("POST", path, {}, { origin: "http://evil.example" })).status).toBe(
      403,
    );
    expect((await browser.send("POST", path, {}, { origin: undefined })).status).toBe(403);
    expect((await browser.send("POST", path, {}, { "content-type": "text/plain" })).status).toBe(
      415,
    );

    expect(await tables()).toEqual(before);
    expect(started).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("answers 404 in an app with no Price source adapter", async () => {
    const security = await loadSecurity(
      { APP_URL },
      { logger: createLogger(() => {}, { throwOnSecretField: true }) },
    );
    const bare = createApp(webRoot, security, test.auth, test.database, test.secrets, {});
    // A TOTP code signs in once: the second browser signs in a minute later.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const other = new TestBrowser(bare, APP_URL, "192.168.1.40");
    await other.signIn(member);

    expect((await other.get("/api/shopping-plan/run")).status).toBe(404);
    expect((await other.post("/api/shopping-plan/run", {})).status).toBe(404);
  });
});
