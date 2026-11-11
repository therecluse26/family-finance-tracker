import { Hono } from "hono";
import * as z from "zod";
import {
  type FindStoresOutcome,
  KEYED_PRICE_SOURCES,
  MAX_DELIVERY_CENTS,
  MAX_PRICE_SOURCE_COST_CAP_CENTS,
  MAX_STORES_ON,
  type PriceSourceTestOutcome,
  type StoreChangeOutcome,
} from "../deal-finder/view.ts";
import type { ServerEnv } from "./env.ts";

// Settings → Price sources (spec 15, The Price sources page in Settings). The API mounts these
// routes; its session and Origin checks run first, and the app's check before /api/price-sources/
// refuses every write until the first-run wizard is done, and any body that is not JSON. No answer
// and no error ever holds a key: only its last 4 characters.

// A key as a source's dashboard shows it. A refusal never quotes it.
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._~+/=-]{8,200}$/)
  .refine((key) => key.trim() === key);

const apifyBody = z.strictObject({ token: KEY });
const krogerBody = z.strictObject({ clientId: KEY, clientSecret: KEY });
const emptyBody = z.strictObject({});
const switchBody = z.strictObject({ on: z.boolean() });
// The distance, in the exact form it is stored: the number 10, 25 or 50.
const findBody = z.strictObject({
  distanceMiles: z.union([z.literal(10), z.literal(25), z.literal(50)]),
});
const amount = z.number().int().min(0).max(MAX_DELIVERY_CENTS).nullable();
const storeBody = z
  .strictObject({
    on: z.boolean().optional(),
    homeStoreId: z.string().min(1).max(100).optional(),
    deliveryFee: amount.optional(),
    freeDeliveryFrom: amount.optional(),
  })
  .refine((body) => Object.keys(body).length > 0);
const costCapBody = z.strictObject({
  capCents: z.number().int().min(0).max(MAX_PRICE_SOURCE_COST_CAP_CENTS),
});

const STORE_ID = /^[a-z0-9-]{1,60}$/;

// The body as JSON, or undefined when it is not JSON. A parse error is never read: it can quote
// the body, which can hold a key.
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const SOURCE_NAMES = { apify: "Apify", kroger: "Kroger" } as const;

const TEST_REFUSALS: Record<
  Exclude<PriceSourceTestOutcome["outcome"], "tested">,
  { status: 404 | 409; error: string }
> = {
  "no key": { status: 409, error: "Save a key first, then test it." },
  "no reader": { status: 404, error: "This version of the app has no reader for this source." },
  busy: { status: 409, error: "A test of this source is running. Wait for its answer." },
  changed: { status: 409, error: "The key changed during the test. Test again." },
};

const FIND_REFUSALS: Record<
  Exclude<FindStoresOutcome["outcome"], "found">,
  { status: 404 | 409 | 429 | 502; error: string }
> = {
  "zip off": { status: 409, error: "Turn on “Use our ZIP code to find stores” first." },
  "no zip code": { status: 409, error: "Add the Household's ZIP code in Settings → Household." },
  "no reader": { status: 404, error: "This version of the app has no Store reader." },
  busy: { status: 409, error: "Find Stores near us is running. Wait for its answer." },
  "refused key": { status: 409, error: "The Price source refused the saved key." },
  "usage limit": { status: 429, error: "Apify usage limit reached." },
  failed: { status: 502, error: "The Price source did not answer. Try again later." },
};

const STORE_REFUSALS: Record<
  Exclude<StoreChangeOutcome["outcome"], "changed">,
  { status: 400 | 404 | 409; error: string }
> = {
  "no store": { status: 404, error: "Not found" },
  "too many on": {
    status: 409,
    error: `At most ${MAX_STORES_ON} Stores can be on at once. Turn one off first.`,
  },
  "no such location": { status: 400, error: "Pick the Home store from this Store's list." },
};

export const priceSourcesApi = new Hono<ServerEnv>()
  .get("/price-sources", async (c) => c.json({ priceSources: await c.var.priceSources.view() }))
  // The Scraping service's API token. Saving it clears its last Test.
  .put("/price-sources/apify", async (c) => {
    const body = apifyBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Paste the Apify API token." }, 400);
    return c.json({ priceSources: await c.var.priceSources.saveApifyToken(body.data.token) }, 200);
  })
  // The Kroger API's client ID and client secret, saved together.
  .put("/price-sources/kroger", async (c) => {
    const body = krogerBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Paste the Kroger client ID and secret." }, 400);
    return c.json({ priceSources: await c.var.priceSources.saveKrogerKeys(body.data) }, 200);
  })
  // Test: one small call with the saved key. One Test of each source runs at a time.
  .post("/price-sources/:source/test", async (c) => {
    const source = KEYED_PRICE_SOURCES.find((name) => name === c.req.param("source"));
    if (source === undefined) return c.json({ error: "Not found" }, 404);
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const tested = await c.var.priceSources.test(source);
    if (tested.outcome !== "tested") {
      const { status, error } = TEST_REFUSALS[tested.outcome];
      return c.json({ error }, status);
    }
    const name = SOURCE_NAMES[source];
    const words = {
      passed: `${name} accepted the key.`,
      refused: source === "apify" ? "Apify refused the token." : "Kroger refused the keys.",
      "usage limit": "Apify usage limit reached.",
      "no answer": `${name} did not answer. Try again later.`,
    }[tested.check];
    return c.json({ check: tested.check, words, priceSources: tested.view }, 200);
  })
  .put("/price-sources/open-food-facts", async (c) => {
    const body = switchBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Turn Open Food Facts on or off." }, 400);
    return c.json({ priceSources: await c.var.priceSources.setOpenFoodFacts(body.data.on) }, 200);
  })
  // "Use our ZIP code to find stores". The page runs Find Stores near us when it turns it on.
  .put("/price-sources/zip", async (c) => {
    const body = switchBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Turn the ZIP code switch on or off." }, 400);
    return c.json({ priceSources: await c.var.priceSources.setUseZip(body.data.on) }, 200);
  })
  // Find Stores near us, within 10, 25 or 50 miles. One lookup runs at a time.
  .post("/price-sources/find-stores", async (c) => {
    const body = findBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Pick 10, 25 or 50 miles." }, 400);
    const found = await c.var.priceSources.findStores(body.data.distanceMiles);
    if (found.outcome !== "found") {
      const { status, error } = FIND_REFUSALS[found.outcome];
      return c.json({ error }, status);
    }
    return c.json({ priceSources: found.view }, 200);
  })
  // One Store's settings: ticked or not, its Home store, its delivery fee and free-delivery amount.
  .put("/price-sources/stores/:id", async (c) => {
    const id = c.req.param("id");
    if (!STORE_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const body = storeBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json(
        { error: "Send whether the Store is on, its Home store, or its delivery amounts." },
        400,
      );
    }
    const changed = await c.var.priceSources.changeStore(id, body.data);
    if (changed.outcome !== "changed") {
      const { status, error } = STORE_REFUSALS[changed.outcome];
      return c.json({ error }, status);
    }
    return c.json({ priceSources: changed.view }, 200);
  })
  .put("/price-sources/cost-cap", async (c) => {
    const body = costCapBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json(
        { error: "Enter the Price source cost cap in dollars, from $0 to $10,000." },
        400,
      );
    }
    return c.json({ priceSources: await c.var.priceSources.setCostCap(body.data.capCents) }, 200);
  })
  // "Delete all deal finder data", with an empty JSON body: every Product, price, match and plan.
  .post("/price-sources/delete-all", async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    return c.json({ priceSources: await c.var.priceSources.deleteAll() }, 200);
  });
