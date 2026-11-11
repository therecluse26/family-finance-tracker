import { type FakeAnswer, FakeJsonServer, type FakeRequest } from "./server.ts";

// A fake Apify API on 127.0.0.1: the account read, an Actor run with its run record, and the run's
// dataset. Each Actor answers with rows made up by hand in that Actor's field shapes (spike rounds
// 7 to 14, spikes/price-source/FINDINGS.md). No ZIP code, store ID, address or name in it is real.
// Its tokens are made when a test or dev run starts.

export type ActorRows = (input: Record<string, unknown>) => Record<string, unknown>[];

type FakeRun = {
  id: string;
  actId: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd: number;
};

// The run statuses a test can set for an Actor. "RUNNING" never ends.
export type FakeRunStatus = "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT" | "RUNNING";

const words = (input: Record<string, unknown>, field: string): string[] => {
  const value = input[field];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
};

// Each Actor's made-up rows.
export const FAKE_ACTOR_ROWS: Record<string, ActorRows> = {
  "gauravlabs/walmart-search-api": (input) => {
    const rows = words(input, "queries").flatMap((query) => [
      {
        query,
        usItemId: "990000101",
        title: "Sample Creamy Peanut Butter, 16 oz",
        brand: "Sample",
        price: 2.78,
        url: "https://www.walmart.com/ip/sample-creamy-peanut-butter/990000101",
        store: { store_id: "9401", name: "Walmart Fake Pine Street", distance: 4.6 },
      },
      {
        query,
        usItemId: "990000102",
        title: "Fake Valley Large Eggs, 12 ct",
        brand: "Fake Valley",
        price: "3.12",
        url: "/ip/fake-valley-large-eggs/990000102",
        store: { store_id: "9401", name: "Walmart Fake Pine Street", distance: 4.6 },
      },
    ]);
    // A paid ad takes a slot unless the search leaves them out.
    const ad = {
      usItemId: "990000199",
      title: "Sponsored Fake Snack",
      price: 1.5,
      isSponsored: true,
    };
    return input.excludeSponsored === true ? rows : [ad, ...rows];
  },
  "litescrape/target-search": () => [
    {
      data: {
        tcin: "99000201",
        title: "Fake Pantry Large Eggs, 12 ct",
        brand: "Fake Pantry",
        price: 3.29,
        original_price: 3.59,
        url: "https://www.target.com/p/fake-pantry-large-eggs/-/A-99000201",
      },
    },
    {
      data: {
        tcin: "99000202",
        title: "Sample Creamy Peanut Butter",
        brand: "Sample",
        price: { amount: 2.99 },
        original_price: { amount: 2.99 },
        url: "https://www.target.com/p/sample-creamy-peanut-butter/-/A-99000202",
      },
    },
  ],
  "apify/e-commerce-scraping-tool": (input) => {
    const [first] = Array.isArray(input.detailsUrls) ? input.detailsUrls : [];
    const url = typeof first?.url === "string" ? first.url : "";
    return [
      { name: "Fake Pantry Large Eggs, 12 ct", url, offers: { price: 3.59, priceCurrency: "USD" } },
    ];
  },
  "axlymxp/target-store-scraper": () => [
    { storeId: "9101", name: "Target Fake Riverside", distanceMiles: 3.1, status: "Open" },
    { storeId: "9102", name: "Target Fake North Commons", distanceMiles: 12.9, status: "Open" },
    { storeId: "9103", name: "Target Fake Old Depot", distanceMiles: 6.2, status: "Closed" },
  ],
  "blackfalcondata/aldi-us-scraper": (input) => {
    const rows = [
      {
        productId: "fake-aldi-701",
        url: "https://www.aldi.us/product/fake-brand-ground-beef-0000000701",
        title: "Fake Brand Ground Beef 80/20, 1 lb",
        brand: "Fake Brand",
        priceValue: 4.29,
        regularPrice: 4.79,
        isOnSale: true,
        size: "1 lb",
      },
      {
        productId: "fake-aldi-702",
        url: "https://www.aldi.us/product/fake-brand-large-eggs-0000000702",
        title: "Fake Brand Large Eggs, 12 ct",
        brand: "Fake Brand",
        priceValue: 2.79,
        regularPrice: null,
        isOnSale: false,
        size: "12 ct",
      },
    ];
    const urls = Array.isArray(input.startUrls) ? input.startUrls.map((each) => each?.url) : [];
    if (urls.length > 0) return rows.filter((row) => urls.includes(row.url));
    return input.onSaleOnly === true ? rows.filter((row) => row.isOnSale) : rows;
  },
  "vant47/costco-scraper": (input) => {
    const rows = [
      {
        itemNumber: 9900801,
        title: "Warehouse Fake Large Eggs, 24 ct",
        warehousePrice: 6.99,
        onlinePrice: 8.99,
        onSale: false,
        url: "https://www.costco.com/warehouse-fake-large-eggs.product.9900801.html",
        priceWarehouseNumber: "9301",
      },
      {
        itemNumber: 9900802,
        title: "Warehouse Fake Peanut Butter, 2 x 40 oz",
        warehousePrice: 0,
        onlinePrice: 12.99,
        onSale: false,
        url: "https://www.costco.com/warehouse-fake-peanut-butter.product.9900802.html",
        priceWarehouseNumber: "9301",
      },
      {
        itemNumber: 9900803,
        title: "Warehouse Fake Paper Towels, 12 rolls",
        warehousePrice: 20.79,
        onlinePrice: 23.99,
        onSale: true,
        salePrice: 17.79,
        promoEndDate: "2026-11-22",
        url: "https://www.costco.com/warehouse-fake-paper-towels.product.9900803.html",
        priceWarehouseNumber: "9301",
      },
    ];
    const ids = words(input, "productIds");
    if (ids.length > 0) return rows.filter((row) => ids.includes(String(row.itemNumber)));
    return input.dealsOnly === true ? rows.filter((row) => row.onSale) : rows;
  },
  "dromb/costco-us": () => [
    { warehouse_id: "9301", name: "Costco Fake Fairgrounds", distance_miles: 7.4 },
    { warehouse_id: "9302", name: "Costco Fake Old Mill", distance_miles: 33.7 },
  ],
  "delicious_zebu/amazon-product-data-scraper": (input) => {
    const rows = [
      {
        asin: "B0FAKE0001",
        title: "Sample Creamy Peanut Butter, 16 oz",
        brand: "Sample",
        price_value: 3.49,
        list_price_value: 3.99,
        coupon: "Save $0.50 with coupon",
        url: "https://www.amazon.com/dp/B0FAKE0001",
      },
      {
        asin: "B0FAKE0002",
        title: "Fake Home Paper Towels, 6 rolls",
        price_value: 9.99,
        url: "https://www.amazon.com/dp/B0FAKE0002",
      },
    ];
    const asked = words(input, "Keywords");
    const byAsin = rows.filter((row) => asked.includes(row.asin));
    return byAsin.length > 0 ? byAsin : rows;
  },
  "gratifying_graph/us-grocery-deals": (input) => {
    const rows = [
      {
        merchant: "Hilltop Fake Market",
        name: "Hilltop Ground Beef, per lb",
        salePrice: 3.99,
        regularPrice: 5.29,
        validFrom: "2026-11-11",
        validTo: "2026-11-17",
      },
      {
        merchant: "Target",
        name: "Large Eggs, 12 ct",
        salePrice: "2.99",
        regularPrice: null,
        validFrom: "2026-11-09T00:00:00-05:00",
        validTo: "2026-11-15T23:59:59-05:00",
      },
      {
        merchant: "Aldi",
        name: "ALDI Finds Fake Skillet",
        salePrice: 14.99,
        validFrom: "2026-11-12",
        validTo: "2026-11-18",
      },
    ];
    return input.onlyWithPrice === true
      ? rows
      : [...rows, { merchant: "Target", name: "25% off toys" }];
  },
};

