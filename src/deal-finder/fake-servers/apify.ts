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
  options: { memoryMbytes: number; maxTotalChargeUsd: number };
  pricingInfo?: {
    pricingModel: "PAY_PER_EVENT";
    pricingPerEvent: { actorChargeEvents: Record<string, { eventPriceUsd: number }> };
  };
  chargedEventCounts: Record<string, number>;
  usageTotalUsd: number;
};

// One Actor's made-up pay-per-event price list, near the one the owner's run measured
// (2026-11-12). The start event is charged as the run starts: Apify's own `apify-actor-start` once
// for each GB of the run's memory, an Actor's own once. The row event is charged for each dataset
// row, and `perRun` events once a run, both only after the run ends: a run record read at the end
// shows only the start events, and a later read shows the rest.
export type FakePricing = {
  memoryMbytes: number;
  prices: Record<string, number>;
  start: string | null;
  row: string | null;
  perRun?: string;
};

const START = "apify-actor-start";
const ROW = "apify-default-dataset-item";
const priced = (
  memoryMbytes: number,
  start: [string, number] | null,
  row: [string, number] | null,
  perRun?: [string, number],
): FakePricing => ({
  memoryMbytes,
  prices: Object.fromEntries([start, row, perRun ?? null].filter((each) => each !== null)),
  start: start?.[0] ?? null,
  row: row?.[0] ?? null,
  ...(perRun === undefined ? {} : { perRun: perRun[0] }),
});

// Each Actor's made-up price list.
export const FAKE_ACTOR_PRICING: Record<string, FakePricing> = {
  "burbn/walmart-product-search": priced(4096, [START, 0.02], [ROW, 0.02]),
  "litescrape/target-search": priced(1024, null, null, ["request", 0.00025]),
  "apify/e-commerce-scraping-tool": priced(1024, [START, 0.001], [ROW, 0.004]),
  "axlymxp/target-store-scraper": priced(1024, [START, 0.005], [ROW, 0.002]),
  "blackfalcondata/aldi-us-scraper": priced(1024, [START, 0.001], [ROW, 0.0029]),
  "vant47/costco-scraper": priced(1024, [START, 0.001], ["product", 0.0048]),
  "dromb/costco-us": priced(1024, [START, 0.001], [ROW, 0.001]),
  "delicious_zebu/amazon-product-data-scraper": priced(1024, [START, 0.001], [ROW, 0.00234]),
  "gratifying_graph/us-grocery-deals": priced(
    1024,
    ["actor-start", 0.0005],
    ["deal-result", 0.002],
  ),
};

// The events a run is charged: at its end, or once the row events are in.
function chargedEvents(pricing: FakePricing, rows: number, ended: boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  if (pricing.start !== null) {
    counts[pricing.start] = pricing.start === START ? Math.ceil(pricing.memoryMbytes / 1024) : 1;
  }
  if (!ended) {
    if (pricing.row !== null) counts[pricing.row] = rows;
    if (pricing.perRun !== undefined) counts[pricing.perRun] = 1;
  }
  return counts;
}

const usdOf = (pricing: FakePricing, counts: Record<string, number>) =>
  Math.round(
    Object.entries(counts).reduce(
      (sum, [event, count]) => sum + (pricing.prices[event] ?? 0) * count * 1e9,
      0,
    ),
  ) / 1e9;

const ENDED_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

// The run statuses a test can set for an Actor. "RUNNING" never ends.
export type FakeRunStatus = "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT" | "RUNNING";

const words = (input: Record<string, unknown>, field: string): string[] => {
  const value = input[field];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
};

// One made-up Costco warehouse row, in `dromb/costco-us`'s real shape.
const fakeWarehouse = (number: string, letters: string, name: string, miles: number) => ({
  id: number,
  warehouse_id: `${number}-${letters}`,
  record_type: "warehouse",
  name,
  distance_miles: miles,
  address: {
    street: "1 Fake Street",
    city: "Faketown",
    state: "ZZ",
    postal_code: "00000",
    country: "US",
  },
  latitude: 0,
  longitude: 0,
});

