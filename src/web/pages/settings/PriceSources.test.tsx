import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceSourceStoreView, PriceSourcesView } from "../../../deal-finder/view.ts";
import {
  changeStore,
  deleteDealFinderData,
  deliveryChangesOf,
  deliveryText,
  findStores,
  milesText,
  PriceSourcesCards,
  StoreLine,
  type StoreLineProps,
  saveApifyToken,
  saveKrogerKeys,
  setOpenFoodFacts,
  setPriceSourceCostCap,
  setUseZip,
  testPriceSource,
} from "./PriceSources.tsx";

// Settings → Price sources (spec 15, The Price sources page in Settings), as the browser paints it,
// and the requests it sends. Every key, Store and location here is made up.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const EMPTY: PriceSourcesView = {
  apify: { tokenLast4: null, check: null, checkedAt: null },
  kroger: { clientIdLast4: null, clientSecretLast4: null, check: null, checkedAt: null },
  openFoodFacts: false,
  zip: { on: false, zipCode: "10001", changed: false },
  findDistanceMiles: 25,
  storesFoundAt: null,
  costCap: 500,
  monthCostNanos: 0,
  stores: [],
  data: { products: 0, priceReads: 0, matches: 0, plans: 0 },
};

const KROGER: PriceSourceStoreView = {
  id: "kroger",
  name: "Kroger",
  kind: "in person",
  reader: "Store API",
  on: true,
  needsZip: false,
  findAgain: false,
  notFound: null,
  earlierResult: false,
  homeStore: { id: "fake-kroger-0101", name: "Kroger, Maple Avenue" },
  distanceMiles: 2.4,
  locations: [
    { id: "fake-kroger-0101", name: "Kroger, Maple Avenue", distanceMiles: 2.4 },
    { id: "fake-kroger-0102", name: "Kroger, Orchard Road", distanceMiles: 6.8 },
  ],
  deliveryFee: null,
  freeDeliveryFrom: null,
  lastGoodReadAt: null,
};

// A Store with no Home store list, such as Walmart, priced by the ZIP code.
const store = (
  id: string,
  name: string,
  fields: Partial<PriceSourceStoreView> = {},
): PriceSourceStoreView => ({
  ...KROGER,
  id,
  name,
  reader: "Scraping service",
  on: false,
  homeStore: null,
  distanceMiles: null,
  locations: [],
  ...fields,
});

const FOUND: PriceSourcesView = {
  ...EMPTY,
  apify: { tokenLast4: "a1b2", check: "passed", checkedAt: "2026-11-11T14:00:00.000Z" },
  zip: { on: true, zipCode: "10001", changed: false },
  storesFoundAt: "2026-11-11T14:05:00.000Z",
  stores: [KROGER],
  data: { products: 3, priceReads: 9, matches: 2, plans: 1 },
};

const NOW = new Date("2026-11-11T18:00:00.000Z");

const html = (view: PriceSourcesView, editing = false) =>
  renderToString(
    <PriceSourcesCards
      view={view}
      busy={false}
      act={async () => true}
      zone="America/New_York"
      now={NOW}
      editing={editing}
    />,
  );
const page = (view: PriceSourcesView, editing = false) => text(html(view, editing));

const line = (fields: Partial<StoreLineProps> & Pick<StoreLineProps, "store">) =>
  renderToString(
    <StoreLine
      busy={false}
      act={async () => true}
      now={NOW}
      zone="America/New_York"
      zipOn={true}
      miles={25}
      {...fields}
    />,
  );

const ticksOf = (shown: string) =>
  [...shown.matchAll(/<input type="checkbox"[^>]*>/g)].map((tick) => tick[0]);

