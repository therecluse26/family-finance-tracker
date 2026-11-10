import { renderToString } from "react-dom/server";
import { createMemoryRouter, Navigate, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../../menu.ts";
import { routes } from "../../routes.tsx";
import { AmazonStore } from "./Amazon.tsx";
import { STORES, StoreOrders } from "./StoreOrders.tsx";

// Settings → Store orders (spec 14, The Store orders page in Settings): its tab, its heading and
// intro line, one card per store, and the old Amazon address.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

const settingsRoutes = () =>
  routes.flatMap((route) => route.children ?? []).find((route) => route.path === "settings")
    ?.children ?? [];

describe("Settings, Store orders", () => {
  it("has its tab where Amazon was, after Categories", () => {
    const labels = SETTINGS_SECTIONS.map((section) => section.label);

    expect(labels.indexOf("Store orders")).toBe(labels.indexOf("Categories") + 1);
    expect(SETTINGS_SECTIONS).toContainEqual({ label: "Store orders", path: "store-orders" });
    expect(labels).not.toContain("Amazon");
  });

  it("shows its heading and intro line at /settings/store-orders", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/settings/store-orders"] });
    const html = renderToString(<RouterProvider router={router} />);

    expect(html).toMatch(/<h2[^>]*>Store orders<\/h2>/);
    expect(text(html)).toContain(
      "A store's order history file links each order's items to the charge that paid for it, and gives each item a Category.",
    );
    expect(text(html)).not.toContain("This section is not built yet.");
  });

  it("has one card per store, and Amazon is the only store", () => {
    expect(STORES).toEqual([{ id: "amazon", name: "Amazon", Card: AmazonStore }]);
    // Each store's card is on the page, and nothing for a store that does not exist.
    const html = renderToString(<StoreOrders />);
    expect(text(html)).not.toMatch(/coming soon/i);
  });

  it("opens Store orders from the old Amazon address, and replaces the address", () => {
    const old = settingsRoutes().find((route) => route.path === "amazon");

    expect(old?.element).toEqual(<Navigate to="/settings/store-orders" replace />);
    expect(old?.element).toMatchObject({ type: Navigate });
  });
});
