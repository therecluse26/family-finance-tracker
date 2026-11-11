import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceSourcesView } from "../../../deal-finder/view.ts";
import {
  changeStore,
  deleteDealFinderData,
  findStores,
  PriceSourcesCards,
  saveApifyToken,
  saveKrogerKeys,
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

const FOUND: PriceSourcesView = {
  ...EMPTY,
  apify: { tokenLast4: "a1b2", check: "passed", checkedAt: "2026-11-11T14:00:00.000Z" },
  zip: { on: true, zipCode: "10001", changed: false },
  storesFoundAt: "2026-11-11T14:05:00.000Z",
  stores: [
    {
      id: "kroger",
      name: "Kroger",
      kind: "in person",
      reader: "Store API",
      on: true,
      needsZip: false,
      homeStore: { id: "fake-kroger-0101", name: "Kroger, Maple Avenue" },
      distanceMiles: 2.4,
      locations: [
        { id: "fake-kroger-0101", name: "Kroger, Maple Avenue", distanceMiles: 2.4 },
        { id: "fake-kroger-0102", name: "Kroger, Orchard Road", distanceMiles: 6.8 },
      ],
      deliveryFee: null,
      freeDeliveryFrom: null,
      lastGoodReadAt: null,
    },
  ],
  data: { products: 3, priceReads: 9, matches: 2, plans: 1 },
};

const NOW = new Date("2026-11-11T18:00:00.000Z");

const page = (view: PriceSourcesView) =>
  text(
    renderToString(
      <PriceSourcesCards
        view={view}
        busy={false}
        act={async () => true}
        zone="America/New_York"
        now={NOW}
      />,
    ),
  );

describe("Settings, Price sources", () => {
  it("shows no key, the ZIP code switch off, and the $5.00 cap before anything is saved", () => {
    const shown = page(EMPTY);

    expect(shown).toContain("None saved.");
    expect(shown).toContain("Your ZIP code: 10001. Off,");
    expect(shown).toContain("This month: $0.00 of $5.00");
    expect(shown).toContain("Delete all deal finder data");
  });

  it("shows a saved key only by its last 4 characters, and each Store with its Home store", () => {
    const shown = page(FOUND);

    expect(shown).toContain("Saved, ending in a1b2.");
    expect(shown).toContain("Home store: Kroger, Maple Avenue, 2.4 miles");
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
    await setUseZip(true);
    await findStores(50);
    await changeStore("kroger", { homeStoreId: "fake-kroger-0102" });
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
      { method: "PUT", path: "/api/price-sources/zip", body: { on: true } },
      { method: "POST", path: "/api/price-sources/find-stores", body: { distanceMiles: 50 } },
      {
        method: "PUT",
        path: "/api/price-sources/stores/kroger",
        body: { homeStoreId: "fake-kroger-0102" },
      },
      { method: "PUT", path: "/api/price-sources/cost-cap", body: { capCents: 1250 } },
      { method: "POST", path: "/api/price-sources/delete-all", body: {} },
    ]);
  });
});
