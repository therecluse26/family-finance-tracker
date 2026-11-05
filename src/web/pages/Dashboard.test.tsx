import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionView } from "../../server/bank-views.ts";
import type { BudgetsView, MonthBudgetView } from "../../server/budgets-views.ts";
import type { NoticeView } from "../../server/notice-views.ts";
import {
  type DashboardData,
  dashboardMonth,
  headerLine,
  leftText,
  paceLine,
  retryHistoryJobs,
} from "../dashboard.ts";
import { BEFORE_FIRST_DRAFT } from "./Budgets.tsx";
import { DashboardReport } from "./Dashboard.tsx";

// The dashboard (spec 07, The dashboard; Header and status lines; 2. Left to spend), drawn from
// its requests' answers. The numbers themselves are checked on the demo household, through the
// app's HTTP interface, in src/server/dashboard-page.test.ts.

const ZONE = "America/New_York";
// Oct 20, 2026, noon in New York.
const NOW = new Date("2026-10-20T16:00:00.000Z");

const connection = (fields: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1",
  provider: "plaid",
  bankName: "First Fake Bank",
  health: "healthy",
  historyLoaded: true,
  lastSyncedAt: "2026-10-20T12:15:00.000Z",
  nextSyncAt: null,
  actions: { repairInApp: true, importExisting: true, refresh: true },
  removed: false,
  held: false,
  ...fields,
});

const notice = (fields: Partial<NoticeView> = {}): NoticeView => ({
  id: "n1",
  text: "Your history is ready",
  raisedAt: "2026-10-19T12:00:00.000Z",
  closable: true,
  repairConnectionId: null,
  retryHistoryJob: false,
  ...fields,
});

const yearly = (category: string, amount: number, spending: number): MonthBudgetView => ({
  category,
  categoryGroup: category === "Travel" ? "Leisure" : "Other",
  amount,
  period: "yearly",
  takesEffect: "2026",
  source: "formula",
  setBy: null,
  pinned: null,
  spending,
  projected: null,
  status: spending > amount ? "Over Budget" : "on track",
  shareOfYear: 293 / 365,
  context: null,
});

const group = (
  categoryGroup: string,
  monthly: number,
  spending: number | null,
  projected: number | null,
  yearly = 0,
) => ({
  categoryGroup,
  monthly,
  yearly,
  spending,
  projected,
  overBudget: null,
  onPace: null,
  status: null,
});

// $3,100 of monthly Budgets with $1,860 spent, on pace for $2,900; and the yearly Budgets, which
// stay out of the big number.
const BUDGETS: BudgetsView = {
  month: "2026-10",
  notice: null,
  fitNote: null,
  drafted: true,
  draftAccepted: false,
  budgets: [yearly("Travel", 300_000, 124_000), yearly("Gifts and donations", 50_000, 61_000)],
  unbudgeted: [],
  groups: [
    group("Bills", 200_000, 150_000, 200_000),
    group("Shopping", 110_000, 36_000, 90_000),
    group("Transportation", 0, null, null),
    group("Leisure", 0, null, null, 300_000),
    group("Other", 0, null, null, 50_000),
  ],
};

const data = (fields: Partial<DashboardData> = {}): DashboardData => ({
  timeZone: ZONE,
  month: dashboardMonth(NOW, ZONE),
  connections: [connection()],
  history: { waitEnded: true, aiMayRun: true, loading: [] },
  notices: [],
  budgets: BUDGETS,
  ...fields,
});

function render(shown: DashboardData): string {
  const page = (
    <DashboardReport data={shown} onClose={() => {}} onRetry={() => {}} onChanged={() => {}} />
  );
  const router = createMemoryRouter([{ path: "/", element: page }], { initialEntries: ["/"] });
  return renderToString(<RouterProvider router={router} />);
}

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The words of the element with `data-slot`, which must hold no element of its own tag.
function slotText(html: string, slot: string): string {
  const match = new RegExp(`<(\\w+)[^>]*data-slot="${slot}"[^>]*>(.*?)</\\1>`, "s").exec(html);
  if (match === null) throw new Error(`No data-slot="${slot}".`);
  return text(match[2] ?? "");
}

