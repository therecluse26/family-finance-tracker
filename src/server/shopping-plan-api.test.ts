import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  deleteDealFinderData,
  markSetupStep,
  removeMember,
  storeHouseholdFacts,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { buildStoredShoppingPlan, shoppingPlanForChat, shoppingPlanView } from "./shopping-plan.ts";
import type { ShoppingPlanView } from "./shopping-plan-views.ts";
import { type App, readZip, TestBrowser } from "./testing.ts";

// The Shopping plan through the app's HTTP interface (spec 15, The Shopping plan; What the plan
// shows): a plan built from stored rows, "Use this Deal" and its end, Chat's plan, and
// shopping-plan.csv in the data export. Every Store, Product and price is made up.

const APP_URL = "http://nas.local:8080";
const ZONE = "America/New_York";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-shopping-plan-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// The Household's date, `days` from today.
const day = (days: number) => calendarDateIn(new Date(Date.now() + days * 86_400_000), ZONE);

describe("the Shopping plan routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await test.database.$client.execute({ sql: text, args })).rows;
  const view = async () =>
    ((await (await browser.get("/api/shopping-plan")).json()) as { plan: ShoppingPlanView | null })
      .plan;
  const take = (body: unknown, headers?: Record<string, string | undefined>) =>
    browser.send("POST", "/api/shopping-plan/deals", body, headers);
  const drop = (body: unknown, headers?: Record<string, string | undefined>) =>
    browser.send("POST", "/api/shopping-plan/deals/stop", body, headers);
  // Each Store's List items, as "Store: words at price", and the Not found ones.
  const where = (plan: ShoppingPlanView | null | undefined) =>
    plan?.stores.flatMap((store) =>
      store.lines.map((line) => `${store.name}: ${line.words} ${line.total} ${line.priceKind}`),
    );
  const tables = async () => ({
    plans: await sql("SELECT * FROM shopping_plans ORDER BY id"),
    lines: await sql("SELECT * FROM shopping_plan_lines ORDER BY plan_id, place"),
    deals: await sql("SELECT * FROM shopping_plan_deals ORDER BY plan_id, place"),
  });

  async function addStore(
    id: string,
    name: string,
    kind: string,
    on: boolean,
    fees: [number | null, number | null] = [null, null],
  ) {
    await sql(
      `INSERT INTO deal_finder_stores (id, name, kind, reader, "on", nearby, locations,
         delivery_fee, free_delivery_from, found_at)
       VALUES (?, ?, ?, 'Scraping service', ?, 1, '[]', ?, ?, ?)`,
      [id, name, kind, on ? 1 : 0, fees[0], fees[1], new Date().toISOString()],
    );
  }

  async function addItem(id: string, words: string, quantity: number, unit: string, place: number) {
    await sql(
      `INSERT INTO shopping_list_items (id, words, quantity, unit, ticked, place, added_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [id, words, quantity, unit, place, new Date().toISOString()],
    );
  }

  // A Product with one price read and its answer for one List item.
  async function addProduct(
    id: string,
    storeId: string,
    itemId: string,
    size: string,
    price: { regular?: number; deal?: number; endsOn?: string },
    answer = "match",
  ) {
    const at = new Date().toISOString();
    await sql(
      `INSERT INTO deal_finder_products (id, store_id, read_key, name, size, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, storeId, id, `Fake ${id}`, size, at],
    );
    await sql(
      `INSERT INTO deal_finder_price_reads (product_id, read_at, regular_price, deal_price,
         deal_ends_on)
       VALUES (?, '2026-01-01T00:00:00.000Z', 9999, NULL, NULL), (?, ?, ?, ?, ?)`,
      [id, id, at, price.regular ?? null, price.deal ?? null, price.endsOn ?? null],
    );
    await sql(
      `INSERT INTO product_matches (list_item_id, product_id, store_id, answer, read_key,
         last_full_search_at, matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemId, id, storeId, answer, id, at, at],
    );
  }

  async function buildPlan(id: string, failures = "[]") {
    await sql(
      `INSERT INTO shopping_plans (id, started_at, started_by, state, trip_saving, store_failures)
       VALUES (?, ?, ?, 'running', 0, ?)`,
      [id, new Date().toISOString(), member.id, failures],
    );
    expect(await buildStoredShoppingPlan(test.database, id)).toBe(true);
  }

  beforeEach(async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    const security = await loadSecurity({ APP_URL }, { logger });
    app = await createApp(webRoot, security, test.auth, test.database, test.secrets);
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await storeHouseholdFacts(test.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: ZONE,
      ages: [40, 38],
      rentOrOwn: "rent",
      updatedAt: new Date(),
      updatedBy: null,
    });
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    await addStore("kroger", "Kroger", "in person", true);
    await addStore("walmart", "Walmart", "in person", true);
    await addStore("amazon", "Amazon", "online", true, [599, 3500]);
    await addStore("target", "Target", "in person", false);
    await addStore("ad-fresh", "Fresh Market", "weekly ad only", true);
    await addItem("beef", "ground beef", 2, "lb", 0);
    await addItem("eggs", "eggs", 12, "each", 1);
    await addItem("milk", "milk", 1, "gal", 2);
    await addItem("saffron", "saffron", 1, "each", 3);
    await addProduct("kroger-beef", "kroger", "beef", "1 lb", {
      regular: 549,
      deal: 449,
      endsOn: day(3),
    });
    await addProduct("walmart-beef", "walmart", "beef", "1 lb", { regular: 519 });
    await addProduct("walmart-turkey", "walmart", "beef", "1 lb", { regular: 100 }, "substitute");
    await addProduct("target-beef", "target", "beef", "1 lb", { regular: 300, deal: 100 });
    await addProduct("kroger-eggs", "kroger", "eggs", "12 ct", { regular: 389 });
    await addProduct("walmart-eggs", "walmart", "eggs", "12 ct", {
      regular: 349,
      deal: 299,
      endsOn: day(5),
    });
    await addProduct("ad-fresh-eggs", "ad-fresh", "eggs", "12 ct", { deal: 199, endsOn: day(2) });
    await addProduct("kroger-milk", "kroger", "milk", "1 gal", { regular: 359, deal: 299 });
    await addProduct("walmart-milk", "walmart", "milk", "1 gal", { regular: 329 });
    await addProduct("amazon-milk", "amazon", "milk", "64 fl oz", { regular: 150 });
  });

  afterEach(() => {
    test.close();
  });

  it("has no plan before the first one, in the page, Chat and the data export", async () => {
    expect(await view()).toBe(null);
    expect((await shoppingPlanForChat(test.database)).plan).toBe(null);
    const res = await browser.send("POST", "/api/export", {});
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect(files.has("shopping-plan.csv")).toBe(false);
  });

  it("builds the plan from the stored rows: `match` only, Stores that are on, regular prices, Not found", async () => {
    await buildPlan(
      "plan-1",
      JSON.stringify([{ storeId: "target", reason: "Could not read this store" }]),
    );
    const plan = await view();
    // Walmart has every List item at the lowest regular price. Target's $3.00 beef is off, and the
    // $1.00 turkey is only a substitute. Amazon's milk is 2 × $1.50 but a $5.99 fee.
    expect(where(plan)).toEqual([
      "Walmart: ground beef 1038 regular",
      "Walmart: eggs 349 regular",
      "Walmart: milk 329 regular",
    ]);
    expect(plan).toMatchObject({
      planId: "plan-1",
      today: day(0),
      builtOn: day(0),
      total: 1716,
      trips: 1,
      saving: 0,
      notFound: [{ place: 3, words: "saffron" }],
      failures: [{ storeId: "target", name: "Target", reason: "Could not read this store" }],
    });
    expect(plan?.stores[0]?.lines[0]).toMatchObject({ packages: 2, price: 519, readOn: day(0) });
    expect(await sql("SELECT state, total, trips, saving FROM shopping_plans")).toEqual([
      { state: "done", total: 1716, trips: 1, saving: 0 },
    ]);
    // Walmart's own Deal on eggs shows beside them. Kroger's and Fresh Market's are below the plan:
    // they save $1.70 and $1.50, less than the $10.00 an extra trip must save.
    expect(plan?.stores[0]?.lines[1]?.deals).toEqual([
      expect.objectContaining({ storeName: "Walmart", price: 299, saves: 50, endsOn: day(5) }),
    ]);
    expect(plan?.elsewhere.map((store) => [store.name, store.saving, store.paysForTrip])).toEqual([
      ["Kroger", 170, false],
      ["Fresh Market", 150, false],
    ]);
  });

  it("uses a Deal until it ends, then shows the List item at its regular price again", async () => {
    await buildPlan("plan-1");
    const used = await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" });
    expect(used.status, await used.clone().text()).toBe(200);
    const plan = ((await used.json()) as { plan: ShoppingPlanView }).plan;
    expect(where(plan)).toContain("Walmart: eggs 299 deal");
    expect(plan.stores[0]?.lines[1]).toMatchObject({ dealEndsOn: day(5), deals: [] });
    expect(plan.total).toBe(1666);
    expect(
      await sql("SELECT place, product_id, price, total, used_by FROM shopping_plan_deals"),
    ).toEqual([
      { place: 1, product_id: "walmart-eggs", price: 299, total: 299, used_by: member.id },
    ]);
    // The day after the Deal ends, the List item is back at its regular price.
    const later = await shoppingPlanView(test.database, new Date(Date.now() + 6 * 86_400_000));
    expect(where(later)).toContain("Walmart: eggs 349 regular");
    expect(later?.total).toBe(1716);
    // "Use the regular price" ends it at once.
    expect((await drop({ planId: "plan-1", place: 1 })).status).toBe(200);
    expect(where(await view())).toContain("Walmart: eggs 349 regular");
    expect((await drop({ planId: "plan-1", place: 1 })).status).toBe(404);
  });

  it("moves a List item to a Deal at another Store only when the trip setting says the saving pays", async () => {
    await buildPlan("plan-1");
    // Kroger's Deals save $1.70, less than the $10.00 plan-1 was built with. A trip setting changed
    // since counts only from the next plan.
    await sql("INSERT INTO deal_finder_settings (id, trip_saving) VALUES (1, 100)");
    const before = await tables();
    expect((await take({ planId: "plan-1", place: 0, productId: "kroger-beef" })).status).toBe(409);
    expect(await tables()).toEqual(before);

    await buildPlan("plan-2");
    const plan = await view();
    expect(plan?.elsewhere[0]).toMatchObject({ name: "Kroger", saving: 170, paysForTrip: true });
    // The older plan's Deal is refused: a newer plan is here.
    expect((await take({ planId: "plan-1", place: 0, productId: "kroger-beef" })).status).toBe(409);
    const used = await take({ planId: "plan-2", place: 0, productId: "kroger-beef" });
    expect(used.status).toBe(200);
    const moved = ((await used.json()) as { plan: ShoppingPlanView }).plan;
    expect(where(moved)).toEqual([
      "Kroger: ground beef 898 deal",
      "Walmart: eggs 349 regular",
      "Walmart: milk 329 regular",
    ]);
    expect(moved.trips).toBe(2);
    // Kroger is in the plan now, so its milk Deal shows beside the milk.
    expect(moved.stores[1]?.lines[1]?.deals).toEqual([
      expect.objectContaining({ storeName: "Kroger", price: 299, saves: 30, endsOn: null }),
    ]);
  });

  it("refuses a Deal it does not offer, and changes nothing (K2)", async () => {
    await buildPlan("plan-1");
    const before = await tables();
    const refused = async (body: unknown, status: number) => {
      const res = await take(body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    };
    // Target is off; the turkey is a substitute; Kroger's beef is not the List item's Deal for the
    // eggs; Fresh Market's eggs Deal does not pay for a $10.00 trip; no plan has this ID or place.
    await refused({ planId: "plan-1", place: 0, productId: "target-beef" }, 409);
    await refused({ planId: "plan-1", place: 0, productId: "walmart-turkey" }, 409);
    await refused({ planId: "plan-1", place: 1, productId: "kroger-beef" }, 409);
    await refused({ planId: "plan-1", place: 2, productId: "walmart-eggs" }, 409);
    await refused({ planId: "plan-1", place: 1, productId: "ad-fresh-eggs" }, 409);
    await refused({ planId: "plan-0", place: 1, productId: "walmart-eggs" }, 409);
    await refused({ planId: "plan-1", place: 9, productId: "walmart-eggs" }, 404);
    await refused({ planId: "plan-1", place: 1 }, 400);
    await refused({ planId: "plan-1", place: 1, productId: "walmart-eggs", price: 1 }, 400);
    await refused({ planId: "plan-1", place: -1, productId: "walmart-eggs" }, 400);
    // A Deal that has ended is not offered.
    await sql(
      "UPDATE deal_finder_price_reads SET deal_ends_on = ? WHERE product_id = 'walmart-eggs'",
      [day(-1)],
    );
    await refused({ planId: "plan-1", place: 1, productId: "walmart-eggs" }, 409);
    expect(await tables()).toEqual(before);
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to another type, and changes nothing (K1)", async () => {
    await buildPlan("plan-1");
    const body = { planId: "plan-1", place: 1, productId: "walmart-eggs" };
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await signedOut.get("/api/shopping-plan")).status).toBe(401);
    expect((await signedOut.send("POST", "/api/shopping-plan/deals", body)).status).toBe(401);
    expect((await signedOut.send("POST", "/api/shopping-plan/deals/stop", body)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await take(body, { origin })).status).toBe(403);
      expect((await drop(body, { origin })).status).toBe(403);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      expect((await take(body, { "content-type": type })).status, type).toBe(415);
    }
    expect(await sql("SELECT * FROM shopping_plan_deals")).toEqual([]);
    expect((await take(body)).status).toBe(200);
    for (const type of ["text/plain", undefined]) {
      expect((await drop(body, { "content-type": type })).status, type).toBe(415);
    }
    expect(await sql("SELECT place FROM shopping_plan_deals")).toEqual([{ place: 1 }]);
  });

  it("keeps a used Deal when its Member is removed, and drops it with its plan, Product or Store (K6)", async () => {
    await buildPlan("plan-1");
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
    await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    expect(await removeMember(test.database, member.id, new Date())).toBe("removed");
    expect(await sql("SELECT place, used_by FROM shopping_plan_deals")).toEqual([
      { place: 1, used_by: null },
    ]);
    await sql("DELETE FROM deal_finder_products WHERE id = 'walmart-eggs'");
    expect(await sql("SELECT * FROM shopping_plan_deals")).toEqual([]);
    await sql(
      `INSERT INTO shopping_plan_deals (plan_id, place, store_id, product_id, product_name,
         packages, price, total, price_read_at, used_at)
       VALUES ('plan-1', 0, 'kroger', 'kroger-beef', 'Fake kroger-beef', 2, 449, 898, ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );
    await deleteDealFinderData(test.database);
    expect(await tables()).toEqual({ plans: [], lines: [], deals: [] });
  });

  it("ends a used Deal only in its own plan (K2)", async () => {
    await buildPlan("plan-1");
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
    const before = await tables();
    expect((await drop({ planId: "plan-other", place: 1 })).status).toBe(404);
    expect(await tables()).toEqual(before);
    expect(where(await view())).toContain("Walmart: eggs 299 deal");
  });

  it("shows the last plan that was built, not a newer one that failed or still runs (K2)", async () => {
    await buildPlan("plan-1");
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    await sql(
      `INSERT INTO shopping_plans (id, started_at, started_by, state, trip_saving, store_failures,
         finished_at)
       VALUES ('plan-failed', ?, ?, 'failed', 0, '[]', ?),
              ('plan-running', ?, ?, 'running', 0, '[]', NULL)`,
      [later(1), member.id, later(2), later(3), member.id],
    );
    expect((await view())?.planId).toBe("plan-1");
    expect((await shoppingPlanForChat(test.database)).plan).not.toBe(null);
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
  });

  it("offers no Deal for a List item ticked off after the plan was built (K2)", async () => {
    await buildPlan("plan-1");
    await sql("UPDATE shopping_list_items SET ticked = 1 WHERE id = 'eggs'");
    const plan = await view();
    expect(plan?.stores[0]?.lines[1]).toMatchObject({ words: "eggs", deals: [] });
    expect(plan?.elsewhere.flatMap((store) => store.deals.map((deal) => deal.place))).not.toContain(
      1,
    );
    const before = await tables();
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      409,
    );
    expect(await tables()).toEqual(before);
  });

  it("drops the used Deals when the same plan is built again", async () => {
    await buildPlan("plan-1");
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
    expect(await buildStoredShoppingPlan(test.database, "plan-1")).toBe(true);
    expect(await sql("SELECT * FROM shopping_plan_deals")).toEqual([]);
    expect(where(await view())).toContain("Walmart: eggs 349 regular");
  });

  it("gives Chat the last plan with its Stores, prices, Deals, total, trips and price dates", async () => {
    await buildPlan("plan-1");
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
    const { plan } = await shoppingPlanForChat(test.database);
    expect(plan).toMatchObject({
      builtOn: day(0),
      stores: [
        {
          store: "Walmart",
          online: false,
          items: [
            {
              listItem: "ground beef",
              packages: 2,
              price: "5.19",
              total: "10.38",
              priceDate: day(0),
            },
            { listItem: "eggs", price: "2.99", priceKind: "deal", dealEndsOn: day(5) },
            { listItem: "milk", price: "3.29", priceKind: "regular" },
          ],
          subtotal: "16.66",
          deliveryFee: "0.00",
        },
      ],
      notFound: ["saffron"],
      total: "16.66",
      trips: 1,
      savingAgainstBestOneStore: "0.50",
      // The eggs use a Deal already, so Fresh Market's eggs Deal is not listed.
      dealsAtOtherStores: [
        {
          store: "Kroger",
          saving: "1.70",
          paysForTrip: false,
          deals: [
            {
              listItem: "ground beef",
              price: "4.49",
              total: "8.98",
              saves: "1.40",
              endsOn: day(3),
            },
            { listItem: "milk", price: "2.99", saves: "0.30", endsOn: null },
          ],
        },
      ],
      note: "Prices can change. Sales tax is not included.",
    });
  });

  it("writes shopping-plan.csv in the data export, as the page shows the plan", async () => {
    await buildPlan("plan-1");
    expect((await take({ planId: "plan-1", place: 1, productId: "walmart-eggs" })).status).toBe(
      200,
    );
    const res = await browser.send("POST", "/api/export", {});
    expect(res.status).toBe(200);
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect([...files.keys()].slice(-2)).toEqual(["shopping-plan.csv", "data.json"]);
    const csv = new TextDecoder().decode(files.get("shopping-plan.csv")).split("\r\n");
    expect(csv).toEqual([
      "plan_date,store,list_item,product,packages,price,total,price_kind,price_date,deal_ends_on",
      `${day(0)},Walmart,ground beef,Fake walmart-beef,2,5.19,10.38,regular,${day(0)},`,
      `${day(0)},Walmart,eggs,Fake walmart-eggs,1,2.99,2.99,deal,${day(0)},${day(5)}`,
      `${day(0)},Walmart,milk,Fake walmart-milk,1,3.29,3.29,regular,${day(0)},`,
      `${day(0)},,saffron,,,,,not found,,`,
      "",
    ]);
    const json = JSON.parse(new TextDecoder().decode(files.get("data.json"))) as {
      tables: Record<string, unknown[]>;
    };
    expect(json.tables.shopping_plan_deals).toEqual([
      expect.objectContaining({ plan_id: "plan-1", place: 1, product_id: "walmart-eggs" }),
    ]);
  });
});
