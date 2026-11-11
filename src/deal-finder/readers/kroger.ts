import { type Logger, registerSecretValue } from "../../log.ts";
import {
  type Costed,
  type FoundStore,
  PriceSourceError,
  type ProductRead,
  type StoreLocation,
} from "../adapter.ts";
import type { FindStoresMiles } from "../view.ts";
import { checkedProduct, cutText, readKeyOf } from "./checks.ts";
import { callSource, isRecord, recordsIn, type SourceAnswer } from "./http.ts";

// The Kroger reader (spec 15, Stores and their readers): Kroger's public API, with a
// client-credentials token of scope `product.compact`. It finds Kroger-family Store locations near
// a ZIP code, and reads Products with their regular and promo prices at one location. The API is
// free, so no call reports a cost.

export const KROGER_BASE_URL = "https://api.kroger.com";

// Kroger allows 10,000 Products calls a day. The app stops at 5,000 (spec 15, Cost and limits).
export const KROGER_PRODUCT_CALLS_A_DAY = 5_000;
// Locations to pick from: up to 10 nearest (spec 15, Find Stores near us).
const MAX_LOCATIONS = 10;
// The radii it asks in turn, nearest first, up to the Member's distance (spike round 9: none
// within 10 miles, 2 within 50).
const RADII: readonly FindStoresMiles[] = [10, 25, 50];
// A token is used until a minute before Kroger says it expires.
const TOKEN_MARGIN_MS = 60_000;
const TIMEOUT_MS = 15_000;
// The API takes up to 50 Products a call.
const MAX_PRODUCTS = 50;

// A Kroger location ID and Product ID, in the forms Kroger gives.
const LOCATION_ID = /^[0-9A-Za-z]{1,20}$/;
const PRODUCT_ID = /^\d{1,20}$/;

export type KrogerKeys = { clientId: string; clientSecret: string };

// The count of Products calls on one day. Shared by every Kroger reader call in the app, and
// reserved before the call is sent, so parallel calls cannot pass the cap together (K18).
export type KrogerCallCount = { day: string; calls: number };

const refusedKeys = () => new PriceSourceError("refused key", "Kroger refused the keys.");

export class KrogerReader {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly count: KrogerCallCount;
  private readonly timeoutMs: number;
  // The token for each client ID and secret, and the request for one in flight.
  private readonly tokens = new Map<string, Promise<{ token: string; expiresAt: number }>>();