describe("Settings, Price sources", () => {
  it("shows the cards in order: Keys, Cost this month, Stores, Delete all deal finder data", () => {
    const shown = page(EMPTY);
    const at = (words: string) => shown.indexOf(words);

    expect(at("Keys")).toBeGreaterThan(-1);
    expect(at("Keys")).toBeLessThan(at("Cost this month"));
    expect(at("Cost this month")).toBeLessThan(at("Stores "));
    expect(at("Stores ")).toBeLessThan(at("Delete all deal finder data"));
  });

  it("shows no key, the ZIP code switch off with the ZIP code, and the $5.00 cap before anything is saved", () => {
    const shown = page(EMPTY);

    expect(shown).toContain("Apify token Not set Add");
    expect(shown).toContain("Kroger keys Not set Add");
    expect(shown).not.toContain("Test");
    expect(shown).toContain("Open Food Facts Ingredients and allergens by barcode.");
    expect(shown).toContain("Use our ZIP code to find stores (10001)");
    expect(shown).toContain("Off, Walmart, Target and Costco are read at their default stores");
    expect(shown).toContain("$0.00 of $5.00 cap Change cap");
    expect(shown).toContain("No Stores found yet.");
    // The key and cap fields open in place, only after Add, Change or Change cap.
    expect(shown).not.toContain("API token");
    expect(shown).not.toContain("Client secret");
    expect(shown).not.toContain("Price source cost cap");
  });

  it("asks for the Household's ZIP code first when there is none", () => {
    const shown = html({ ...EMPTY, zip: { on: false, zipCode: null, changed: false } });

    expect(text(shown)).toContain(
      "Use our ZIP code to find stores Add the Household's ZIP code in Settings → Household first.",
    );
    expect(ticksOf(shown)[1]).toContain("disabled");
  });

  it("shows a saved key only by its last 4 characters, with Test and what the last Test found", () => {
    const shown = page({
      ...FOUND,
      kroger: {
        clientIdLast4: "c1d2",
        clientSecretLast4: "9f3c",
        check: "refused",
        checkedAt: "2026-11-10T14:00:00.000Z",
      },
    });

    expect(shown).toContain("Apify token ending in …a1b2 ✓ Working · tested Nov 11 Test Change");
    expect(shown).toContain(
      "Kroger keys ending in …9f3c ◆ Kroger refused the keys · tested Nov 10 Test Change",
    );
    expect(shown).not.toContain("c1d2");
    expect(page({ ...FOUND, apify: { ...FOUND.apify, check: "refused" } })).toContain(
      "◆ Apify refused the token",
    );
    expect(page({ ...FOUND, apify: { ...FOUND.apify, check: null, checkedAt: null } })).toContain(
      "Apify token ending in …a1b2 Not tested yet Test Change",
    );
  });

  it("opens the key fields and the cost cap in place after Change", () => {
    const shown = page({ ...FOUND, costCap: 1250, monthCostNanos: 1_120_000_000 }, true);

    expect(shown).toContain("API token");
    expect(shown).toContain("Save token Cancel");
    expect(shown).toContain("Client ID Client secret");
    expect(shown).toContain("Save keys Cancel");
    expect(shown).toContain("$1.12 of $12.50 cap Change cap Price source cost cap");
    expect(shown).toContain("At the cap, plan runs use stored prices only, until the 1st.");
  });

  it("lists each Store on one line with its Home store, last good read and Change", () => {
    const shown = page({
      ...FOUND,
      stores: [{ ...KROGER, lastGoodReadAt: "2026-11-11T15:00:00.000Z" }],
    });

    expect(shown).toContain("Stores within 10 miles 25 miles");
    expect(shown).toContain("Last looked up Nov 11");
    expect(shown).toContain("Kroger Maple Avenue, 2.4 mi Read Nov 11 Change");
    expect(shown).not.toContain("Find again");
    expect(shown).not.toContain("Delivery");
  });

  it("asks for Find Stores near us again when the ZIP code changed", () => {
    expect(page({ ...FOUND, zip: { ...FOUND.zip, changed: true } })).toContain(
      "◆ Your ZIP code changed. Find Stores near us again.",
    );
  });

  it("lists Walmart as priced by the ZIP code, and the weekly ads as one row of ticks", () => {
    const shown = html({
      ...FOUND,
      stores: [
        KROGER,
        store("walmart", "Walmart", { on: true }),
        store("fake-ad-1", "Bluebird Market", { kind: "weekly ad only", on: true }),
        store("fake-ad-2", "Corner Grocer", { kind: "weekly ad only" }),
      ],
    });

    expect(text(shown)).toContain("Walmart Priced by ZIP code Not read yet");
    expect(text(shown)).toContain("Weekly ads (Deals only) Bluebird Market Corner Grocer");
    expect(shown.indexOf("Bluebird Market")).toBeGreaterThan(shown.indexOf("Weekly ads"));
  });
});

