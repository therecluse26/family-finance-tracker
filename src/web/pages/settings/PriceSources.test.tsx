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
    expect(shown).not.toContain("Find Stores near us again");
  });

  it("asks for Find Stores near us again for a Store whose Home store is made up", () => {
    const [kroger] = FOUND.stores;
    if (kroger === undefined) throw new Error("FOUND lists Kroger.");
    const shown = page({
      ...FOUND,
      stores: [{ ...kroger, findAgain: true, homeStore: null, distanceMiles: null, locations: [] }],
    });

    expect(shown).toContain("No Home store");
    expect(shown).toContain("Its Home store is made up. Find Stores near us again.");
    expect(shown).not.toContain("Maple Avenue");
  });

  it("shows why each Store is not found, unticked and not tickable, and a failed Store's earlier result", () => {
    const [kroger] = FOUND.stores;
    if (kroger === undefined) throw new Error("FOUND lists Kroger.");
    const notFound = (id: string, name: string, why: "none" | "failed" | "no key") => ({
      ...kroger,
      id,
      name,
      reader: "Scraping service" as const,
      on: false,
      notFound: why,
      homeStore: null,
      distanceMiles: null,
      locations: [],
    });
    const html = renderToString(
      <PriceSourcesCards
        view={{
          ...FOUND,
          findDistanceMiles: 50,
          stores: [
            notFound("aldi", "Aldi", "none"),
            notFound("costco", "Costco", "failed"),
            { ...kroger, earlierResult: true },
            notFound("walmart", "Walmart", "no key"),
          ],
        }}
        busy={false}
        act={async () => true}
        zone="America/New_York"
        now={NOW}
      />,
    );
    const shown = text(html);

    expect(shown).toContain("Aldi None within 50 miles");
    expect(shown).toContain("Costco ◆ Could not look it up. Try Find Stores again later.");
    expect(shown).toContain("Walmart ◆ Not looked up: save the Apify token first.");
    // Kroger's lookup failed: it keeps its Home store, and says so.
    expect(shown).toContain("Home store: Kroger, Maple Avenue, 2.4 miles");
    expect(shown).toContain("The last lookup failed; this is the earlier result.");
    const ticks = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((tick) => tick[0]);
    // The last four ticks are the Stores'.
    expect(ticks.slice(-4).map((tick) => tick.includes("disabled"))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    // A Store not found offers no Home store or delivery amounts.
    expect(shown.match(/Delivery fee/g)).toHaveLength(1);
  });
});

describe("Settings, Price sources: with the ZIP code switch off", () => {
  const store = (id: string, name: string, needsZip: boolean) => ({
    id,
    name,
    kind: "in person" as const,
    reader: "Scraping service" as const,
    on: false,
    needsZip,
    findAgain: false,
    notFound: null,
    earlierResult: false,
    homeStore: null,
    distanceMiles: null,
    locations: [],
    deliveryFee: null,
    freeDeliveryFrom: null,
    lastGoodReadAt: null,
  });
  const html = renderToString(
    <PriceSourcesCards
      view={{
        ...EMPTY,
        stores: [store("aldi", "Aldi", true), store("walmart", "Walmart", false)],
      }}
      busy={false}
      act={async () => true}
      zone="America/New_York"
      now={NOW}
    />,
  );

  it("lists Walmart at its default store, and Aldi as needing the ZIP code, with its tick off", () => {
    const shown = text(html);

    expect(shown).toContain("Walmart Its default store");
    expect(shown).toContain("Needs your ZIP code");
    const ticks = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((tick) => tick[0]);
    expect(ticks.filter((tick) => tick.includes("disabled"))).toHaveLength(1);
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
