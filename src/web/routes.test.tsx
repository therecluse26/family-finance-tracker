import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { NoticeList } from "./components/NoticeLines.tsx";
import {
  AiMark,
  DirectionAgainstUsual,
  Estimated,
  Status,
  StatusText,
} from "./components/Status.tsx";
import { grouped, lastCheckText } from "./master-key.ts";
import { MAIN_MENU, MORE_MENU, PHONE_TABS, SETTINGS_SECTIONS } from "./menu.ts";
import { routes } from "./routes.tsx";
import { Shell } from "./Shell.tsx";

const ZONE = "America/New_York";

// Renders a route as the browser's first paint, before any request answers.
function render(path: string): string {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(<RouterProvider router={router} />);
}

// The text of each element of a kind, with tags removed. The tag name ends at a space or ">", so
// "p" does not match an icon's <path>.
function texts(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>(.*?)</${tag}>`, "gs"))].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, "").replace(/<!-- -->/g, ""),
  );
}

// The page without the main menu, whose "More" button folds the menu at phone width.
const outsideMenu = (html: string) =>
  html.replace(/<nav[^>]*aria-label="Main menu"[^>]*>.*?<\/nav>/s, "");

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
      "Reports",
      "Budgets",
      "Goals",
      "Accounts",
      "Alert list",
      "Recurring charges",
      "Top Merchants",
      "Shopping list",
    ]);
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      "Household",
      "Members",
      "My login",
      "Banks",
      "Categories",
      "Store orders",
      "Alerts",
      "AI",
      "Price sources",
      "Backups and data",
      "About",
    ]);
  });

  it("gives My login its forms for the password, TOTP, and backup codes", () => {
    const html = render("/settings/my-login");

    expect(texts(outsideMenu(html), "button")).toEqual([
      "Change password",
      "Move to a new phone",
      "Make new backup codes",
      "Sign out",
    ]);
    // Each form that changes the login asks for the current password (spec 09, Sensitive actions).
    const forms = outsideMenu(html).split("<form").slice(1);
    expect(forms).toHaveLength(3);
    for (const form of forms) {
      expect(form).toMatch(
        /Current password<input[^>]*type="password"[^>]*autoComplete="current-password"/,
      );
    }
  });

  it("gives Backups and data its Back up now button, its Check my Master key form, and its Download my data form", () => {
    const html = render("/settings/backups-and-data");

    expect(texts(html, "h3")).toEqual(["Backups", "Check my Master key", "Download my data"]);
    expect(texts(outsideMenu(html), "button")).toEqual([
      "Back up now",
      "Check my Master key",
      "Download my data",
    ]);
    expect(html).toMatch(/<textarea[^>]*autoComplete="off"[^>]*spellCheck="false"/i);
    expect(html).not.toContain("one-time-code");
  });

  it("shows the Master key in groups of 4, and who last checked it and when", () => {
    expect(grouped("0123456789abcdef")).toBe("0123 4567 89ab cdef");
    expect(lastCheckText(null, ZONE)).toBe("No one has checked the Master key yet.");
    const at = "2026-11-03T14:05:09.000Z";
    expect(lastCheckText({ memberName: "Bob", at, matched: true }, ZONE, new Date(at))).toMatch(
      /^Bob last checked it on Nov 3 at 9:05 AM\. It matched\.$/,
    );
    expect(lastCheckText({ memberName: null, at, matched: false }, ZONE, new Date(at))).toMatch(
      /^A removed Member last checked it on .+\. It did not match\.$/,
    );
  });

  it("shows each open System notice as a line, with a close button for an event", () => {
    const html = renderToString(
      <NoticeList
        notices={[
          { id: "n1", text: "Your history is ready", closable: true },
          { id: "n2", text: "First Fake Bank needs you to sign in again", closable: false },
        ]}
        onClose={() => {}}
      />,
    );

    expect(texts(html, "li")).toEqual([
      "● Your history is readyClose",
      "● First Fake Bank needs you to sign in again",
    ]);
    expect(renderToString(<NoticeList notices={[]} onClose={() => {}} />)).toBe("");
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

  it("folds to tabs and More at phone width, with each item once and the current page marked", () => {
    const html = render("/top-merchants");
    const nav = /<nav[^>]*aria-label="Main menu"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";

    // Each item is one link, so the fold hides items rather than drawing a second menu.
    const links = texts(nav, "a");
    for (const item of [...MAIN_MENU, ...MORE_MENU])
      expect(links.filter((text) => text === item.label)).toHaveLength(1);
    expect(nav).toMatch(/aria-current="page"[^>]*>(?:(?!<\/a>).)*Top Merchants/s);
    // The phone tabs are the PHONE_TABS; "More" opens the rest.
    expect(PHONE_TABS).toEqual(["/", "/transactions", "/chat", "/review-list"]);
    expect(nav).toMatch(
      /<button type="button" aria-expanded="false" aria-controls="main-menu"[^>]*>.*More<\/button>/s,
    );
    expect(html).toContain('id="main-menu"');
    // Closed, the page under the menu is not inert.
    expect(html).not.toContain("inert");
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
    expect(html).toContain("text-critical");
    expect(html).toContain("▲");
    expect(html).toContain("Over Budget");
    expect(renderToString(<Status tone="good" word="On track" />)).toMatch(
      /text-good.*✓.*On track/s,
    );
    expect(renderToString(<Status tone="serious" word="Behind" />)).toMatch(
      /text-serious.*◆.*Behind/s,
    );
    expect(renderToString(<Status tone="accent" word="Heads up" />)).toMatch(
      /text-accent.*●.*Heads up/s,
    );
    expect(renderToString(<Status tone="muted" word="about usual" />)).toMatch(
      /text-muted.*●.*about usual/s,
    );
  });

  it("adds a detail after the word, and puts the icon before a written status line", () => {
    expect(renderToString(<Status tone="serious" word="Behind" detail="38%" />)).toMatch(
      /text-serious.*◆.*Behind · 38%/s,
    );
    expect(
      renderToString(<StatusText tone="good">On pace to end $140 under Budget</StatusText>),
    ).toMatch(/^<span class="text-good"><span aria-hidden="true">✓ <\/span>On pace to end/);
  });

  it("colors direction against usual green when good and orange when bad", () => {
    expect(renderToString(<DirectionAgainstUsual changeCents={4000} moreIs="bad" />)).toBe(
      '<span class="text-serious">▲ $40 above usual</span>',
    );
    expect(renderToString(<DirectionAgainstUsual changeCents={4000} moreIs="good" />)).toBe(
      '<span class="text-good">▲ $40 above usual</span>',
    );
  });

  it("has an AI mark and an estimated label", () => {
    expect(texts(renderToString(<AiMark />), "span")).toEqual(["AI"]);
    expect(texts(renderToString(<Estimated />), "span")).toEqual(["estimated"]);
  });
});
