import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  copyDatabaseInto,
  markSetupStep,
  openDatabaseCopy,
  removeMember,
  storeHouseholdFacts,
} from "../db/index.ts";
import { FakePriceSource } from "../deal-finder/fake.ts";
import { type PriceSourcesView, priceSourceSettings } from "../deal-finder/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, readZip, TestBrowser } from "./testing.ts";

// Settings → Price sources through the app's HTTP interface (spec 15, The Price sources page in
// Settings): the keys, Test, the ZIP code switch, Find Stores near us, each Store's settings, the
// cost cap, and "Delete all deal finder data". Every key is made when the test runs; every Store
// location, Product and price comes from the fake Price source.

const APP_URL = "http://nas.local:8080";
const ZIP_CODE = "10001";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-price-sources-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

const madeKey = (label: string) => `${label}_${crypto.randomUUID().replaceAll("-", "")}`;

type Answer = { priceSources: PriceSourcesView; check?: string; words?: string; error?: string };

describe("the Price sources routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;
  let lines: string[];
  let fake: FakePriceSource;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await test.database.$client.execute({ sql: text, args })).rows;
  const put = (path: string, body: unknown) => browser.send("PUT", path, body);
  const view = async () =>
    ((await (await browser.get("/api/price-sources")).json()) as Answer).priceSources;
  async function ok(res: Response): Promise<Answer> {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Answer;
  }
  const dealFinderTables = async () => ({
    settings: await sql("SELECT * FROM deal_finder_settings"),
    stores: await sql("SELECT * FROM deal_finder_stores ORDER BY id"),
    products: await sql("SELECT * FROM deal_finder_products ORDER BY id"),
    reads: await sql("SELECT * FROM deal_finder_price_reads ORDER BY id"),
    list: await sql("SELECT * FROM shopping_list_items ORDER BY id"),
    choices: await sql("SELECT * FROM member_match_choices ORDER BY words"),
    matches: await sql("SELECT * FROM product_matches ORDER BY list_item_id"),
    plans: await sql("SELECT * FROM shopping_plans ORDER BY id"),
    lines: await sql("SELECT * FROM shopping_plan_lines ORDER BY plan_id, place"),
    costs: await sql("SELECT * FROM price_source_costs"),
  });

  function makeApp(adapter: FakePriceSource | undefined, logger: ReturnType<typeof createLogger>) {
    return loadSecurity({ APP_URL }, { logger }).then((security) =>
      createApp(webRoot, security, test.auth, test.database, test.secrets, {
        ...(adapter === undefined ? {} : { priceSources: adapter }),
      }),
    );
  }

  // A Product with two price reads, a List item matched to it with a Member's choice, and a plan
  // with one line.
  async function addDealFinderData(listItemId = "item-beef"): Promise<void> {
    const at = new Date().toISOString();
    await sql(
      `INSERT OR IGNORE INTO deal_finder_stores (id, name, kind, reader, "on", nearby, locations,
         found_at)
       VALUES ('kroger', 'Kroger', 'in person', 'Store API', 0, 1, '[]', ?)`,
      [at],
    );
    await sql(
      `INSERT INTO shopping_list_items (id, words, quantity, unit, ticked, place, added_at, added_by)
       VALUES (?, 'ground beef', 2, 'lb', 0, 0, ?, ?)`,
      [listItemId, at, member.id],
    );
    await sql(
      `INSERT INTO deal_finder_products (id, store_id, read_key, name, added_at)
       VALUES ('product-1', 'kroger', '0001111000101', 'Fake Farms Ground Beef', ?)`,
      [at],
    );
    await sql(
      `INSERT INTO deal_finder_price_reads (product_id, read_at, regular_price, deal_price)
       VALUES ('product-1', ?, 549, NULL), ('product-1', ?, 549, 449)`,
      [at, at],
    );
    await sql(
      `INSERT INTO product_matches (list_item_id, product_id, store_id, answer, read_key,
         last_full_search_at, matched_at)
       VALUES (?, 'product-1', 'kroger', 'match', '0001111000101', ?, ?)`,
      [listItemId, at, at],
    );
    await sql(
      `INSERT INTO member_match_choices (words, product_id, choice, member_id, at)
       VALUES ('ground beef', 'product-1', 'confirmed', ?, ?)`,
      [member.id, at],
    );
    await sql(
      `INSERT INTO shopping_plans (id, started_at, started_by, state, trip_saving, store_failures)
       VALUES ('plan-1', ?, ?, 'done', 1000, '[]')`,
      [at, member.id],
    );
    await sql(
      `INSERT INTO shopping_plan_lines (plan_id, place, list_item_id, words, store_id, product_id,
         product_name, packages, price, total)
       VALUES ('plan-1', 0, ?, 'ground beef', 'kroger', 'product-1', 'Fake Farms Ground Beef', 2,
         549, 1098)`,
      [listItemId],
    );
  }

  const saveKrogerKeys = async () =>
    ok(
      await put("/api/price-sources/kroger", {
        clientId: madeKey("client"),
        clientSecret: madeKey("secret"),
      }),
    );

  // Saves both keys when none is saved, turns the ZIP code switch on, and finds the Stores.
  async function findStores(miles = 25) {
    const keys = await view();
    if (keys.apify.tokenLast4 === null) {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
    }
    if (keys.kroger.clientIdLast4 === null) await saveKrogerKeys();
    await ok(await put("/api/price-sources/zip", { on: true }));
    return ok(await browser.post("/api/price-sources/find-stores", { distanceMiles: miles }));
  }

  beforeEach(async () => {
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    fake = new FakePriceSource();
    app = await makeApp(fake, logger);
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
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    test.close();
  });

  it("starts with every default: no keys, the switches off, 25 miles, a $5.00 cap, no Store on", async () => {
    expect(await view()).toEqual({
      apify: { tokenLast4: null, check: null, checkedAt: null },
      kroger: { clientIdLast4: null, clientSecretLast4: null, check: null, checkedAt: null },
      openFoodFacts: false,
      zip: { on: false, zipCode: ZIP_CODE, changed: false },
      findDistanceMiles: 25,
      storesFoundAt: null,
      costCap: 500,
      monthCostNanos: 0,
      stores: expect.any(Array),
      data: { products: 0, priceReads: 0, matches: 0, plans: 0 },
    });
    expect((await view()).stores.filter((store) => store.on)).toEqual([]);
  });

  describe("the keys", () => {
    it("saves the Apify token encrypted, and answers only its last 4 characters", async () => {
      const token = madeKey("apify_api");

      const answer = await ok(await put("/api/price-sources/apify", { token }));

      expect(answer.priceSources.apify).toEqual({
        tokenLast4: token.slice(-4),
        check: null,
        checkedAt: null,
      });
      const [row] = await sql("SELECT apify_token FROM deal_finder_settings");
      const stored = String(row?.apify_token);
      expect(stored).not.toContain(token);
      expect(
        test.secrets.decrypt(stored, { rowId: 1, column: "deal_finder_settings.apify_token" }),
      ).toBe(token);
      expect(JSON.stringify(await view())).not.toContain(token);
    });

    it("saves the Kroger client ID and secret encrypted, each shown by its last 4 characters", async () => {
      const clientId = madeKey("client");
      const clientSecret = madeKey("secret");

      const answer = await ok(await put("/api/price-sources/kroger", { clientId, clientSecret }));

      expect(answer.priceSources.kroger).toMatchObject({
        clientIdLast4: clientId.slice(-4),
        clientSecretLast4: clientSecret.slice(-4),
      });
      const text = JSON.stringify(await dealFinderTables());
      expect(text).not.toContain(clientId);
      expect(text).not.toContain(clientSecret);
    });

    it("refuses a key that is not one, and never quotes it", async () => {
      const bad = `${madeKey("apify_api")} <script>`;

      const res = await put("/api/price-sources/apify", { token: bad });

      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(bad.slice(0, 20));
      expect((await view()).apify.tokenLast4).toBeNull();
      for (const token of ["short", ` ${madeKey("apify_api")}`, 42, null]) {
        expect((await put("/api/price-sources/apify", { token })).status).toBe(400);
      }
      expect(
        (await put("/api/price-sources/apify", { token: madeKey("a"), extra: 1 })).status,
      ).toBe(400);
    });

    it("never writes a key to a log line, an error answer, an API answer, or the data export (K8)", async () => {
      const token = madeKey("apify_api");
      const clientId = madeKey("client");
      const clientSecret = madeKey("secret");
      const answers: string[] = [];
      const keep = async (res: Response) => {
        answers.push(await res.clone().text());
        return res;
      };
      await keep(await put("/api/price-sources/apify", { token }));
      await keep(await put("/api/price-sources/kroger", { clientId, clientSecret }));
      await keep(await browser.post("/api/price-sources/apify/test", {}));
      fake.sourceErrors.set("kroger", "store failed");
      await keep(await browser.post("/api/price-sources/kroger/test", {}));
      fake.sourceErrors.set("apify", "refused key");
      await keep(await browser.post("/api/price-sources/apify/test", {}));
      await keep(await browser.post("/api/price-sources/find-stores", { distanceMiles: 25 }));
      await keep(await browser.get("/api/price-sources"));
      const exported = await browser.post("/api/export", {});
      expect(exported.status).toBe(200);
      const zip = new Uint8Array(await exported.arrayBuffer());
      const files = [...readZip(zip).values()].map((bytes) => Buffer.from(bytes));
      const [row] = await sql(
        "SELECT apify_token, kroger_client_id, kroger_client_secret FROM deal_finder_settings",
      );
      const ciphertexts = Object.values(row ?? {}).map(String);
      expect(ciphertexts).toHaveLength(3);

      for (const secret of [token, clientId, clientSecret, ...ciphertexts]) {
        expect(lines.join("\n")).not.toContain(secret);
        for (const answer of answers) expect(answer).not.toContain(secret);
        expect(Buffer.from(zip).includes(Buffer.from(secret))).toBe(false);
        for (const file of files) expect(file.includes(Buffer.from(secret))).toBe(false);
      }
      // The failed Test's log line names the source and the failure's kind only.
      expect(lines.join("\n")).toContain("A Price source did not answer its Test");
    });

    it("keeps each key encrypted in a backup, where the Master key still decrypts it", async () => {
      const token = madeKey("apify_api");
      await ok(await put("/api/price-sources/apify", { token }));
      const dir = mkdtempSync(join(tmpdir(), "fft-price-sources-backup-"));
      try {
        const copyPath = join(dir, "backup.db");
        await copyDatabaseInto(test.database, copyPath);

        expect(readFileSync(copyPath).includes(Buffer.from(token))).toBe(false);
        const copy = openDatabaseCopy(copyPath);
        try {
          const rows = (await copy.$client.execute("SELECT apify_token FROM deal_finder_settings"))
            .rows;
          const sealed = String(rows[0]?.apify_token);
          expect(
            test.secrets.decrypt(sealed, { rowId: 1, column: "deal_finder_settings.apify_token" }),
          ).toBe(token);
        } finally {
          copy.$client.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Test", () => {
    it("asks the adapter's account check with the saved key, and keeps what it found", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));

      const passed = await ok(await browser.post("/api/price-sources/apify/test", {}));

      expect(passed).toMatchObject({ check: "passed", words: "Apify accepted the key." });
      expect(passed.priceSources.apify.check).toBe("passed");
      expect(passed.priceSources.apify.checkedAt).not.toBeNull();
      expect(fake.calls).toEqual([{ call: "checkAccount", target: "apify" }]);
    });

    it("maps a refused key, a usage limit, and a failure to their own words, never to a 500", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      await ok(
        await put("/api/price-sources/kroger", {
          clientId: madeKey("client"),
          clientSecret: madeKey("secret"),
        }),
      );
      const press = async (source: string) =>
        ok(await browser.post(`/api/price-sources/${source}/test`, {}));

      fake.sourceErrors.set("apify", "refused key");
      expect(await press("apify")).toMatchObject({
        check: "refused",
        words: "Apify refused the token.",
      });
      fake.sourceErrors.set("kroger", "refused key");
      expect(await press("kroger")).toMatchObject({
        check: "refused",
        words: "Kroger refused the keys.",
      });
      fake.sourceErrors.set("apify", "usage limit");
      expect(await press("apify")).toMatchObject({
        check: "usage limit",
        words: "Apify usage limit reached.",
      });
      fake.sourceErrors.set("apify", "store failed");
      expect(await press("apify")).toMatchObject({ check: "no answer" });
      expect((await view()).kroger.check).toBe("refused");
    });

    it("clears a Test's result when a new key is saved", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      await ok(await browser.post("/api/price-sources/apify/test", {}));

      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));

      expect((await view()).apify).toMatchObject({ check: null, checkedAt: null });
    });

    it("keeps no result when the key changed during the Test", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      let release = () => {};
      fake.hold = new Promise((resolve) => {
        release = resolve;
      });

      const pressed = browser.post("/api/price-sources/apify/test", {});
      // The Test is in the adapter's call, held.
      await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
      fake.hold = undefined;
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      release();

      expect((await pressed).status).toBe(409);
      expect((await view()).apify.check).toBeNull();
    });

    it("makes one adapter call for two Tests pressed at once, and refuses the second (K18)", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      let release = () => {};
      fake.hold = new Promise((resolve) => {
        release = resolve;
      });

      const presses = [
        browser.post("/api/price-sources/apify/test", {}),
        browser.post("/api/price-sources/apify/test", {}),
      ];
      const both = Promise.all(presses);
      // While one Test is held in the adapter's call, the other is answered.
      await Promise.race(presses);
      release();
      const statuses = (await both).map((res) => res.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(fake.calls).toEqual([{ call: "checkAccount", target: "apify" }]);
      // The place is given back: a later Test runs.
      fake.hold = undefined;
      await ok(await browser.post("/api/price-sources/apify/test", {}));
      expect(fake.calls).toHaveLength(2);
    });

    it("refuses a Test with no saved key, a source with no key, and an app with no reader", async () => {
      expect((await browser.post("/api/price-sources/apify/test", {})).status).toBe(409);
      expect((await browser.post("/api/price-sources/openfoodfacts/test", {})).status).toBe(404);
      expect((await browser.post("/api/price-sources/apify/test", { now: true })).status).toBe(400);
      expect(fake.calls).toEqual([]);

      // An app built with no adapter has no reader: Test and Find Stores near us answer so.
      const noReader = priceSourceSettings({ database: test.database, secrets: test.secrets });
      await noReader.saveApifyToken(madeKey("apify_api"));
      await noReader.setUseZip(true);
      expect(await noReader.test("apify")).toEqual({ outcome: "no reader" });
      expect(await noReader.findStores(25)).toEqual({ outcome: "no reader" });
    });
  });

  describe("the ZIP code switch and Find Stores near us", () => {
    it("is off by default, and Find Stores near us sends no ZIP code until a Member turns it on", async () => {
      const res = await browser.post("/api/price-sources/find-stores", { distanceMiles: 25 });

      expect(res.status).toBe(409);
      expect(fake.calls).toEqual([]);
    });

    it("lists each Store found within the distance, all off, each with its nearest location as Home store", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));

      const { priceSources } = await findStores(25);

      expect(fake.calls).toEqual([{ call: "findLocations", target: ZIP_CODE }]);
      expect(priceSources.storesFoundAt).not.toBeNull();
      const byId = new Map(priceSources.stores.map((store) => [store.id, store]));
      expect([...byId.keys()].sort()).toEqual([
        "ad-hilltop-market",
        "aldi",
        "amazon",
        "costco",
        "kroger",
        "target",
        "walmart",
      ]);
      expect(priceSources.stores.every((store) => !store.on)).toBe(true);
      expect(byId.get("kroger")).toMatchObject({
        homeStore: { id: "fake-kroger-0101", name: "Kroger, Maple Avenue" },
        distanceMiles: 2.4,
        reader: "Store API",
      });
      expect(byId.get("kroger")?.locations.map((place) => place.id)).toEqual([
        "fake-kroger-0101",
        "fake-kroger-0102",
        "fake-kroger-0103",
      ]);
      expect(byId.get("amazon")).toMatchObject({ kind: "online", homeStore: null, locations: [] });
      // The lookup's cost counts toward this month.
      expect(priceSources.monthCostNanos).toBe(30_000_000);
    });

    it("leaves out a Store with no location within a shorter distance", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));

      const { priceSources } = await findStores(10);

      expect(priceSources.findDistanceMiles).toBe(10);
      expect(priceSources.stores.map((store) => store.id)).not.toContain("costco");
      expect(priceSources.stores.find((store) => store.id === "kroger")?.locations).toHaveLength(2);
    });

    it("takes only 10, 25 or 50 miles, as the number it stores (K15)", async () => {
      await ok(await put("/api/price-sources/zip", { on: true }));
      for (const distanceMiles of ["25", 24, 25.5, -25, 0, 100, null, "25 ", "1e1", true]) {
        const res = await browser.post("/api/price-sources/find-stores", { distanceMiles });
        expect([distanceMiles, res.status]).toEqual([distanceMiles, 400]);
      }
      expect(fake.calls).toEqual([]);
      // app.db itself refuses any other distance.
      await expect(
        sql("INSERT INTO deal_finder_settings (id, find_distance_miles) VALUES (1, 30)"),
      ).rejects.toThrow();
    });

    it("keeps each Store's tick, Home store and delivery amounts when the Stores are found again", async () => {
      await findStores(25);
      await ok(
        await put("/api/price-sources/stores/kroger", {
          on: true,
          homeStoreId: "fake-kroger-0102",
        }),
      );
      await ok(
        await put("/api/price-sources/stores/amazon", { deliveryFee: 599, freeDeliveryFrom: 3500 }),
      );

      const { priceSources } = await ok(
        await browser.post("/api/price-sources/find-stores", { distanceMiles: 50 }),
      );

      const kroger = priceSources.stores.find((store) => store.id === "kroger");
      expect(kroger).toMatchObject({ on: true, homeStore: { id: "fake-kroger-0102" } });
      expect(priceSources.stores.find((store) => store.id === "amazon")).toMatchObject({
        deliveryFee: 599,
        freeDeliveryFrom: 3500,
      });
    });

    it("says the ZIP code changed, and that Kroger, Aldi and the weekly ads need it when it is off", async () => {
      await findStores(25);
      await storeHouseholdFacts(test.database, {
        zipCode: "10002",
        state: "NY",
        timeZone: "America/New_York",
        ages: [40],
        rentOrOwn: "rent",
        updatedAt: new Date(),
        updatedBy: null,
      });
      await ok(await put("/api/price-sources/zip", { on: false }));

      const after = await view();

      expect(after.zip).toEqual({ on: false, zipCode: "10002", changed: true });
      const needs = after.stores.filter((store) => store.needsZip).map((store) => store.id);
      expect(needs.sort()).toEqual(["ad-hilltop-market", "aldi", "kroger"]);
    });

    it("maps the adapter's errors to their own answers, with no raw error", async () => {
      await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
      await ok(await put("/api/price-sources/zip", { on: true }));
      const press = () => browser.post("/api/price-sources/find-stores", { distanceMiles: 25 });

      fake.sourceErrors.set("apify", "usage limit");
      expect((await press()).status).toBe(429);
      fake.sourceErrors.set("apify", "refused key");
      expect((await press()).status).toBe(409);
      fake.sourceErrors.set("apify", "store failed");
      const failed = await press();
      expect(failed.status).toBe(502);
      expect(await failed.text()).not.toContain("fake");
      expect((await view()).stores).toEqual([]);
    });
  });

  describe("with the ZIP code switch off", () => {
    const listed = async () =>
      new Map((await view()).stores.map((store) => [store.id, store] as const));

    it("lists the Stores read with no location, and Kroger and Aldi as needing the ZIP code, with no lookup", async () => {
      const stores = await listed();

      expect([...stores.keys()]).toEqual([
        "aldi",
        "amazon",
        "costco",
        "kroger",
        "target",
        "walmart",
      ]);
      expect(
        [...stores.values()].filter((store) => store.needsZip).map((store) => store.id),
      ).toEqual(["aldi", "kroger"]);
      for (const store of stores.values()) {
        expect(store).toMatchObject({ on: false, homeStore: null, locations: [] });
      }
      expect(await sql("SELECT id FROM deal_finder_stores")).toEqual([]);
      expect(fake.calls).toEqual([]);
    });

    it("ticks Walmart and Amazon on, and sends no ZIP code anywhere", async () => {
      await ok(await put("/api/price-sources/stores/walmart", { on: true }));
      await ok(await put("/api/price-sources/stores/amazon", { on: true, deliveryFee: 599 }));

      const stores = await listed();
      expect(stores.get("walmart")).toMatchObject({ on: true, needsZip: false, homeStore: null });
      expect(stores.get("amazon")).toMatchObject({ on: true, deliveryFee: 599 });
      expect(fake.calls).toEqual([]);
      expect(JSON.stringify(await dealFinderTables())).not.toContain(ZIP_CODE);
    });

    it("refuses to turn on a Store that needs the ZIP code, or to pick a Home store, changing nothing", async () => {
      for (const id of ["kroger", "aldi"]) {
        const res = await put(`/api/price-sources/stores/${id}`, { on: true });
        expect([id, res.status]).toEqual([id, 409]);
      }
      const home = await put("/api/price-sources/stores/walmart", {
        homeStoreId: "fake-walmart-4401",
      });
      expect(home.status).toBe(409);
      expect(await sql("SELECT id FROM deal_finder_stores")).toEqual([]);
      // A Store that is not listed is not found.
      expect((await put("/api/price-sources/stores/ad-hilltop-market", { on: true })).status).toBe(
        404,
      );
    });

    it("refuses Kroger once the switch is turned off after a lookup, and shows that it needs the ZIP code", async () => {
      await findStores(25);
      await ok(await put("/api/price-sources/stores/kroger", { on: true }));
      await ok(await put("/api/price-sources/zip", { on: false }));

      const stores = await listed();
      expect(stores.get("kroger")).toMatchObject({ on: true, needsZip: true, homeStore: null });
      expect(stores.get("ad-hilltop-market")).toMatchObject({ needsZip: true });
      await ok(await put("/api/price-sources/stores/kroger", { on: false }));
      expect((await put("/api/price-sources/stores/kroger", { on: true })).status).toBe(409);
    });

    it("lists a Store ticked with the switch off once the switch is on, before any lookup, and turns it off", async () => {
      await ok(await put("/api/price-sources/stores/walmart", { on: true }));
      await ok(await put("/api/price-sources/zip", { on: true }));

      const on = await view();
      expect(on.storesFoundAt).toBeNull();
      expect(on.stores.map((store) => [store.id, store.on])).toEqual([["walmart", true]]);

      const off = await ok(await put("/api/price-sources/stores/walmart", { on: false }));

      expect(off.priceSources.stores).toEqual([]);
      expect(await sql(`SELECT "on" FROM deal_finder_stores WHERE id = 'walmart'`)).toEqual([
        { on: 0 },
      ]);
      expect(fake.calls).toEqual([]);
    });

    it("keeps a Store ticked with the switch off when the Stores are found later", async () => {
      await ok(await put("/api/price-sources/stores/walmart", { on: true }));

      const { priceSources } = await findStores(25);

      expect(priceSources.stores.find((store) => store.id === "walmart")).toMatchObject({
        on: true,
        homeStore: { id: "fake-walmart-4401" },
      });
    });
  });

  it("finds Kroger alone with only the Kroger keys saved", async () => {
    await saveKrogerKeys();
    await ok(await put("/api/price-sources/zip", { on: true }));

    const { priceSources } = await ok(
      await browser.post("/api/price-sources/find-stores", { distanceMiles: 25 }),
    );

    expect(priceSources.stores.map((store) => store.id)).toEqual(["kroger"]);
    expect(fake.calls).toEqual([{ call: "findLocations", target: ZIP_CODE }]);
  });

  it("tests one source even when the other source's saved key cannot be read", async () => {
    await ok(await put("/api/price-sources/apify", { token: madeKey("apify_api") }));
    await saveKrogerKeys();
    await sql("UPDATE deal_finder_settings SET kroger_client_id = 'not a sealed key'");

    const passed = await ok(await browser.post("/api/price-sources/apify/test", {}));

    expect(passed.check).toBe("passed");
    expect(fake.calls).toEqual([{ call: "checkAccount", target: "apify" }]);
  });

  describe("each Store's settings", () => {
    beforeEach(async () => {
      await findStores(25);
    });

    it("ticks a Store on and off", async () => {
      const on = await ok(await put("/api/price-sources/stores/target", { on: true }));
      expect(on.priceSources.stores.find((store) => store.id === "target")?.on).toBe(true);

      const off = await ok(await put("/api/price-sources/stores/target", { on: false }));
      expect(off.priceSources.stores.find((store) => store.id === "target")?.on).toBe(false);
    });

    it("takes a Home store only from the Store's own list, with the name from that list", async () => {
      const res = await put("/api/price-sources/stores/kroger", {
        homeStoreId: "fake-target-2201",
      });
      expect(res.status).toBe(400);
      expect(
        (await put("/api/price-sources/stores/kroger", { homeStoreId: "fake-kroger-0104" })).status,
      ).toBe(400);

      const moved = await ok(
        await put("/api/price-sources/stores/kroger", { homeStoreId: "fake-kroger-0103" }),
      );

      expect(moved.priceSources.stores.find((store) => store.id === "kroger")).toMatchObject({
        homeStore: { id: "fake-kroger-0103", name: "Kroger, Lakeview Plaza" },
        distanceMiles: 18.5,
      });
    });

    it("sets and clears the delivery fee and free-delivery amount, in whole cents", async () => {
      await ok(
        await put("/api/price-sources/stores/amazon", { deliveryFee: 699, freeDeliveryFrom: 3500 }),
      );
      for (const deliveryFee of [-1, 6.99, "699", 1_000_001]) {
        expect((await put("/api/price-sources/stores/amazon", { deliveryFee })).status).toBe(400);
      }

      const cleared = await ok(
        await put("/api/price-sources/stores/amazon", { deliveryFee: null }),
      );

      expect(cleared.priceSources.stores.find((store) => store.id === "amazon")).toMatchObject({
        deliveryFee: null,
        freeDeliveryFrom: 3500,
      });
    });

    it("keeps at most 12 Stores on, even when two are ticked at once", async () => {
      const at = new Date().toISOString();
      for (let i = 0; i < 12; i++) {
        await sql(
          `INSERT INTO deal_finder_stores (id, name, kind, reader, "on", nearby, locations, found_at)
           VALUES (?, ?, 'weekly ad only', 'Scraping service', ?, 1, '[]', ?)`,
          [`ad-local-${i}`, `Local ${i}`, i < 11 ? 1 : 0, at],
        );
      }

      const both = await Promise.all([
        put("/api/price-sources/stores/kroger", { on: true }),
        put("/api/price-sources/stores/target", { on: true }),
      ]);

      expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await sql(`SELECT count(*) AS n FROM deal_finder_stores WHERE "on" = 1`)).toEqual([
        { n: 12 },
      ]);
    });

    it("answers 404 for a Store that was not found", async () => {
      expect((await put("/api/price-sources/stores/nowhere", { on: true })).status).toBe(404);
      expect((await put("/api/price-sources/stores/Kroger%20X", { on: true })).status).toBe(404);
      expect((await put("/api/price-sources/stores/kroger", {})).status).toBe(400);
    });
  });

  it("saves Open Food Facts, the ZIP code switch, and the cost cap", async () => {
    await ok(await put("/api/price-sources/open-food-facts", { on: true }));
    await ok(await put("/api/price-sources/cost-cap", { capCents: 1250 }));
    for (const capCents of [-1, 12.5, "1250", 1_000_001]) {
      expect((await put("/api/price-sources/cost-cap", { capCents })).status).toBe(400);
    }
    expect((await put("/api/price-sources/zip", { on: "yes" })).status).toBe(400);

    expect(await view()).toMatchObject({ openFoodFacts: true, costCap: 1250 });
  });

  describe("Delete all deal finder data", () => {
    it("removes every Product, price, match and plan, and keeps the Shopping list, the Stores, the keys and other data (K2)", async () => {
      const token = madeKey("apify_api");
      await ok(await put("/api/price-sources/apify", { token }));
      await findStores(25);
      await ok(
        await put("/api/price-sources/stores/kroger", {
          on: true,
          homeStoreId: "fake-kroger-0102",
        }),
      );
      await addDealFinderData();
      const before = await dealFinderTables();
      expect((await view()).data).toEqual({ products: 1, priceReads: 2, matches: 1, plans: 1 });
      const members = await sql("SELECT id FROM members");

      const answer = await ok(await browser.post("/api/price-sources/delete-all", {}));

      expect(answer.priceSources.data).toEqual({
        products: 0,
        priceReads: 0,
        matches: 0,
        plans: 0,
      });
      const after = await dealFinderTables();
      for (const gone of ["products", "reads", "choices", "matches", "plans", "lines"] as const) {
        expect([gone, after[gone]]).toEqual([gone, []]);
      }
      for (const kept of ["settings", "stores", "list", "costs"] as const) {
        expect([kept, after[kept]]).toEqual([kept, before[kept]]);
      }
      expect(after.list).toHaveLength(1);
      expect(answer.priceSources.apify.tokenLast4).toBe(token.slice(-4));
      expect(await sql("SELECT id FROM members")).toEqual(members);
    });

    it("takes only an empty JSON body", async () => {
      await addDealFinderData();

      expect((await browser.post("/api/price-sources/delete-all", { all: true })).status).toBe(400);

      expect((await view()).data.products).toBe(1);
    });
  });

  it("keeps each deal finder row when a Member who made it is removed, with no Member (K6)", async () => {
    await findStores(25);
    const bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    member = bob;
    await addDealFinderData("item-bob");

    expect(await removeMember(test.database, bob.id, new Date())).toBe("removed");

    expect(await sql("SELECT added_by FROM shopping_list_items")).toEqual([{ added_by: null }]);
    expect(await sql("SELECT started_by FROM shopping_plans")).toEqual([{ started_by: null }]);
    expect(await sql("SELECT member_id FROM member_match_choices")).toEqual([{ member_id: null }]);
    expect(await sql("SELECT count(*) AS n FROM shopping_plan_lines")).toEqual([{ n: 1 }]);
  });

  it("deletes a removed List item's matches, and keeps its plan line with its words (K6)", async () => {
    await findStores(25);
    await addDealFinderData();

    await sql("DELETE FROM shopping_list_items WHERE id = 'item-beef'");

    expect(await sql("SELECT * FROM product_matches")).toEqual([]);
    expect(await sql("SELECT list_item_id, words FROM shopping_plan_lines")).toEqual([
      { list_item_id: null, words: "ground beef" },
    ]);
  });

  describe("every write route (K1)", () => {
    const WRITES: [string, string, unknown][] = [
      ["PUT", "/api/price-sources/apify", { token: "apify_api_made_up_for_k1_tests" }],
      [
        "PUT",
        "/api/price-sources/kroger",
        { clientId: "client_k1_made_up", clientSecret: "secret_k1_made_up" },
      ],
      ["POST", "/api/price-sources/apify/test", {}],
      ["PUT", "/api/price-sources/open-food-facts", { on: true }],
      ["PUT", "/api/price-sources/zip", { on: true }],
      ["POST", "/api/price-sources/find-stores", { distanceMiles: 25 }],
      ["PUT", "/api/price-sources/stores/kroger", { on: true }],
      ["PUT", "/api/price-sources/cost-cap", { capCents: 100 }],
      ["POST", "/api/price-sources/delete-all", {}],
    ];

    beforeEach(async () => {
      await findStores(25);
      await ok(await put("/api/price-sources/zip", { on: false }));
      await addDealFinderData();
      fake.calls.length = 0;
    });

    it.each(WRITES)(
      "%s %s answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, changing nothing",
      async (method, path, body) => {
        const before = await dealFinderTables();
        const signedOut = new TestBrowser(app, APP_URL, "192.168.1.30");

        expect((await signedOut.send(method, path, body)).status).toBe(401);
        expect(
          (await browser.send(method, path, body, { origin: "http://evil.example" })).status,
        ).toBe(403);
        expect((await browser.send(method, path, body, { origin: undefined })).status).toBe(403);
        expect(
          (await browser.send(method, path, body, { "content-type": "text/plain" })).status,
        ).toBe(415);

        expect(await dealFinderTables()).toEqual(before);
        expect(fake.calls).toEqual([]);
      },
    );

    it.each(WRITES)("%s %s waits for the first-run wizard", async (method, path, body) => {
      await sql("DELETE FROM setup_steps WHERE step = 'household facts'");
      const before = await dealFinderTables();

      expect((await browser.send(method, path, body)).status).toBe(409);

      expect(await dealFinderTables()).toEqual(before);
    });
  });
});