// The words of each <li> in the list labelled `label`.
function listItems(html: string, label: string): string[] {
  const list = new RegExp(`<ul aria-label="${label}"[^>]*>(.*?)</ul>`, "s").exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((item) => text(item[1] ?? ""));
}

describe("the dashboard's header", () => {
  it("shows the month's name, the day, and the latest finished sync, Household time", () => {
    const html = render(
      data({
        connections: [
          connection(),
          connection({ id: "c2", lastSyncedAt: "2026-10-20T14:05:00.000Z" }),
          connection({ id: "c3", lastSyncedAt: null }),
        ],
      }),
    );

    expect(text(html)).toMatch(/^October Day 20 of 31 · synced 10:05 AM /);
  });

  it("switches to the new month on the 1st, Household time", () => {
    // 11:30 PM on Oct 31 in New York is already Nov 1 in UTC.
    expect(dashboardMonth(new Date("2026-11-01T03:30:00.000Z"), ZONE)).toEqual({
      month: "2026-10",
      name: "October",
      today: "2026-10-31",
      day: 31,
      days: 31,
    });
    expect(dashboardMonth(new Date("2026-11-01T04:30:00.000Z"), ZONE)).toEqual({
      month: "2026-11",
      name: "November",
      today: "2026-11-01",
      day: 1,
      days: 30,
    });
  });

  it("dates a sync from an earlier day, and says when nothing has synced", () => {
    const month = dashboardMonth(NOW, ZONE);
    expect(headerLine(month, [{ lastSyncedAt: "2026-10-19T23:40:00.000Z" }], ZONE)).toBe(
      "Day 20 of 31 · synced Oct 19, 7:40 PM",
    );
    expect(headerLine(month, [{ lastSyncedAt: null }], ZONE)).toBe("Day 20 of 31 · not synced yet");
  });
});

describe("the dashboard's status lines", () => {
  it("shows a banner with Repair for each broken Connection, the history loading, and every other notice", () => {
    const html = render(
      data({
        connections: [
          connection({ id: "c1", bankName: "First Fake Bank", health: "needs a member" }),
          connection({ id: "c2", bankName: "Second Fake Bank", health: "broken" }),
          connection({ id: "c3", bankName: "Third Fake Bank", historyLoaded: false }),
        ],
        history: {
          waitEnded: false,
          aiMayRun: false,
          loading: [
            {
              connectionId: "c3",
              bankName: "Third Fake Bank",
              transactions: 1_240,
              oldestDate: "2025-03-03",
              holdsBackAi: true,
            },
          ],
        },
        notices: [
          notice({
            id: "n1",
            text: "First Fake Bank needs you to sign in again",
            closable: false,
            repairConnectionId: "c1",
          }),
          notice({
            id: "n2",
            text: "Second Fake Bank has disconnected. Use Repair to link it again",
            closable: false,
            repairConnectionId: "c2",
          }),
          notice({ id: "n3", text: "Your history is ready", closable: true }),
          notice({
            id: "n4",
            text: "Fourth Fake Bank has not synced since Oct 2",
            closable: false,
          }),
        ],
      }),
    );

    // Update mode while it needs a Member; Link again, in Settings, once it is Broken.
    expect(listItems(html, "Broken Connections")).toEqual([
      "▲ First Fake Bank needs you to sign in again Repair",
      "▲ Second Fake Bank has disconnected. Use Repair to link it again Repair",
    ]);
    expect(html).toContain('href="/settings/banks"');
    expect(listItems(html, "History loading")).toEqual([
      "Loading history for Third Fake Bank: 1,240 Transactions so far, back to Mar 3, 2025",
    ]);
    // A notice about a past event has a close button; one about a condition does not. A Repair
    // notice shows once, as its banner.
    expect(listItems(html, "System notices")).toEqual([
      "● Your history is ready Close",
      "● Fourth Fake Bank has not synced since Oct 2",
    ]);
    // The status lines come above the boxes.
    expect(html.indexOf('data-slot="status-lines"')).toBeLessThan(
      html.indexOf('data-slot="columns"'),
    );
  });

  it("shows no status line when nothing applies", () => {
    expect(slotText(render(data()), "status-lines")).toBe("");
  });

  it("has Retry, and no close button, on the notice of a stopped history job", () => {
    const stopped = notice({
      id: "n5",
      text: "The first run on your history did not finish. Press Retry to try it again",
      closable: false,
      retryHistoryJob: true,
    });
    const onRetry = vi.fn();
    const shown = data({ notices: [stopped, notice({ id: "n6" })] });

    expect(listItems(render(shown), "System notices")).toEqual([
      "● The first run on your history did not finish. Press Retry to try it again Retry",
      "● Your history is ready Close",
    ]);
    const buttons = buttonsOf(
      <DashboardReport data={shown} onClose={() => {}} onRetry={onRetry} onChanged={() => {}} />,
    );
    expect([...buttons.keys()]).toEqual(["Retry", "Close"]);
    buttons.get("Retry")?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("Retry on a stopped history job", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the Retry route", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      sent.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url}`);
      return Response.json({ firstRun: true, banksAddedLater: 0 });
    });

    expect((await retryHistoryJobs()).ok).toBe(true);
    expect(sent).toEqual(["POST /api/history-jobs/retry"]);
  });
});