  constructor(options: {
    baseUrl: string;
    logger: Logger;
    now?: () => Date;
    count?: KrogerCallCount;
    timeoutMs?: number;
  }) {
    this.baseUrl = options.baseUrl;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.count = options.count ?? { day: "", calls: 0 };
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  // A token request. Kroger's own answer to the keys, for Test.
  async checkKeys(keys: KrogerKeys): Promise<Costed<true>> {
    this.tokens.delete(this.tokenKey(keys));
    await this.token(keys);
    return { value: true, costNanos: null };
  }

  // Kroger-family locations within the distance, nearest first. It asks within 10 miles, then
  // each wider radius up to the distance, until it has 10. A location with no departments is not a
  // grocery store, so it is skipped. Kroger gives no distance, so each location's distance is the
  // radius it was first found within.
  async findLocations(input: {
    zipCode: string;
    distanceMiles: FindStoresMiles;
    keys: KrogerKeys;
  }): Promise<FoundStore> {
    const found: StoreLocation[] = [];
    for (const radius of RADII.filter((miles) => miles <= input.distanceMiles)) {
      const params = new URLSearchParams({
        "filter.zipCode.near": input.zipCode,
        "filter.radiusInMiles": String(radius),
        "filter.limit": "50",
      });
      const answer = await this.get(input.keys, `/v1/locations?${params}`, false);
      for (const row of recordsIn(isRecord(answer.body) ? answer.body.data : null)) {
        const id = readKeyOf(row.locationId, LOCATION_ID);
        const departments = Array.isArray(row.departments) ? row.departments.length : 0;
        if (id === null || departments === 0 || found.some((place) => place.id === id)) continue;
        const name = cutText(row.name) ?? cutText(row.chain) ?? "Kroger";
        found.push({ id, name, distanceMiles: radius });
      }
      if (found.length >= MAX_LOCATIONS) break;
    }
    return {
      id: "kroger",
      name: "Kroger",
      kind: "in person",
      reader: "Store API",
      locations: found.slice(0, MAX_LOCATIONS),
    };
  }

  // Products for the words at one location, in Kroger's own order. A brand lock is in the words,
  // and in Kroger's brand filter.
  async search(input: {
    locationId: string;
    words: string;
    brand: string | null;
    productCount: number;
    keys: KrogerKeys;
  }): Promise<Costed<ProductRead[]>> {
    const locationId = readKeyOf(input.locationId, LOCATION_ID);
    if (locationId === null) return { value: [], costNanos: null };
    const params = new URLSearchParams({
      "filter.term": input.words,
      "filter.locationId": locationId,
      "filter.limit": String(Math.min(Math.max(1, input.productCount), MAX_PRODUCTS)),
    });
    if (input.brand !== null) params.set("filter.brand", input.brand);
    const answer = await this.get(input.keys, `/v1/products?${params}`, true);
    const rows = recordsIn(isRecord(answer.body) ? answer.body.data : null);
    const products = rows.flatMap((row) => {
      const product = krogerProduct(row);
      return product === null ? [] : [product];
    });
    return { value: products.slice(0, input.productCount), costNanos: null };
  }

  // One Product at one location, by its Kroger product ID. Null when Kroger no longer has it.
  async read(input: {
    locationId: string;
    productId: string;
    keys: KrogerKeys;
  }): Promise<Costed<ProductRead | null>> {
    const locationId = readKeyOf(input.locationId, LOCATION_ID);
    const productId = readKeyOf(input.productId, PRODUCT_ID);
    if (locationId === null || productId === null) return { value: null, costNanos: null };
    const params = new URLSearchParams({ "filter.locationId": locationId });
    const answer = await this.get(input.keys, `/v1/products/${productId}?${params}`, true);
    if (answer.status === 404) return { value: null, costNanos: null };
    const row = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : null;
    const product = row === null ? null : krogerProduct(row);
    return { value: product?.readKey === productId ? product : null, costNanos: null };
  }

  private tokenKey(keys: KrogerKeys): string {
    return JSON.stringify([keys.clientId, keys.clientSecret]);
  }

  // The token for these keys: the saved one until it is a minute from expiry, else a new one. One
  // request is in flight at a time for the same keys.
  private async token(keys: KrogerKeys): Promise<string> {
    const key = this.tokenKey(keys);
    const saved = this.tokens.get(key);
    if (saved !== undefined) {
      const held = await saved.catch(() => null);
      if (held !== null && held.expiresAt > this.now().getTime()) return held.token;
      if (this.tokens.get(key) === saved) this.tokens.delete(key);
    }
    let pending = this.tokens.get(key);
    if (pending === undefined) {
      const asked = this.requestToken(keys);
      // A failed request is not kept, so the next call asks again.
      asked.catch(() => {
        if (this.tokens.get(key) === asked) this.tokens.delete(key);
      });
      this.tokens.set(key, asked);
      pending = asked;
    }
    return (await pending).token;
  }

  private async requestToken(keys: KrogerKeys): Promise<{ token: string; expiresAt: number }> {
    const basic = Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString("base64");
    const answer = await callSource(
      new URL("/v1/connect/oauth2/token", this.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials&scope=product.compact",
      },
      this.timeoutMs,
    );
    if (answer.status !== 200) throw this.failure("token", answer);
    const body = isRecord(answer.body) ? answer.body : {};
    const token = typeof body.access_token === "string" ? body.access_token : "";
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 0;
    if (token === "" || !Number.isFinite(seconds) || seconds <= 0) {
      throw new PriceSourceError("store failed", "Kroger sent no token.");
    }
    registerSecretValue(token);
    return { token, expiresAt: this.now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
  }

  // Takes one of the day's Products calls, in the same synchronous step as the check, before the
  // first await.
  private takeProductCall(): void {
    const day = this.now().toISOString().slice(0, 10);
    if (this.count.day !== day) {
      this.count.day = day;
      this.count.calls = 0;
    }
    if (this.count.calls >= KROGER_PRODUCT_CALLS_A_DAY) {
      throw new PriceSourceError("usage limit", "The app's daily Kroger Products calls are used.");
    }
    this.count.calls += 1;
  }

  // A GET with the token. A refused token is asked for again once, since Kroger can end one early.
  // Each Products call sent counts toward the day's cap, the second try too.
  private async get(keys: KrogerKeys, path: string, productsCall: boolean): Promise<SourceAnswer> {
    for (let attempt = 1; ; attempt += 1) {
      if (productsCall) this.takeProductCall();
      const token = await this.token(keys);
      const answer = await callSource(
        new URL(path, this.baseUrl),
        {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        },
        this.timeoutMs,
      );
      if (answer.status === 200 || (answer.status === 404 && productsCall)) return answer;
      if (answer.status === 401 && attempt === 1) {
        this.tokens.delete(this.tokenKey(keys));
        continue;
      }
      throw this.failure(productsCall ? "products" : "locations", answer);
    }
  }

  // Kroger's answer, mapped to its own error. Only the status is logged.
  private failure(call: string, answer: SourceAnswer): PriceSourceError {
    this.logger.warn("Kroger refused a call", { call, status: answer.status });
    if (answer.status === 400 && call === "token") return refusedKeys();
    if (answer.status === 401 || answer.status === 403) return refusedKeys();
    if (answer.status === 429) {
      return new PriceSourceError("usage limit", "Kroger's usage limit was reached.");
    }
    if (answer.status === 408 || answer.status === 504) {
      return new PriceSourceError("timed out", "Kroger took too long to answer.");
    }
    return new PriceSourceError("store failed", "Kroger could not answer.");
  }
}

// One Kroger Product: its first item's size and prices. A promo of 0 means none.
function krogerProduct(row: Record<string, unknown>): ProductRead | null {
  const item = recordsIn(row.items)[0] ?? {};
  const price = isRecord(item.price) ? item.price : {};
  const promo = price.promo === 0 ? null : price.promo;
  const page = typeof row.productPageURI === "string" ? row.productPageURI : null;
  return checkedProduct("kroger", {
    readKey: readKeyOf(row.productId, PRODUCT_ID),
    name: row.description,
    brand: row.brand,
    size: item.size,
    upc: row.upc,
    link: page?.startsWith("/") && !page.startsWith("//") ? `https://www.kroger.com${page}` : null,
    regularPrice: price.regular,
    dealPrice: promo,
  });
}