describe("Settings, Price sources: distances", () => {
  it("rounds a distance to one decimal, and shows none on a whole number", () => {
    expect(milesText(6.380895023524989)).toBe("6.4 mi");
    expect(milesText(50)).toBe("50 mi");
    expect(milesText(2.96)).toBe("3 mi");
    expect(milesText(0.04)).toBe("0 mi");
  });

  it("rounds the Home store's distance on its line and in the Home store list", () => {
    const costco = store("costco", "Costco", {
      on: true,
      homeStore: { id: "fake-costco-1", name: "North Canton" },
      distanceMiles: 6.380895023524989,
      locations: [
        { id: "fake-costco-1", name: "North Canton", distanceMiles: 6.380895023524989 },
        { id: "fake-costco-2", name: "Akron", distanceMiles: 50 },
      ],
    });
    const closed = text(line({ store: costco }));
    const opened = text(line({ store: costco, opened: "home store" }));

    expect(closed).toContain("Costco North Canton, 6.4 mi Not read yet Change");
    expect(closed).not.toContain("6.38");
    expect(closed).not.toContain("Home store");
    expect(opened).toContain("Home store North Canton, 6.4 mi Akron, 50 mi");
  });
});

describe("Settings, Price sources: delivery amounts", () => {
  const amazon = store("amazon", "Amazon", {
    kind: "online",
    on: true,
    deliveryFee: 699,
    freeDeliveryFrom: 3500,
  });

  it("shows delivery amounts only on an online Store", () => {
    const costco = text(line({ store: store("costco", "Costco"), opened: "delivery" }));
    const shown = text(line({ store: amazon }));

    expect(costco).not.toContain("Delivery");
    expect(costco).not.toContain("Edit");
    expect(shown).toContain("Amazon Online. Delivery $6.99, free from $35 Not read yet Edit");
    expect(shown).not.toContain("Delivery fee per order");
  });

  it("says Free delivery when both amounts are empty", () => {
    expect(deliveryText({ deliveryFee: null, freeDeliveryFrom: null })).toBe("Free delivery");
    expect(deliveryText({ deliveryFee: 0, freeDeliveryFrom: null })).toBe("Free delivery");
    expect(deliveryText({ deliveryFee: 599, freeDeliveryFrom: null })).toBe("Delivery $5.99");
    expect(deliveryText({ deliveryFee: 1000, freeDeliveryFrom: 2550 })).toBe(
      "Delivery $10, free from $25.50",
    );
  });

  it("opens both amounts in place after Edit, and saves both", () => {
    const shown = text(line({ store: amazon, opened: "delivery" }));

    expect(shown).toContain("Delivery fee per order");
    expect(shown).toContain("Free delivery on orders of");
    expect(shown).toContain(
      "The plan adds the fee to Amazon orders below the free-delivery amount. Leave both empty if your delivery is free, such as with Prime.",
    );
    expect(shown).toContain("Save Cancel");
    expect(deliveryChangesOf("6.99", "$35")).toEqual({ deliveryFee: 699, freeDeliveryFrom: 3500 });
    expect(deliveryChangesOf(" ", "")).toEqual({ deliveryFee: null, freeDeliveryFrom: null });
    expect(deliveryChangesOf("six", "")).toBeUndefined();
    expect(deliveryChangesOf("", "35.001")).toBeUndefined();
  });
});

