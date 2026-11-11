import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, registerSecretValue } from "../../log.ts";
import { type PriceSourceAdapter, PriceSourceError, type PriceSourceKeys } from "../adapter.ts";
import { type FakePriceSourceServers, startFakePriceSourceServers } from "../fake-servers/index.ts";
import { type PriceSourceReaderOptions, priceSourceReaders } from "./index.ts";
import { KROGER_PRODUCT_CALLS_A_DAY, type KrogerCallCount } from "./kroger.ts";

// The real readers against the local fake servers. Every key and token is made when the test runs,
// and every ZIP code, store and Product is made up.

const ZIP = "00000";
const DAY = new Date("2026-11-11T15:00:00Z");

let servers: FakePriceSourceServers;
let lines: string[];
let keys: PriceSourceKeys & {
  apifyToken: string;
  kroger: { clientId: string; clientSecret: string };
};

beforeEach(async () => {
  servers = await startFakePriceSourceServers();
  lines = [];
  keys = { apifyToken: servers.apify.newToken(), kroger: servers.kroger.newKeys() };
  // As readPriceSourceKeys does: the logger refuses each key from then on.
  registerSecretValue(keys.apifyToken);
  registerSecretValue(keys.kroger.clientId);
  registerSecretValue(keys.kroger.clientSecret);
});

afterEach(async () => {
  await servers.close();
});

function readers(options: PriceSourceReaderOptions = {}): PriceSourceAdapter {
  return priceSourceReaders({
    ...servers.addresses,
    logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
    now: () => DAY,
    ...options,
  });
}

const search = (storeId: string, extra: Record<string, unknown> = {}) => ({
  storeId,
  homeStoreId: null,
  zipCode: ZIP,
  words: "peanut butter",
  productCount: 15,
  keys,
  ...extra,
});

async function failureOf(work: Promise<unknown>): Promise<PriceSourceError> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PriceSourceError);
  return error as PriceSourceError;
}

const allSent = () => JSON.stringify([...servers.apify.requests, ...servers.kroger.requests]);