// Made-up run costs, in dollars, near the ones spec 15 measured.
const FAKE_RUN_USD = 0.0123;

export class FakeApify extends FakeJsonServer {
  readonly rows: Record<string, ActorRows> = { ...FAKE_ACTOR_ROWS };
  // Each Actor's run status, when not "SUCCEEDED".
  readonly runStatus = new Map<string, FakeRunStatus>();
  // Each Actor's run cost, in dollars, when not the default. Null leaves it out of the run record.
  readonly runUsd = new Map<string, number | null>();
  // In a dev run, any token is accepted but one that holds "wrong", so a Member can save one.
  acceptAnyKey = false;
  private readonly tokens = new Set<string>();
  private readonly runs = new Map<string, FakeRun>();
  private readonly datasets = new Map<string, Record<string, unknown>[]>();

  // A made-up token, which this server accepts.
  newToken(): string {
    const token = `apify_api_fake_${crypto.randomUUID().replaceAll("-", "")}`;
    this.tokens.add(token);
    return token;
  }

  // The inputs of every run of one Actor, in order.
  inputsOf(actor: string): Record<string, unknown>[] {
    return this.to(`/v2/acts/${actor.replace("/", "~")}/runs`).map(
      (request) => request.body as Record<string, unknown>,
    );
  }