// One made-up Deal row, in `gratifying_graph/us-grocery-deals`'s real search shape.
const fakeDeal = (
  merchant: string,
  name: string,
  currentPrice: number,
  discount: number,
  dates: { validFrom: string; validTo: string },
) => ({
  dealId: `fake-deal-${name.length}-${merchant.length}`,
  mode: "search",
  query: "fake",
  zipCode: "00000",
  name,
  brand: null,
  merchant,
  merchantId: `fake-${merchant.length}`,
  currentPrice,
  discount,
  currency: "USD",
  flyerId: "fake-flyer",
  flyerName: `${merchant} Fake Weekly Ad`,
  flyerCategories: ["Groceries"],
  ...dates,
  imageUrl: null,
  source: "fake",
  fetchedAt: "2026-11-11T12:00:00Z",
});

// One made-up Walmart row, in `burbn/walmart-product-search`'s real shape (the owner's run,
// 2026-11-11): in stock, not an ad, and sold at the store for pickup and delivery, unless changed.
const fakeWalmartRow = (
  usItemId: string,
  title: string,
  price: number,
  changes: Record<string, unknown> = {},
) => ({
  productId: `FAKE${usItemId}`,
  usItemId,
  title,
  description: null,
  brand: null,
  url: `https://www.walmart.com/ip/fake/${usItemId}`,
  image: null,
  thumbnail: null,
  price,
  listPrice: null,
  currency: "USD",
  currencySymbol: "$",
  priceDisplay: `$${price.toFixed(2)}`,
  minPrice: null,
  maxPrice: null,
  savingsAmount: null,
  pricePerUnitAmount: null,
  pricePerUnitType: null,
  primaryOffer: { offer_id: `fake-offer-${usItemId}`, offer_price: price, min_price: null },
  rating: 4.5,
  reviewCount: 12,
  availability: "IN_STOCK",
  outOfStock: false,
  preorder: false,
  seller: "Walmart.com",
  sellerId: "fake-seller",
  pickup: true,
  deliveryFromStore: true,
  shipping: true,
  shippingDays: 2,
  twoDayShipping: true,
  freeShipping: false,
  freeShippingWithWalmartPlus: true,
  sponsored: false,
  multipleOptionsAvailable: false,
  badgeFlags: [],
  bestSeller: false,
  position: 1,
  ...changes,
});