// The buttons in a tree, by their words, with what each does. The parts the tree holds have no
// state of their own, so each is called for its tree.
function buttonsOf(element: ReactNode): Map<string, () => void> {
  const buttons = new Map<string, () => void>();
  const words = (node: ReactNode): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(words).join("")
        : isValidElement<{ children?: ReactNode }>(node)
          ? words(node.props.children)
          : "";
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) return;
    if (typeof node.type === "function")
      return walk((node.type as (p: unknown) => ReactNode)(node.props));
    if (node.type === "button")
      buttons.set(words(node.props.children), node.props.onClick as () => void);
    walk(node.props.children);
  };
  walk(element);
  return buttons;
}

describe("Left to spend", () => {
  it("shows what is left, the pace line, the month meter, and the yearly rows", () => {
    const html = render(data());

    expect(slotText(html, "left-to-spend")).toBe(
      [
        "Left to spend in October",
        "$1,240",
        "✓ On pace to end $200 under Budget",
        "$1,860 of $3,100 · 11 days to go",
        "Travel $1,240 of $3,000 · 80% of the year gone",
        "Gifts and donations $610 of $500 · 80% of the year gone ▲ Over Budget",
      ].join(" "),
    );
    // The "today" tick marks the share of the month gone.
    expect(html).toContain(`data-slot="today" style="left:${(20 / 31) * 100}%"`);
    expect(html).toContain(`style="width:${(186_000 / 310_000) * 100}%"`);
  });

  it("shows the number as $X over with ▲ Over Budget below $0", () => {
    const over: BudgetsView = {
      ...BUDGETS,
      budgets: [],
      groups: [
        group("Bills", 200_000, 260_000, 280_000),
        group("Shopping", 110_000, 81_000, 95_000),
      ],
    };
    const html = render(data({ budgets: over }));

    expect(slotText(html, "left-to-spend")).toBe(
      [
        "Left to spend in October",
        "$310 over ▲ Over Budget",
        "◆ On pace to end $650 over Budget",
        "$3,410 of $3,100 · 11 days to go",
      ].join(" "),
    );
  });

  it("never shows $0 over: a gap under 50 cents is not over Budget", () => {
    expect(leftText(-30)).toEqual({ text: "$0", over: false });
    expect(leftText(-50)).toEqual({ text: "$1 over", over: true });
    expect(leftText(0)).toEqual({ text: "$0", over: false });
    expect(paceLine(100_000, 100_030)).toEqual({
      tone: "good",
      text: "On pace to end $0 under Budget",
    });
    expect(paceLine(100_000, 100_050)).toEqual({
      tone: "serious",
      text: "On pace to end $1 over Budget",
    });

    const html = render(
      data({
        budgets: { ...BUDGETS, budgets: [], groups: [group("Bills", 100_000, 100_030, 100_030)] },
      }),
    );
    expect(slotText(html, "left-to-spend")).toBe(
      "Left to spend in October $0 ✓ On pace to end $0 under Budget $1,000 of $1,000 · 11 days to go",
    );
  });

  it("says Budgets appear later before the first draft", () => {
    const html = render(data({ budgets: { ...BUDGETS, drafted: false, budgets: [], groups: [] } }));

    expect(slotText(html, "left-to-spend")).toBe(`Left to spend in October ${BEFORE_FIRST_DRAFT}`);
    expect(BEFORE_FIRST_DRAFT).toBe("Budgets appear when your history has loaded.");
  });
});

