import { type FakeAnswer, FakeJsonServer, type FakeRequest } from "./server.ts";

// A fake Kroger public API on 127.0.0.1: the token, Locations and Products calls, in Kroger's
// shape (spike round 9). Every location, Product and price is made up. Its client keys are made
// when a test or dev run starts, never real ones.

export type FakeKrogerLocation = {
  locationId: string;
  name: string;
  chain: string;
  departments: { departmentId: string; name: string }[];
  // How far it is from any ZIP code. Kroger sends no distance; the fake uses it for the radius.
  miles: number;
};

export type FakeKrogerProduct = {
  productId: string;
  upc: string;
  brand: string;
  description: string;
  productPageURI: string;
  items: { itemId: string; size: string; price?: { regular: number; promo: number } }[];
};

const grocery = [{ departmentId: "01", name: "Grocery" }];

export const FAKE_KROGER_LOCATIONS: FakeKrogerLocation[] = [
  // The nearest one has no departments: it is not a grocery store, as in spike round 9.
  {
    locationId: "FAKE0100",
    name: "Kroger Fake Fuel Center",
    chain: "KROGER",
    departments: [],
    miles: 3,
  },
  {
    locationId: "FAKE0101",
    name: "Kroger Fake Maple Avenue",
    chain: "KROGER",
    departments: grocery,
    miles: 8,
  },
  {
    locationId: "FAKE0102",
    name: "Kroger Fake Orchard Road",
    chain: "KROGER",
    departments: grocery,
    miles: 21,
  },
  {
    locationId: "FAKE0103",
    name: "Kroger Fake Granite Hill",
    chain: "KROGER",
    departments: grocery,
    miles: 44,
  },
];

export const FAKE_KROGER_PRODUCTS: FakeKrogerProduct[] = [
  {
    productId: "0009990000101",
    upc: "0009990000101",
    brand: "Sample",
    description: "Sample Creamy Peanut Butter",
    productPageURI: "/p/sample-creamy-peanut-butter/0009990000101",
    items: [{ itemId: "0009990000101", size: "16 oz", price: { regular: 2.99, promo: 2.49 } }],
  },
  {
    productId: "0009990000102",
    upc: "0009990000102",
    brand: "Fake Farms",
    description: "Fake Farms Peanut Butter Crunchy",
    productPageURI: "/p/fake-farms-peanut-butter-crunchy/0009990000102",
    items: [{ itemId: "0009990000102", size: "40 oz", price: { regular: 7.29, promo: 0 } }],
  },
  {
    productId: "0009990000103",
    upc: "0009990000103",
    brand: "Fake Farms",
    description: "Fake Farms Large Eggs",
    productPageURI: "/p/fake-farms-large-eggs/0009990000103",
    items: [{ itemId: "0009990000103", size: "12 ct", price: { regular: 3.89, promo: 0 } }],
  },
];

const failure = (status: number, reason: string): FakeAnswer => ({
  status,
  body: { errors: { reason, code: `fake-${status}`, timestamp: 0 } },
});

export class FakeKroger extends FakeJsonServer {
  readonly locations = [...FAKE_KROGER_LOCATIONS];
  readonly products = [...FAKE_KROGER_PRODUCTS];
  // Seconds each token lasts, as in the spike.
  expiresIn = 1800;
  // In a dev run, any keys are accepted but ones that hold "wrong", so a Member can save them.
  acceptAnyKey = false;
  private readonly clients = new Map<string, string>();
  private readonly tokens = new Set<string>();

  // Made-up client keys, which this server accepts.
  newKeys(): { clientId: string; clientSecret: string } {
    const keys = {
      clientId: `fake-kroger-client-${crypto.randomUUID()}`,
      clientSecret: `fake-kroger-secret-${crypto.randomUUID()}`,
    };
    this.clients.set(keys.clientId, keys.clientSecret);
    return keys;
  }

  // Ends every token, as if each expired.
  endTokens(): void {
    this.tokens.clear();
  }

  protected answerFor(request: FakeRequest): FakeAnswer {
    if (request.method === "POST" && request.path === "/v1/connect/oauth2/token") {
      return this.token(request);
    }
    const bearer = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
    if (bearer === undefined || !this.tokens.has(bearer)) return failure(401, "Unauthorized");
    if (request.method !== "GET") return failure(405, "Method not allowed");
    if (request.path === "/v1/locations") return this.findLocations(request.query);
    if (request.path === "/v1/products") return this.search(request.query);
    const one = /^\/v1\/products\/(\d+)$/.exec(request.path);
    if (one?.[1] !== undefined) {
      const product = this.products.find((each) => each.productId === one[1]);
      if (product === undefined) return failure(404, "Not found");
      return { body: { data: this.priced(product, request.query["filter.locationId"]) } };
    }
    return failure(404, "Not found");
  }

  private token(request: FakeRequest): FakeAnswer {
    const basic = /^Basic (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
    const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
    const form = new URLSearchParams(request.text);
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("scope") !== "product.compact"
    ) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const anyKey = this.acceptAnyKey && secret !== undefined && !`${id}${secret}`.includes("wrong");
    if (id === undefined || (this.clients.get(id) !== secret && !anyKey)) {
      return { status: 401, body: { error: "invalid_client" } };
    }
    const token = `fake-kroger-token-${crypto.randomUUID()}`;
    this.tokens.add(token);
    return { body: { access_token: token, expires_in: this.expiresIn, token_type: "bearer" } };
  }

  private findLocations(query: Record<string, string>): FakeAnswer {
    const radius = Number(query["filter.radiusInMiles"] ?? "10");
    const limit = Number(query["filter.limit"] ?? "10");
    if (!/^\d{5}$/.test(query["filter.zipCode.near"] ?? "")) return failure(400, "Bad ZIP code");
    const near = this.locations
      .filter((place) => place.miles <= radius)
      .sort((a, b) => a.miles - b.miles)
      .slice(0, limit)
      .map(({ miles: _miles, ...place }) => place);
    return { body: { data: near, meta: { pagination: { start: 0, limit, total: near.length } } } };
  }

  private search(query: Record<string, string>): FakeAnswer {
    const words = (query["filter.term"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const brand = query["filter.brand"];
    const limit = Number(query["filter.limit"] ?? "10");
    const found = this.products
      .filter((product) => words.every((word) => product.description.toLowerCase().includes(word)))
      .filter((product) => brand === undefined || product.brand === brand)
      .slice(0, limit)
      .map((product) => this.priced(product, query["filter.locationId"]));
    return {
      body: { data: found, meta: { pagination: { start: 0, limit, total: found.length } } },
    };
  }

  // A Product has a price only at a location.
  private priced(product: FakeKrogerProduct, locationId: string | undefined) {
    if (locationId !== undefined) return product;
    return { ...product, items: product.items.map(({ price: _price, ...item }) => item) };
  }
}
