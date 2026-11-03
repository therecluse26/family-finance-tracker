import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { AiMark, DirectionAgainstUsual, Estimated, Status } from "./components/Status.tsx";
import { MAIN_MENU, MORE_MENU, SETTINGS_SECTIONS } from "./menu.ts";
import { routes } from "./routes.tsx";
import { Shell } from "./Shell.tsx";

// Renders a route as the browser's first paint, before any request answers.
function render(path: string): string {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(<RouterProvider router={router} />);
}

// The text of each element of a kind, with tags removed.
function texts(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "gs"))].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, "").replace(/<!-- -->/g, ""),
  );
}

describe("the app shell", () => {
  it.each([...MAIN_MENU, ...MORE_MENU])("visits $label at $path", ({ label, path }) => {
    const html = render(path);

    expect(texts(html, "h1")).toEqual([label]);
    // The main menu shows on every page, with every item and the More section.
    const menu = texts(html, "a");
    for (const item of [...MAIN_MENU, ...MORE_MENU]) expect(menu).toContain(item.label);
    expect(texts(html, "p")).toContain("More");
  });

  it.each(SETTINGS_SECTIONS)("visits the Settings section $label", ({ label, path }) => {
    const html = render(`/settings/${path}`);

    expect(texts(html, "h1")).toEqual(["Settings"]);
    expect(texts(html, "h2")).toEqual([label]);
    const links = texts(html, "a");
    for (const section of SETTINGS_SECTIONS) expect(links).toContain(section.label);
  });

  it("holds the menu items and Settings sections the spec names, in order", () => {
    expect(MAIN_MENU.map((item) => item.label)).toEqual([
      "Dashboard",
      "Transactions",
      "Chat",
      "Reviews",
      "Review list",
      "Settings",
    ]);
    expect(MORE_MENU.map((item) => item.label)).toEqual([
      "Budgets",
      "Goals",
      "Accounts",
      "Alert list",
      "Recurring charges",
      "Top Merchants",
    ]);
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      "Household",
      "Members",
      "My login",
      "Banks",
      "Categories",
      "Alerts",
      "AI",
      "Backups and data",
      "About",
    ]);
  });

  it("gives My login its forms for the password, TOTP, and backup codes", () => {
    const html = render("/settings/my-login");

    expect(texts(html, "button")).toEqual([
      "Change password",
      "Set up a new TOTP",
      "Make new backup codes",
      "Sign out",
    ]);
  });

  it("shows a slot for the Review list's open count", () => {
    const shell = routes.find((route) => route.path === "/");
    const router = createMemoryRouter(
      [{ ...shell, Component: undefined, element: <Shell reviewListOpenCount={3} /> }],
      { initialEntries: ["/"] },
    );
    const withCount = renderToString(<RouterProvider router={router} />);

    expect(withCount).toMatch(/Review list<\/span><span[^>]*data-slot="open-count"[^>]*>3</);
    expect(render("/")).not.toContain('data-slot="open-count"');
  });

  it("answers an unknown path with Page not found, inside the shell", () => {
    const html = render("/no-such-page");

    expect(texts(html, "h1")).toEqual(["Page not found"]);
    expect(texts(html, "a")).toContain("Dashboard");
  });
});

describe("shared status components", () => {
  it("pairs icon, color, and word", () => {
    const html = renderToString(<Status tone="critical" word="Over Budget" />);
    expect(html).toContain("text-red-700");
    expect(html).toContain("▲");
    expect(html).toContain("Over Budget");
    expect(renderToString(<Status tone="good" word="On track" />)).toMatch(
      /text-green-700.*✓.*On track/s,
    );
    expect(renderToString(<Status tone="serious" word="Behind" />)).toMatch(
      /text-orange-700.*◆.*Behind/s,
    );
    expect(renderToString(<Status tone="accent" word="Heads up" />)).toMatch(
      /text-blue-700.*●.*Heads up/s,
    );
    expect(renderToString(<Status tone="muted" word="about usual" />)).toMatch(
      /text-gray-500.*●.*about usual/s,
    );
  });

  it("colors direction against usual green when good and orange when bad", () => {
    expect(renderToString(<DirectionAgainstUsual changeCents={4000} moreIs="bad" />)).toBe(
      '<span class="text-orange-700">▲ $40 above usual</span>',
    );
    expect(renderToString(<DirectionAgainstUsual changeCents={4000} moreIs="good" />)).toBe(
      '<span class="text-green-700">▲ $40 above usual</span>',
    );
  });

  it("has an AI mark and an estimated label", () => {
    expect(texts(renderToString(<AiMark />), "span")).toEqual(["AI"]);
    expect(texts(renderToString(<Estimated />), "span")).toEqual(["estimated"]);
  });
});