// Each Actor's made-up rows.
export const FAKE_ACTOR_ROWS: Record<string, ActorRows> = {
  // One page of a search, with the rows the reader drops: a paid ad, one out of stock, and one a
  // marketplace seller ships, which the store does not sell.
  "burbn/walmart-product-search": (input) =>
    typeof input.query !== "string" || input.query.trim() === ""
      ? []
      : [
          fakeWalmartRow("990000199", "Sponsored Fake Snack", 1.5, { sponsored: true }),
          fakeWalmartRow("990000101", "Sample Creamy Peanut Butter, 16 oz", 2.78, {
            brand: "Sample",
            url: "https://www.walmart.com/ip/sample-creamy-peanut-butter/990000101",
          }),
          fakeWalmartRow("990000102", "Fake Valley Large Eggs, 12 ct", 3.12, {
            listPrice: 3.48,
            url: "/ip/fake-valley-large-eggs/990000102",
          }),
          fakeWalmartRow("990000198", "Fake Valley Brown Eggs, 12 ct", 3.98, {
            availability: "OUT_OF_STOCK",
            outOfStock: true,
          }),
          fakeWalmartRow("990000197", "Fake Import Peanut Butter, 3 Pack", 19.99, {
            seller: "Fake Marketplace Seller",
            pickup: false,
            deliveryFromStore: false,
          }),
        ],
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
  // The real warehouse rows' shape: `id` is the warehouse number, `warehouse_id` the number, a dash
  // and 2 letters.
  "dromb/costco-us": () => [
    fakeWarehouse("9301", "fa", "Costco Fake Fairgrounds", 7.4),
    fakeWarehouse("9302", "om", "Costco Fake Old Mill", 33.7),
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
  // The real Deal rows' shape: `currentPrice` is the sale price, and `discount` the dollars off.
  "gratifying_graph/us-grocery-deals": (input) => {
    const rows = [
      fakeDeal("Hilltop Fake Market", "Hilltop Ground Beef, per lb", 3.99, 1.3, {
        validFrom: "2026-11-11",
        validTo: "2026-11-17",
      }),
      fakeDeal("Target", "Large Eggs, 12 ct", 2.99, 0, {
        validFrom: "2026-11-09T00:00:00-05:00",
        validTo: "2026-11-15T23:59:59-05:00",
      }),
      fakeDeal("ALDI", "ALDI Finds Fake Skillet", 14.99, 0, {
        validFrom: "2026-11-12",
        validTo: "2026-11-18",
      }),
      fakeDeal("Sam's Club", "Fake Member Mark Whole Milk, 1 gal", 3.48, 0.5, {
        validFrom: "2026-11-10",
        validTo: "2026-11-16",
      }),
    ];
    return input.onlyWithPrice === true
      ? rows
      : [...rows, { merchant: "Target", name: "25% off toys" }];
  },
};

export class FakeApify extends FakeJsonServer {
  readonly rows: Record<string, ActorRows> = { ...FAKE_ACTOR_ROWS };
  // Each Actor's run status, when not "SUCCEEDED".
  readonly runStatus = new Map<string, FakeRunStatus>();
  // Each Actor's price list, when not its default. Null leaves it out of the run record.
  readonly pricing = new Map<string, FakePricing | null>();
  // In a dev run, any token is accepted but one that holds "wrong", so a Member can save one.
  acceptAnyKey = false;
  private readonly tokens = new Set<string>();
  private readonly runs = new Map<string, FakeRun>();
  // Each run's price list and rows, and whether its record was read since it ended. The row
  // events show only on a read after that.
  private readonly charges = new Map<
    string,
    { pricing: FakePricing | null; rows: number; readAtEnd: boolean }
  >();
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
      return { body: { data: this.recordOf(found) } };
    }
    const dataset = /^\/v2\/datasets\/([A-Za-z0-9]+)$/.exec(request.path);
    if (request.method === "GET" && dataset?.[1] !== undefined) {
      const rows = this.datasets.get(dataset[1]);
      if (rows === undefined) return { status: 404, body: { error: { type: "record-not-found" } } };
      return { body: { data: { id: dataset[1], itemCount: rows.length } } };
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
    const rows = this.datasets.get(datasetId)?.length ?? 0;
    const pricing = this.pricing.has(actor)
      ? (this.pricing.get(actor) ?? null)
      : (FAKE_ACTOR_PRICING[actor] ?? null);
    const run: FakeRun = {
      id,
      actId: actor.replace("/", "~"),
      status: this.runStatus.get(actor) ?? "SUCCEEDED",
      defaultDatasetId: datasetId,
      options: { memoryMbytes: pricing?.memoryMbytes ?? 1024, maxTotalChargeUsd: 1 },
      chargedEventCounts: {},
      usageTotalUsd: 0,
    };
    this.runs.set(id, run);
    this.charges.set(id, { pricing, rows, readAtEnd: false });
    return { status: 201, body: { data: this.recordOf(run) } };
  }

  // A run's record as Apify answers it now: at its end, only the start events are charged, and on a
  // later read the row events too. A running run has charged its start events.
  private recordOf(run: FakeRun): FakeRun {
    const charge = this.charges.get(run.id);
    if (charge === undefined || charge.pricing === null) {
      const { pricingInfo: _none, ...record } = run;
      return record;
    }
    const ended = ENDED_STATUSES.has(run.status);
    const atEnd = !ended || !charge.readAtEnd;
    if (ended) charge.readAtEnd = true;
    const counts = chargedEvents(charge.pricing, charge.rows, atEnd);
    return {
      ...run,
      pricingInfo: {
        pricingModel: "PAY_PER_EVENT",
        pricingPerEvent: {
          actorChargeEvents: Object.fromEntries(
            Object.entries(charge.pricing.prices).map(([event, usd]) => [
              event,
              { eventPriceUsd: usd },
            ]),
          ),
        },
      },
      chargedEventCounts: counts,
      usageTotalUsd: usdOf(charge.pricing, counts),
    };
  }
}