// --- Layout at a screen width, from the page's own Tailwind classes ----------------------------

type Rule = { minWidth: number; className: string; body: string };

// The class rules in Tailwind's CSS, each with the screen width it needs: 0, or the N of an
// `@media (width >= Npx)` around it.
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (block: string, minWidth: number) => {
    let at = 0;
    while (true) {
      const open = block.indexOf("{", at);
      if (open < 0) return;
      let depth = 1;
      let end = open + 1;
      for (; depth > 0 && end < block.length; end++) {
        if (block[end] === "{") depth++;
        if (block[end] === "}") depth--;
      }
      const head = (
        block
          .slice(at, open)
          .split(/;|\*\//)
          .at(-1) ?? ""
      ).trim();
      const body = block.slice(open + 1, end - 1);
      const media = /^@media \(width >= (\d+)px\)$/.exec(head);
      if (media !== null) walk(body, Number(media[1]));
      else if (head.startsWith(".")) {
        rules.push({ minWidth, className: head.slice(1).replace(/\\(.)/g, "$1"), body });
      }
      at = end;
    }
  };
  walk(css, 0);
  return rules;
}

// The CSS properties each element with a data-slot gets at a screen width.
async function layoutOf(html: string) {
  const all = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? "").split(/\s+/),
  );
  const rules = rulesOf((await compile("@tailwind utilities;")).build([...new Set(all)]));
  return (slot: string, width: number) => {
    const classes = new Set(
      (new RegExp(`class="([^"]*)"[^>]*data-slot="${slot}"`).exec(html)?.[1] ?? "").split(/\s+/),
    );
    const style = new Map<string, string>();
    for (const rule of rules) {
      if (rule.minWidth > width || !classes.has(rule.className)) continue;
      for (const declaration of rule.body.split(";")) {
        const [property = "", ...value] = declaration.split(":");
        if (property.trim() !== "") style.set(property.trim(), value.join(":").trim());
      }
    }
    return style;
  };
}

const BOXES = /data-slot="(ai-box|left-to-spend|goals|number-tiles|usual-month|coming-up)"/g;

describe("the dashboard's layout", () => {
  it("stacks every box at 375 px with the AI box first, and keeps the AI box in view at 1,200 px", async () => {
    const html = render(data());
    const styleOf = await layoutOf(html);
    const boxes = [...html.matchAll(BOXES)].map((match) => match[1] ?? "");

    // The AI box, then the right column top to bottom: Left to spend, Goals, the four number
    // tiles, "A usual month", and "Coming up". Each part is a box.
    expect(boxes).toEqual([
      "ai-box",
      "left-to-spend",
      "goals",
      "number-tiles",
      "usual-month",
      "coming-up",
    ]);
    for (const box of boxes) {
      expect(styleOf(box, 375).get("border-width")).toBe("1px");
    }
    expect(html.indexOf('data-slot="ai-column"')).toBeLessThan(
      html.indexOf('data-slot="right-column"'),
    );

    // 375 px: one column, so the boxes stack in that order, the AI box first.
    expect(styleOf("columns", 375).get("display")).toBe("grid");
    expect(styleOf("columns", 375).has("grid-template-columns")).toBe(false);
    expect(styleOf("ai-column", 375).has("position")).toBe(false);

    // 1,200 px: the AI box is the left column, and stays in view while the right column scrolls.
    expect(styleOf("columns", 1200).get("grid-template-columns")).toBe("minmax(16rem,22rem) 1fr");
    expect(styleOf("ai-column", 1200).get("position")).toBe("sticky");
    expect(styleOf("right-column", 1200).get("flex-direction")).toBe("column");

    // 900 px is the first width with two columns.
    expect(styleOf("columns", 899).has("grid-template-columns")).toBe(false);
    expect(styleOf("columns", 900).get("grid-template-columns")).toBe("minmax(16rem,22rem) 1fr");
  });
});
