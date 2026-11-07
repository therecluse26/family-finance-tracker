import { renderToString } from "react-dom/server";
import { createMemoryRouter, Navigate, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { routes } from "../../routes.tsx";
import { SettingsIndex, tabRowScroll } from "./Settings.tsx";

// Settings' frame: the row of tabs, and the page with no tab chosen.

describe("Settings' row of tabs", () => {
  // A 343 px wide row, as on a 375 px phone, holding tabs at these places.
  const row = (scrollLeft: number) => ({ scrollLeft, width: 343 });

  it("does not move when the current tab shows whole", () => {
    expect(tabRowScroll(row(0), { left: 0, width: 100 })).toBe(0);
    expect(tabRowScroll(row(120), { left: 200, width: 90 })).toBe(120);
  });

  it("scrolls just far enough to show a tab past its right edge, with the next one peeking in", () => {
    // "Backups and data", from 520 to 660 px.
    expect(tabRowScroll(row(0), { left: 520, width: 140 })).toBe(660 - 343 + 24);
  });

  it("scrolls back to show a tab past its left edge, and never before the start", () => {
    expect(tabRowScroll(row(400), { left: 200, width: 90 })).toBe(200 - 24);
    expect(tabRowScroll(row(400), { left: 0, width: 100 })).toBe(0);
  });

  it("is one row that scrolls sideways below 900 px, and wraps from 900 px", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/settings/household"] });
    const html = renderToString(<RouterProvider router={router} />);
    const list = /<nav aria-label="Settings sections"[^>]*><ul[^>]*class="([^"]*)"/.exec(html)?.[1];

    const classes = (list ?? "").split(" ");

    expect(classes).toContain("overflow-x-auto");
    expect(classes).not.toContain("flex-wrap");
    expect(classes).toContain("min-[900px]:flex-wrap");
    // A thin scrollbar shows, so a mouse with no sideways wheel can reach every tab.
    expect(classes).toContain("[scrollbar-width:thin]");
    expect(classes).not.toContain("[scrollbar-width:none]");
  });

  it("draws each tab's focus ring inside the tab, so the scrolling row never clips it", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/settings/household"] });
    const html = renderToString(<RouterProvider router={router} />);
    const nav = /<nav aria-label="Settings sections".*?<\/nav>/s.exec(html)?.[0] ?? "";
    const tabs = [...nav.matchAll(/<a[^>]*class="([^"]*)"/g)].map((match) =>
      (match[1] ?? "").split(" "),
    );

    expect(tabs.length).toBeGreaterThan(1);
    for (const classes of tabs) {
      expect(classes).toEqual(
        expect.arrayContaining([
          "focus-visible:outline-2",
          "focus-visible:-outline-offset-2",
          "focus-visible:outline-accent",
        ]),
      );
    }
  });
});

describe("Settings with no tab chosen", () => {
  it("opens the first tab, Household, and replaces the address so Back leaves Settings", () => {
    const settings = routes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.path === "settings");
    const index = settings?.children?.find((route) => route.index === true);
    const element = SettingsIndex();

    expect(index?.Component).toBe(SettingsIndex);
    expect(element?.type).toBe(Navigate);
    expect(element?.props).toEqual({ to: "household", replace: true });
  });

  it('paints the one heading first, with no "Choose a section." line', () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/settings"] });
    const html = renderToString(<RouterProvider router={router} />);

    expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html).not.toContain("Choose a section.");
  });
});