  private accepts(token: string): boolean {
    return this.tokens.has(token) || (this.acceptAnyKey && !token.includes("wrong"));
  }

  protected answerFor(request: FakeRequest): FakeAnswer {
    const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
    if (bearer === undefined || !this.accepts(bearer)) {
      return {
        status: 401,
        body: { error: { type: "token-not-valid", message: "Fake: bad token" } },
      };
    }
    if (request.method === "GET" && request.path === "/v2/users/me") {
      return {
        body: { data: { id: "fakeUser0001", username: "fake-user", plan: { id: "FREE" } } },
      };
    }
    const start = /^\/v2\/acts\/([^/]+)\/runs$/.exec(request.path);
    if (request.method === "POST" && start?.[1] !== undefined) {
      return this.startRun(start[1].replace("~", "/"), request);
    }
    const run = /^\/v2\/actor-runs\/([A-Za-z0-9]+)(\/abort)?$/.exec(request.path);
    if (run?.[1] !== undefined) {
      const found = this.runs.get(run[1]);
      if (found === undefined)
        return { status: 404, body: { error: { type: "record-not-found" } } };
      if (run[2] !== undefined && request.method === "POST") found.status = "ABORTED";
      return { body: { data: found } };
    }
    const items = /^\/v2\/datasets\/([A-Za-z0-9]+)\/items$/.exec(request.path);
    if (request.method === "GET" && items?.[1] !== undefined) {
      const rows = this.datasets.get(items[1]);
      if (rows === undefined) return { status: 404, body: { error: { type: "record-not-found" } } };
      return { body: rows };
    }
    return { status: 404, body: { error: { type: "page-not-found" } } };
  }

  private startRun(actor: string, request: FakeRequest): FakeAnswer {
    const rowsOf = this.rows[actor];
    if (rowsOf === undefined) return { status: 404, body: { error: { type: "record-not-found" } } };
    if (request.query.maxTotalChargeUsd !== "1.00") {
      return {
        status: 400,
        body: { error: { type: "invalid-input", message: "Fake: no charge cap" } },
      };
    }
    const id = `fakeRun${this.runs.size + 1}`;
    const datasetId = `fakeData${this.runs.size + 1}`;
    const input = typeof request.body === "object" && request.body !== null ? request.body : {};
    this.datasets.set(datasetId, rowsOf(input as Record<string, unknown>));
    const usd = this.runUsd.has(actor) ? this.runUsd.get(actor) : FAKE_RUN_USD;
    const run: FakeRun = {
      id,
      actId: actor.replace("/", "~"),
      status: this.runStatus.get(actor) ?? "SUCCEEDED",
      defaultDatasetId: datasetId,
      usageTotalUsd: usd ?? Number.NaN,
    };
    if (usd === null) Reflect.deleteProperty(run, "usageTotalUsd");
    this.runs.set(id, run);
    return { status: 201, body: { data: run } };
  }
}