describe("The Kroger reader (spec 15, Stores and their readers)", () => {
  it("asks for a client-credentials token with scope product.compact, and passes Test", async () => {
    const result = await readers().checkAccount("kroger", keys);
    expect(result).toEqual({ value: true, costNanos: null });
    const [token] = servers.kroger.to("/v1/connect/oauth2/token");
    expect(token?.text).toBe("grant_type=client_credentials&scope=product.compact");
    const wrong = { kroger: { clientId: keys.kroger.clientId, clientSecret: "fake-wrong-secret" } };
    const refused = await failureOf(readers().checkAccount("kroger", wrong));
    expect(refused.kind).toBe("refused key");
    expect(refused.message).toBe("Kroger refused the keys.");
  });

  it("finds locations within 10 miles, then wider up to the distance, and skips one with no departments", async () => {
    const found = await readers().findLocations({
      zipCode: ZIP,
      distanceMiles: 25,
      keys: { kroger: keys.kroger },
    });
    expect(found.value).toEqual([
      {
        id: "kroger",
        name: "Kroger",
        kind: "in person",
        reader: "Store API",
        locations: [
          { id: "FAKE0101", name: "Kroger Fake Maple Avenue", distanceMiles: 10 },
          { id: "FAKE0102", name: "Kroger Fake Orchard Road", distanceMiles: 25 },
        ],
      },
    ]);
    expect(found.costNanos).toBeNull();
    const radii = servers.kroger
      .to("/v1/locations")
      .map((request) => request.query["filter.radiusInMiles"]);
    expect(radii).toEqual(["10", "25"]);
    // Only the Kroger keys: no Apify call.
    expect(servers.apify.requests).toHaveLength(0);
  });

  it("searches at the Home store with its brand filter, and maps regular and promo prices", async () => {
    const found = await readers().searchStore(
      search("kroger", { homeStoreId: "FAKE0101", words: "peanut butter", brand: "Sample" }),
    );
    expect(found).toEqual({
      value: [
        {
          readKey: "0009990000101",
          name: "Sample Creamy Peanut Butter",
          brand: "Sample",
          size: "16 oz",
          upc: "0009990000101",
          link: "https://www.kroger.com/p/sample-creamy-peanut-butter/0009990000101",
          regularPrice: 299,
          dealPrice: 249,
          dealEndsOn: null,
          onlinePrice: null,
        },
      ],
      costNanos: null,
    });
    const [sent] = servers.kroger.to("/v1/products");
    expect(sent?.query).toEqual({
      "filter.term": "Sample peanut butter",
      "filter.locationId": "FAKE0101",
      "filter.limit": "15",
      "filter.brand": "Sample",
    });
    const plain = await readers().searchStore(search("kroger", { homeStoreId: "FAKE0101" }));
    expect(plain.value.map((product) => [product.regularPrice, product.dealPrice])).toEqual([
      [299, 249],
      [729, null],
    ]);
    const one = await readers().readProduct({
      storeId: "kroger",
      homeStoreId: "FAKE0101",
      zipCode: ZIP,
      readKey: "0009990000102",
      keys,
    });
    expect(one.value?.name).toBe("Fake Farms Peanut Butter Crunchy");
    const gone = await readers().readProduct({
      storeId: "kroger",
      homeStoreId: "FAKE0101",
      zipCode: ZIP,
      readKey: "0009990000999",
      keys,
    });
    expect(gone.value).toBeNull();
  });

  it("reuses its token until it expires, and asks once more when Kroger ends it early", async () => {
    let now = DAY;
    const reader = readers({ now: () => now });
    const at = search("kroger", { homeStoreId: "FAKE0101" });
    await reader.searchStore(at);
    await reader.searchStore(at);
    expect(servers.kroger.to("/v1/connect/oauth2/token")).toHaveLength(1);
    // 1,800 s later the token has expired.
    now = new Date(DAY.getTime() + 1_800_000);
    await reader.searchStore(at);
    expect(servers.kroger.to("/v1/connect/oauth2/token")).toHaveLength(2);
    // Kroger ends the token early: one new token, and the search still works.
    servers.kroger.endTokens();
    expect((await reader.searchStore(at)).value).toHaveLength(2);
    expect(servers.kroger.to("/v1/connect/oauth2/token")).toHaveLength(3);
    // A token Kroger always refuses ends after one more try.
    servers.kroger.answer("/v1/products", { status: 401, body: {} });
    const before = servers.kroger.to("/v1/products").length;
    expect((await failureOf(reader.searchStore(at))).kind).toBe("refused key");
    expect(servers.kroger.to("/v1/products").length - before).toBe(2);
  });

  it("stops at 5,000 Products calls a day, reserved before the call, and starts again the next day", async () => {
    expect(KROGER_PRODUCT_CALLS_A_DAY).toBe(5_000);
    let now = DAY;
    const count: KrogerCallCount = { day: "2026-11-11", calls: 4_998 };
    const reader = readers({ now: () => now, krogerCalls: count });
    const at = search("kroger", { homeStoreId: "FAKE0101" });
    await reader.searchStore(at);
    // Three calls at once with one call left: exactly one is sent.
    const results = await Promise.allSettled([
      reader.searchStore(at),
      reader.searchStore(at),
      reader.searchStore(at),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(refused.map((error: PriceSourceError) => error.kind)).toEqual([
      "usage limit",
      "usage limit",
    ]);
    expect(servers.kroger.to("/v1/products")).toHaveLength(2);
    expect(count.calls).toBe(5_000);
    now = new Date("2026-11-12T15:00:00Z");
    await reader.searchStore(at);
    expect(count).toEqual({ day: "2026-11-12", calls: 1 });
  });

  it("maps Kroger's errors to their own states, with no raw error", async () => {
    const at = search("kroger", { homeStoreId: "FAKE0101" });
    servers.kroger.answer("/v1/products", {
      status: 429,
      body: { errors: { reason: "slow down" } },
    });
    expect((await failureOf(readers().searchStore(at))).kind).toBe("usage limit");
    servers.kroger.answer("/v1/products", {
      status: 500,
      body: { errors: { reason: "Fake: broken" } },
    });
    const failed = await failureOf(readers().searchStore(at));
    expect(failed.kind).toBe("store failed");
    expect(failed.message).not.toContain("Fake: broken");
    servers.kroger.answer("/v1/products", "hang up");
    expect((await failureOf(readers().searchStore(at))).kind).toBe("store failed");
    servers.kroger.answer("/v1/products", "hang");
    expect((await failureOf(readers({ krogerTimeoutMs: 100 }).searchStore(at))).kind).toBe(
      "timed out",
    );
    servers.kroger.answer("/v1/connect/oauth2/token", {
      status: 400,
      body: { error: "invalid_client" },
    });
    expect((await failureOf(readers().searchStore(at))).kind).toBe("refused key");
    expect(lines.join("")).not.toContain("Fake: broken");
  });
});

describe("Each Store's Apify reader (spec 15, Stores and their readers)", () => {
  it("runs each Actor with a $1.00 charge cap, and takes the cost from the run record", async () => {
    const found = await readers().searchStore(search("walmart"));
    expect(found.costNanos).toBe(12_300_000);
    const [started] = servers.apify.to("/v2/acts/gauravlabs~walmart-search-api/runs");
    expect(started?.query.maxTotalChargeUsd).toBe("1.00");
    expect(servers.apify.to("/v2/actor-runs/")).toHaveLength(0);
    // A run record with no cost counts at the run's cap.
    servers.apify.runUsd.set("gauravlabs/walmart-search-api", null);
    expect((await readers().searchStore(search("walmart"))).costNanos).toBe(1_000_000_000);
  });

  it("Walmart: searches by ZIP code with no paid ads, and maps each row", async () => {
    const found = await readers().searchStore(search("walmart", { brand: "Sample" }));
    expect(servers.apify.inputsOf("gauravlabs/walmart-search-api")).toEqual([
      {
        queries: ["Sample peanut butter"],
        maxResultsPerQuery: 15,
        excludeSponsored: true,
        zipcode: ZIP,
      },
    ]);
    expect(
      found.value.map((product) => [product.readKey, product.regularPrice, product.link]),
    ).toEqual([
      ["990000101", 278, "https://www.walmart.com/ip/sample-creamy-peanut-butter/990000101"],
      ["990000102", 312, "https://www.walmart.com/ip/fake-valley-large-eggs/990000102"],
    ]);
    // A Home store ID never goes to Walmart: its storeId input fails.
    await readers().searchStore(search("walmart", { homeStoreId: "9401" }));
    expect(allSent()).not.toContain("storeId");
    const again = await readers().readProduct({ ...search("walmart"), readKey: "990000102" });
    expect(again.value?.name).toBe("Fake Valley Large Eggs, 12 ct");
    expect(servers.apify.inputsOf("gauravlabs/walmart-search-api").at(-1)?.queries).toEqual([
      "990000102",
    ]);
  });

  it("Target: searches at the Home store with 25 results per search, and reads one page with Apify's own Actor", async () => {
    const found = await readers().searchStore(search("target", { homeStoreId: "9101" }));
    expect(servers.apify.inputsOf("litescrape/target-search")).toEqual([
      {
        requests: [{ query: "peanut butter" }],
        datasetOutput: true,
        maxResults: 25,
        store_id: "9101",
      },
    ]);
    expect(
      found.value.map((product) => [product.readKey, product.regularPrice, product.dealPrice]),
    ).toEqual([
      ["99000201", 359, 329],
      ["99000202", 299, null],
    ]);
    const one = await readers().readProduct({ ...search("target"), readKey: "99000201" });
    expect(servers.apify.inputsOf("apify/e-commerce-scraping-tool")).toEqual([
      {
        scrapeMode: "AUTO",
        detailsUrls: [{ url: "https://www.target.com/p/-/A-99000201" }],
        maxProductResults: 1,
      },
    ]);
    expect(one.value).toMatchObject({ readKey: "99000201", regularPrice: 359 });
    // A key not in Target's form is never sent.
    const bad = await readers().readProduct({ ...search("target"), readKey: "1/../../x" });
    expect(bad).toEqual({ value: null, costNanos: null });
  });

  it("Aldi: one query a run, with its brand filter, on-sale reads, and re-reads by Product link", async () => {
    const found = await readers().searchStore(
      search("aldi", {
        words: "ground beef",
        productCount: 10,
        brand: "Fake Brand",
        dealsOnly: true,
      }),
    );
    expect(servers.apify.inputsOf("blackfalcondata/aldi-us-scraper")).toEqual([
      {
        location: ZIP,
        query: "Fake Brand ground beef",
        maxResults: 10,
        brand: "Fake Brand",
        onSaleOnly: true,
      },
    ]);
    expect(found.value).toEqual([
      {
        readKey: "https://www.aldi.us/product/fake-brand-ground-beef-0000000701",
        name: "Fake Brand Ground Beef 80/20, 1 lb",
        brand: "Fake Brand",
        size: "1 lb",
        upc: null,
        link: "https://www.aldi.us/product/fake-brand-ground-beef-0000000701",
        regularPrice: 479,
        dealPrice: 429,
        dealEndsOn: null,
        onlinePrice: null,
      },
    ]);
    const link = "https://www.aldi.us/product/fake-brand-large-eggs-0000000702";
    const one = await readers().readProduct({ ...search("aldi"), readKey: link });
    expect(one.value).toMatchObject({ readKey: link, regularPrice: 279, dealPrice: null });
    expect(servers.apify.inputsOf("blackfalcondata/aldi-us-scraper").at(-1)).toEqual({
      location: ZIP,
      startUrls: [{ url: link }],
      maxResults: 1,
    });
  });

  it("Costco: reads the Home warehouse, uses the warehouse price, else the online price, and deal reads", async () => {
    const found = await readers().searchStore(
      search("costco", { homeStoreId: "9301", productCount: 10 }),
    );
    expect(servers.apify.inputsOf("vant47/costco-scraper")).toEqual([
      { searchTerms: ["peanut butter"], maxItemsPerSearch: 10, maxItems: 10, storeIds: ["9301"] },
    ]);
    expect(
      found.value.map((product) => [
        product.readKey,
        product.regularPrice,
        product.onlinePrice,
        product.dealPrice,
        product.dealEndsOn,
      ]),
    ).toEqual([
      ["9900801", 699, 899, null, null],
      ["9900802", null, 1299, null, null],
      ["9900803", 2079, 2399, 1779, "2026-11-22"],
    ]);
    const deals = await readers().searchStore(search("costco", { dealsOnly: true }));
    expect(servers.apify.inputsOf("vant47/costco-scraper").at(-1)).toMatchObject({
      dealsOnly: true,
      locations: [ZIP],
    });
    expect(deals.value.map((product) => product.readKey)).toEqual(["9900803"]);
    const one = await readers().readProduct({
      ...search("costco", { homeStoreId: "9302" }),
      readKey: "9900801",
    });
    expect(one.value?.regularPrice).toBe(699);
    expect(servers.apify.inputsOf("vant47/costco-scraper").at(-1)).toEqual({
      productIds: ["9900801"],
      maxItems: 1,
      storeIds: ["9302"],
    });
  });

  it("Amazon: never sends the ZIP code, takes the list price as regular, a coupon as a Deal, and re-reads by ASIN", async () => {
    const found = await readers().searchStore(search("amazon", { productCount: 5 }));
    expect(servers.apify.inputsOf("delicious_zebu/amazon-product-data-scraper")).toEqual([
      {
        Keywords: ["peanut butter"],
        maxItems: 5,
        website: "amazon.com",
        deliverTo: "US",
        scrapeProductDetails: false,
      },
    ]);
    expect(
      found.value.map((product) => [product.readKey, product.regularPrice, product.dealPrice]),
    ).toEqual([
      ["B0FAKE0001", 399, 299],
      ["B0FAKE0002", 999, null],
    ]);
    const one = await readers().readProduct({ ...search("amazon"), readKey: "B0FAKE0002" });
    expect(one.value?.name).toBe("Fake Home Paper Towels, 6 rolls");
    expect(
      servers.apify.inputsOf("delicious_zebu/amazon-product-data-scraper").at(-1),
    ).toMatchObject({
      Keywords: ["B0FAKE0002"],
      maxItems: 1,
    });
    expect(allSent()).not.toContain(ZIP);
  });

  it("weekly ads: searches with a price only, 5 Deals per search, and keeps the asked Stores", async () => {
    const found = await readers().readWeeklyAds({
      zipCode: ZIP,
      storeIds: ["ad-hilltop-fake-market", "target"],
      words: ["ground beef", "eggs"],
      keys,
    });
    expect(servers.apify.inputsOf("gratifying_graph/us-grocery-deals")).toEqual([
      {
        mode: "search",
        zipCodes: [ZIP],
        queries: ["ground beef", "eggs"],
        maxItemsPerQuery: 5,
        onlyWithPrice: true,
      },
    ]);
    expect(found.value).toEqual([
      {
        storeId: "ad-hilltop-fake-market",
        name: "Hilltop Ground Beef, per lb",
        dealPrice: 399,
        regularPrice: 529,
        validFrom: "2026-11-11",
        validTo: "2026-11-17",
      },
      {
        storeId: "target",
        name: "Large Eggs, 12 ct",
        dealPrice: 299,
        regularPrice: null,
        validFrom: "2026-11-09",
        validTo: "2026-11-15",
      },
    ]);
    expect(found.costNanos).toBe(12_300_000);
  });

  it("never asks a Store to sort by price", async () => {
    for (const storeId of ["walmart", "target", "aldi", "costco", "amazon"]) {
      await readers().searchStore(search(storeId));
    }
    for (const request of servers.apify.to("/v2/acts/")) {
      expect(JSON.stringify(request.body)).not.toMatch(/sort/i);
    }
  });

  it("drops a row whose price, link or key fails the checks", async () => {
    servers.apify.rows["gauravlabs/walmart-search-api"] = () => [
      { usItemId: "1", title: "Fake A", price: 0 },
      { usItemId: "2", title: "Fake B", price: 10_000 },
      { usItemId: "3", title: "Fake C", price: "2.999" },
      { usItemId: "4/../x", title: "Fake D", price: 1 },
      {
        usItemId: "5",
        title: "Fake E",
        price: 1,
        url: "https://www.walmart.com.evil.example/ip/5",
      },
      {
        usItemId: "6",
        title: `Fake ${"F".repeat(400)}`,
        price: "4.50",
        url: " https://www.walmart.com/ip/6",
      },
      { usItemId: "6", title: "Fake F again", price: 4.5 },
    ];
    const found = await readers().searchStore(search("walmart"));
    expect(
      found.value.map((product) => [product.readKey, product.link, product.name.length]),
    ).toEqual([
      ["5", null, 6],
      ["6", null, 200],
    ]);
  });
});

describe("Find Stores near us (spec 15)", () => {
  it("finds every supported Store near the ZIP code, with each one's locations", async () => {
    const found = await readers().findLocations({ zipCode: ZIP, distanceMiles: 25, keys });
    expect(
      found.value.map((store) => [store.id, store.kind, store.locations.map((place) => place.id)]),
    ).toEqual([
      ["kroger", "in person", ["FAKE0101", "FAKE0102"]],
      ["target", "in person", ["9101", "9102"]],
      ["costco", "in person", ["9301", "9302"]],
      ["walmart", "in person", ["9401"]],
      ["ad-hilltop-fake-market", "weekly ad only", []],
      ["aldi", "in person", []],
      ["amazon", "online", []],
    ]);
    expect(found.costNanos).toBe(4 * 12_300_000);
    expect(servers.apify.inputsOf("axlymxp/target-store-scraper")).toEqual([
      { locations: [ZIP], within: 25, limit: 5 },
    ]);
    expect(servers.apify.inputsOf("dromb/costco-us")).toEqual([
      { operation: "warehouses", postalCode: ZIP, autoResolveLocation: true, limit: 5 },
    ]);
    expect(servers.apify.inputsOf("gauravlabs/walmart-search-api")[0]).toMatchObject({
      zipcode: ZIP,
    });
    expect(servers.apify.inputsOf("gratifying_graph/us-grocery-deals")[0]).toMatchObject({
      mode: "flyers",
      zipCodes: [ZIP],
      onlyWithPrice: true,
    });
  });

  it("leaves out a Store whose lookup fails, and stops on a refused token", async () => {
    servers.apify.runStatus.set("axlymxp/target-store-scraper", "FAILED");
    const found = await readers().findLocations({ zipCode: ZIP, distanceMiles: 25, keys });
    expect(found.value.map((store) => store.id)).not.toContain("target");
    expect(found.value.map((store) => store.id)).toContain("costco");
    expect(lines.join("")).toContain("A Store lookup failed");
    const refused = await failureOf(
      readers().findLocations({
        zipCode: ZIP,
        distanceMiles: 25,
        keys: { apifyToken: "apify_api_fake_wrong" },
      }),
    );
    expect(refused.kind).toBe("refused key");
    const none = await failureOf(
      readers().findLocations({ zipCode: ZIP, distanceMiles: 25, keys: {} }),
    );
    expect(none.kind).toBe("refused key");
  });

  it("runs at most 2 Actor runs at once", async () => {
    let release = () => {};
    servers.apify.hold = new Promise((resolve) => {
      release = resolve;
    });
    const reader = readers();
    const work = Promise.all(
      ["walmart", "target", "costco", "amazon"].map((id) => reader.searchStore(search(id))),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(servers.apify.to("/v2/acts/")).toHaveLength(2);
    release();
    servers.apify.hold = undefined;
    await work;
    expect(servers.apify.to("/v2/acts/")).toHaveLength(4);
    expect(servers.apify.mostAtOnce).toBe(2);
  });
});

describe("Apify's errors (spec 15, Failures)", () => {
  it("maps each error to its own state, with a fixed message and no raw error in a log line", async () => {
    const at = search("walmart");
    const actor = "/v2/acts/gauravlabs~walmart-search-api/runs";
    const refused = await failureOf(
      readers().searchStore({ ...at, keys: { apifyToken: "apify_api_fake_wrong" } }),
    );
    expect([refused.kind, refused.message]).toEqual(["refused key", "Apify refused the token."]);
    expect(
      (await failureOf(readers().checkAccount("apify", { apifyToken: "apify_api_fake_wrong" })))
        .kind,
    ).toBe("refused key");
    for (const [status, type] of [
      [402, "not-enough-usage-to-run-paid-actor"],
      [403, "monthly-usage-limit-exceeded"],
      [429, "rate-limit-exceeded"],
    ] as const) {
      servers.apify.answer(actor, {
        status,
        body: { error: { type, message: `Fake: ${keys.apifyToken}` } },
      });
      const limit = await failureOf(readers().searchStore(at));
      expect([limit.kind, limit.message]).toEqual(["usage limit", "Apify usage limit reached."]);
    }
    servers.apify.answer(actor, { status: 500, body: { error: { message: "Fake: broken" } } });
    expect((await failureOf(readers().searchStore(at))).kind).toBe("store failed");
    servers.apify.answer(actor, { status: 200, body: "not a run" });
    expect((await failureOf(readers().searchStore(at))).kind).toBe("store failed");
    expect(lines.join("")).not.toContain("Fake:");
    expect(lines.join("")).not.toContain(keys.apifyToken);
  });

  it("an Actor that fails is a store failure; one that times out is a timeout", async () => {
    servers.apify.runStatus.set("gauravlabs/walmart-search-api", "FAILED");
    const failed = await failureOf(readers().searchStore(search("walmart")));
    expect([failed.kind, failed.message]).toEqual(["store failed", "The Actor run failed."]);
    servers.apify.runStatus.set("gauravlabs/walmart-search-api", "TIMED-OUT");
    expect((await failureOf(readers().searchStore(search("walmart")))).kind).toBe("timed out");
  });

  it("stops a run that never ends after its waits, and aborts it", async () => {
    servers.apify.runStatus.set("gauravlabs/walmart-search-api", "RUNNING");
    const stopped = await failureOf(readers().searchStore(search("walmart")));
    expect(stopped.kind).toBe("timed out");
    const polls = servers.apify.requests.filter(
      (request) => request.method === "GET" && request.path.startsWith("/v2/actor-runs/"),
    );
    expect(polls).toHaveLength(6);
    expect(
      servers.apify.requests.filter((request) => request.path.endsWith("/abort")),
    ).toHaveLength(1);
  });

  it("gives up on a request that hangs", async () => {
    servers.apify.answer("/v2/acts/", "hang");
    const reader = readers({ apifyTimings: { requestMs: 100 } });
    expect((await failureOf(reader.searchStore(search("walmart")))).kind).toBe("timed out");
  });
});

describe("What is sent (spec 15, Data and privacy)", () => {
  async function readEverything(zipCode: string | null) {
    const reader = readers();
    for (const storeId of ["kroger", "walmart", "target", "aldi", "costco", "amazon"]) {
      const homeStoreId = { kroger: "FAKE0101", target: "9101", costco: "9301" }[storeId] ?? null;
      await reader.searchStore(search(storeId, { zipCode, homeStoreId }));
    }
  }

  it("sends no ZIP code and no Home store ID with the ZIP code switch off", async () => {
    await readEverything(null);
    expect(allSent()).not.toContain(ZIP);
    for (const store of ["9101", "9301", "FAKE0101"]) expect(allSent()).not.toContain(store);
    // Kroger and Aldi give no price without a location, so they are not called.
    expect(servers.kroger.requests).toHaveLength(0);
    expect(servers.apify.inputsOf("blackfalcondata/aldi-us-scraper")).toHaveLength(0);
    expect(servers.apify.inputsOf("gauravlabs/walmart-search-api")[0]).not.toHaveProperty(
      "zipcode",
    );
    expect(servers.apify.inputsOf("litescrape/target-search")[0]).not.toHaveProperty("store_id");
    expect(servers.apify.inputsOf("vant47/costco-scraper")[0]).not.toHaveProperty("locations");
  });

  it("sends only the key, words and place in each request: no Member detail in a body or header", async () => {
    await readEverything(ZIP);
    await readers().findLocations({ zipCode: ZIP, distanceMiles: 50, keys });
    const allowed = new Set([
      "host",
      "connection",
      "authorization",
      "accept",
      "content-type",
      "content-length",
      "user-agent",
      "accept-encoding",
      "accept-language",
      "sec-fetch-mode",
    ]);
    for (const request of [...servers.apify.requests, ...servers.kroger.requests]) {
      for (const name of Object.keys(request.headers)) expect(allowed, name).toContain(name);
      expect(String(request.headers["user-agent"] ?? "")).not.toMatch(/@|mailto|\(.*\)/);
      expect(request.text).not.toMatch(/@/);
    }
    // The Kroger secret goes only in the token request.
    const withSecret = servers.kroger.requests.filter((request) =>
      String(request.headers.authorization).startsWith("Basic "),
    );
    expect(withSecret.every((request) => request.path === "/v1/connect/oauth2/token")).toBe(true);
    expect(allSent()).not.toContain(keys.kroger.clientSecret);
  });

  it("never reaches a real service from a test", async () => {
    const real = priceSourceReaders({
      logger: createLogger(() => {}, { throwOnSecretField: true }),
    });
    const error = await failureOf(
      real.checkAccount("apify", { apifyToken: "apify_api_fake_unused" }),
    );
    expect(error.message).toBe("A test may call only a local fake server.");
  });
});