describe("Settings, Price sources: each Store's tag", () => {
  it("shows why each Store is not found, unticked and not tickable, and a failed Store's earlier result", () => {
    const notFound = (id: string, name: string, why: PriceSourceStoreView["notFound"]) =>
      store(id, name, { notFound: why });
    const shown = html({
      ...FOUND,
      findDistanceMiles: 50,
      stores: [
        notFound("aldi", "Aldi", "none"),
        notFound("costco", "Costco", "failed"),
        { ...KROGER, earlierResult: true },
        notFound("walmart", "Walmart", "no key"),
        notFound("target", "Target", "unknown"),
        { ...notFound("kroger-2", "Kroger Two", "no key"), reader: "Store API" },
      ],
    });
    const words = text(shown);

    expect(words).toContain("Aldi None within 50 miles Costco");
    expect(words).toContain("Costco ◆ Lookup failed Kroger");
    expect(words).toContain("Walmart ◆ Save the Apify token first Target");
    expect(words).toContain("Target ◆ Find again Kroger Two");
    expect(words).toContain("Kroger Two ◆ Save the Kroger keys first");
    // Kroger's lookup failed: it keeps its Home store, and says so.
    expect(words).toContain("Kroger Maple Avenue, 2.4 mi ◆ Earlier result Not read yet Change");
    // Each tag's full words, once, under the Stores.
    expect(words).toContain("Lookup failed: Could not look it up. Try Find Stores again later.");
    expect(words).toContain(
      "Save the Apify token first: Not looked up: save the Apify token first.",
    );
    expect(words).toContain(
      "Save the Kroger keys first: Not looked up: save the Kroger API keys first.",
    );
    expect(words).toContain("Find again: Not found by the last lookup. Find Stores near us again.");
    expect(words).toContain("Earlier result: The last lookup failed; this is the earlier result.");
    expect(shown).toContain('title="The last lookup found none within 50 miles."');
    // The last six ticks are the Stores'. Only Kroger, found, can be ticked.
    expect(
      ticksOf(shown)
        .slice(-6)
        .map((tick) => tick.includes("disabled")),
    ).toEqual([true, true, false, true, true, true]);
    // A Store not found offers no Home store, no last read, and no delivery amounts.
    const storesCard = words.slice(words.indexOf("Stores within"));
    expect(storesCard.match(/Not read yet/g)).toHaveLength(1);
    expect(storesCard.match(/Change /g)).toHaveLength(1);
  });

  it("asks for Find Stores near us again for a Store whose Home store is made up", () => {
    const shown = page({
      ...FOUND,
      stores: [{ ...KROGER, findAgain: true, homeStore: null, distanceMiles: null, locations: [] }],
    });

    expect(shown).toContain("Kroger No Home store ◆ Find again");
    expect(shown).toContain("Find again: Its Home store is made up. Find Stores near us again.");
    expect(shown).not.toContain("Maple Avenue");
  });

  it("with the ZIP code switch off, lists Walmart at its default store, and Aldi as needing the ZIP code, with its tick off", () => {
    const shown = html({
      ...EMPTY,
      stores: [
        store("aldi", "Aldi", { needsZip: true, notFound: "none" }),
        store("walmart", "Walmart"),
      ],
    });
    const words = text(shown);

    expect(words).toContain("Aldi ◆ Needs ZIP code Not read yet Walmart Its default store");
    expect(words).toContain('Needs ZIP code: Needs your ZIP code: turn on "Use our ZIP code');
    // With the switch off, the last lookup's result does not show.
    expect(words).not.toContain("None within");
    expect(ticksOf(shown).filter((tick) => tick.includes("disabled"))).toHaveLength(1);
    expect(shown).toMatch(/<button[^>]*disabled=""[^>]*>Find Stores near us/);
  });
});

describe("Settings, Price sources: the requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each change as JSON to its own route", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await saveApifyToken("token_made_up_here");
    await saveKrogerKeys("client_made_up", "secret_made_up");
    await testPriceSource("kroger");
    await setOpenFoodFacts(true);
    await setUseZip(true);
    await findStores(50);
    await changeStore("kroger", { homeStoreId: "fake-kroger-0102" });
    const delivery = deliveryChangesOf("6.99", "35");
    if (delivery === undefined) throw new Error("Both amounts are dollars.");
    await changeStore("amazon", delivery);
    await setPriceSourceCostCap(1250);
    await deleteDealFinderData();

    expect(requests).toEqual([
      { method: "PUT", path: "/api/price-sources/apify", body: { token: "token_made_up_here" } },
      {
        method: "PUT",
        path: "/api/price-sources/kroger",
        body: { clientId: "client_made_up", clientSecret: "secret_made_up" },
      },
      { method: "POST", path: "/api/price-sources/kroger/test", body: {} },
      { method: "PUT", path: "/api/price-sources/open-food-facts", body: { on: true } },
      { method: "PUT", path: "/api/price-sources/zip", body: { on: true } },
      { method: "POST", path: "/api/price-sources/find-stores", body: { distanceMiles: 50 } },
      {
        method: "PUT",
        path: "/api/price-sources/stores/kroger",
        body: { homeStoreId: "fake-kroger-0102" },
      },
      {
        method: "PUT",
        path: "/api/price-sources/stores/amazon",
        body: { deliveryFee: 699, freeDeliveryFrom: 3500 },
      },
      { method: "PUT", path: "/api/price-sources/cost-cap", body: { capCents: 1250 } },
      { method: "POST", path: "/api/price-sources/delete-all", body: {} },
    ]);
  });
});
