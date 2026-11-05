import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiBoxInsightCardView,
  AiBoxNoteView,
  AiBoxProposalView,
  AiBoxReviewLinkView,
  AiBoxView,
} from "../../server/ai-box-views.ts";
import type { ConnectionView, NumberTilesView } from "../../server/bank-views.ts";
import type {
  BudgetStatusView,
  BudgetsView,
  MonthBudgetView,
  UsualMonthView,
} from "../../server/budgets-views.ts";
import type { ComingUpView } from "../../server/coming-up-views.ts";
import type { GoalView } from "../../server/goals-views.ts";
import type { NoticeView } from "../../server/notice-views.ts";
import {
  changeAgainstUsual,
  type DashboardData,
  dashboardMonth,
  groupBars,
  headerLine,
  leftText,
  paceLine,
  retryHistoryJobs,
  statusLines,
  usualMonthLine,
} from "../dashboard.ts";
import type { GoalsAnswer } from "../goals.ts";
import { BEFORE_FIRST_DRAFT } from "./Budgets.tsx";
import { DashboardReport, StatusLineList } from "./Dashboard.tsx";

// The dashboard (spec 07, The dashboard; Header and status lines; 2. Left to spend; 3. Goals;
// 4. Number tiles; 5. "A usual month"; 6. Coming up), drawn from its requests' answers. The numbers themselves are checked
// on the demo household, through the app's HTTP interface, in src/server/dashboard-page.test.ts.

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
  reason: null,
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

const tile = (amount: number, usual: number | null) => ({
  amount,
  usual,
  trend: [{ at: "2026-09", amount: usual ?? 0 }],
});

// September's Spending $120 above its usual, Income at its usual, Cash on hand $655 below, and
// Debt $200 above, with two Manual loans.
const NUMBER_TILES: NumberTilesView = {
  lastMonth: "2026-09",
  spending: tile(412_000, 400_000),
  income: tile(650_000, 650_000),
  cashOnHand: tile(1_234_500, 1_300_000),
  debt: { ...tile(820_000, 800_000), estimatedLoans: 2 },
};

const bars = (spending: number, budget: number | null) => [
  { month: "2026-09", spending, budget: null },
  { month: "2026-10", spending, budget },
];

const USUAL_MONTH: UsualMonthView = {
  usual: 300_000,
  groups: [
    {
      categoryGroup: "Bills",
      categories: ["Housing", "Utilities"],
      bars: bars(150_000, 200_000),
    },
    {
      categoryGroup: "Shopping",
      categories: ["Groceries", "Superstores", "Clothing"],
      bars: bars(36_000, 110_000),
    },
    { categoryGroup: "Transportation", categories: ["Gas"], bars: bars(0, null) },
  ],
};

// Two charges, one on a card, a payday, and a card's payment due, from $1,000 in checking.
const COMING_UP: ComingUpView = {
  from: "2026-10-21",
  to: "2026-11-03",
  outgoing: 62_699,
  checking: 100_000,
  lowest: { amount: 40_000, date: "2026-10-25" },
  rows: [
    {
      date: "2026-10-22",
      late: false,
      kind: "Recurring charge",
      what: "Streamflix",
      amount: -1_799,
      onCard: true,
      checkingAfter: null,
    },
    {
      date: "2026-10-25",
      late: false,
      kind: "card payment",
      what: "Rewards Card payment",
      amount: -60_000,
      onCard: false,
      checkingAfter: 40_000,
    },
    {
      date: "2026-10-30",
      late: false,
      kind: "payday",
      what: "Northwind Logistics",
      amount: 186_590,
      onCard: false,
      checkingAfter: 226_590,
    },
    {
      date: "2026-11-02",
      late: false,
      kind: "Recurring charge",
      what: "Ironworks Fitness",
      amount: -900,
      onCard: false,
      checkingAfter: 225_690,
    },
  ],
};

const goal = (fields: Partial<GoalView> = {}): GoalView => ({
  id: "g1",
  words: "Spend less on eating out",
  authorId: "m1",
  author: "Alex",
  date: "2026-09-02",
  status: "active",
  endedOn: null,
  endedBy: null,
  reading: { target: { kind: "Category", category: "Restaurants" }, change: null, deadline: null },
  goalAmount: 48_000,
  startsOn: "2026-09-01",
  list: "active",
  progress: {
    kind: "spend less",
    percentage: 62,
    state: "Behind",
    detail: "On pace for $540 this month; Goal is $480",
    estimated: false,
  },
  ...fields,
});

// Three active Goals (one Behind, one On track from an estimate, one Done this month), then one in
// the done list and one in the dropped list, which the dashboard leaves out.
const GOALS: GoalsAnswer = {
  aiProvider: true,
  waitsForHistory: false,
  goals: [
    goal(),
    goal({
      id: "g2",
      words: "Save $5,000 for the trip by June",
      author: "Sam",
      reading: { target: { kind: "Saving" }, change: { amount: 500_000 }, deadline: "2027-06-30" },
      progress: {
        kind: "save toward an amount",
        percentage: 40,
        state: "On track",
        detail: "$2,000 of $5,000",
        estimated: true,
      },
    }),
    goal({
      id: "g3",
      words: "Pay off the car",
      status: "done",
      endedOn: "2026-10-12",
      progress: {
        kind: "pay down a loan",
        percentage: 100,
        state: "Done",
        detail: "$0 left",
        estimated: false,
      },
    }),
    goal({ id: "g4", words: "Old done Goal", status: "done", list: "done", progress: null }),
    goal({ id: "g5", words: "Dropped Goal", status: "dropped", list: "dropped", progress: null }),
  ],
};

const note = (fields: Partial<AiBoxNoteView> = {}): AiBoxNoteView => ({
  kind: "Alert note",
  id: "a1",
  createdAt: "2026-10-19T14:00:00.000Z",
  figure: "$36.00",
  figureLabel: "interest on Oct 9",
  about: "Rewards Card ··4821",
  title: "Card interest on Rewards Card ··4821",
  why: ["Card interest: $36.00 on Rewards Card ··4821 on Oct 9."],
  nextStep: null,
  done: false,
  ...fields,
});

// Two Alert notes worth acting on, one of them Done, and one heads up. AI is on.
const AI_BOX: AiBoxView = {
  worthActingOn: 1,
  groups: [
    {
      name: "Worth acting on",
      notes: [
        note({
          id: "a2",
          figure: "$120",
          figureLabel: "over Budget",
          about: "Restaurants",
          title: "Restaurants is over Budget for Oct 2026",
          why: ["Restaurants is over Budget for Oct 2026: $600 of $480. Latest: $42.50 on Oct 19."],
          nextStep: "Skip one takeout night this week.",
        }),
        note({ done: true }),
      ],
    },
    {
      name: "Heads up",
      notes: [
        note({
          id: "a3",
          figure: "$15.99",
          figureLabel: "next on Nov 14",
          about: "Streamflix",
          title: "New Recurring charge at Streamflix?",
          why: ["New Recurring charge? Streamflix, $15.99 on Sep 14 and Oct 14."],
        }),
      ],
    },
  ],
  setUpAi: false,
  paused: null,
};

const data = (fields: Partial<DashboardData> = {}): DashboardData => ({
  timeZone: ZONE,
  month: dashboardMonth(NOW, ZONE),
  connections: [connection()],
  history: { waitEnded: true, aiMayRun: true, loading: [] },
  notices: [],
  budgets: BUDGETS,
  numberTiles: NUMBER_TILES,
  usualMonth: USUAL_MONTH,
  comingUp: COMING_UP,
  goals: GOALS,
  aiBox: AI_BOX,
  ...fields,
});

function render(shown: DashboardData, openGroup?: string, whyOpen?: string): string {
  const page = (
    <DashboardReport
      data={shown}
      onClose={() => {}}
      onRetry={() => {}}
      onChanged={() => {}}
      {...(openGroup === undefined ? {} : { openGroup })}
      {...(whyOpen === undefined ? {} : { whyOpen })}
    />
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

// The HTML inside the element with `data-slot`, which must hold no element of its own tag.
function slotHtml(html: string, slot: string): string {
  const match = new RegExp(`<(\\w+)[^>]*data-slot="${slot}"[^>]*>(.*?)</\\1>`, "s").exec(html);
  if (match === null) throw new Error(`No data-slot="${slot}".`);
  return match[2] ?? "";
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
      <StatusLineList
        lines={statusLines(shown.notices, shown.connections, shown.history, shown.month.today)}
        onClose={() => {}}
        onRetry={onRetry}
        onChanged={() => {}}
      />,
    );
    expect([...buttons.keys()]).toEqual(["Retry", "Close"]);
    buttons.get("Retry")?.();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The page hands its own Retry to those status lines.
    const page = DashboardReport({
      data: shown,
      onClose: () => {},
      onRetry,
      onChanged: () => {},
    });
    const parts = isValidElement<{ children?: ReactNode }>(page)
      ? [page.props.children].flat()
      : [];
    const lines = parts.find((part) => isValidElement(part) && part.type === StatusLineList);
    expect(isValidElement<{ onRetry?: unknown }>(lines) && lines.props.onRetry).toBe(onRetry);
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

// The `href` of each link in `html`, in order.
const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replace(/&amp;/g, "&"),
  );

describe("the number tiles", () => {
  it("shows each number, its direction against usual, the estimated loans, and where each opens", () => {
    const html = render(data());
    const tiles = /<ul aria-label="Number tiles"[^>]*>(.*?)<\/ul>/s.exec(html)?.[1];

    expect(listItems(html, "Number tiles")).toEqual([
      "Spending in September $4,120 ▲ $120 above usual",
      "Income in September $6,500 ● about usual",
      "Cash on hand $12,345 ▼ $655 below usual",
      "Debt $8,200 ▲ $200 above usual Debt includes 2 estimated loans",
    ]);
    expect(hrefs(tiles ?? "")).toEqual([
      "/top-merchants",
      "/transactions?type=Income&month=2026-09",
      "/accounts",
      "/accounts",
    ]);
    // More Spending or Debt is bad (orange); less Cash on hand is bad too; no change is grey.
    expect(tiles).toContain('class="block text-sm text-orange-700">▲ $120 above usual');
    expect(tiles).toContain('class="block text-sm text-gray-500">● about usual');
    expect(tiles).toContain('class="block text-sm text-orange-700">▼ $655 below usual');
  });

  it("says about usual within 2% of the usual, either way", () => {
    expect(changeAgainstUsual(102_000, 100_000)).toBe(0);
    expect(changeAgainstUsual(98_000, 100_000)).toBe(0);
    expect(changeAgainstUsual(102_001, 100_000)).toBe(2_001);
    expect(changeAgainstUsual(97_999, 100_000)).toBe(-2_001);
    // Debt's usual is what is owed; a usual of $0 has no band.
    expect(changeAgainstUsual(0, 0)).toBe(0);
    expect(changeAgainstUsual(5_000, 0)).toBe(5_000);
  });

  it("shows no direction and no note before a complete month, and no note with no Manual loan", () => {
    const html = render(
      data({
        numberTiles: {
          ...NUMBER_TILES,
          spending: tile(0, null),
          debt: { ...tile(820_000, null), estimatedLoans: 0 },
        },
      }),
    );
    const [spending, , , debt] = listItems(html, "Number tiles");

    expect(spending).toBe("Spending in September $0");
    expect(debt).toBe("Debt $8,200");
  });
});

// A monthly Budget in October, with its Spending, projection, and status.
const monthly = (
  category: string,
  categoryGroup: string,
  amount: number,
  spending: number,
  projected: number,
  status: BudgetStatusView,
  context: string | null = null,
): MonthBudgetView => ({
  category,
  categoryGroup,
  amount,
  period: "monthly",
  takesEffect: "2026-10",
  source: "formula",
  setBy: null,
  reason: null,
  pinned: categoryGroup === "Bills" ? false : null,
  spending,
  projected,
  status,
  shareOfYear: null,
  context,
});

// Shopping: Groceries Over Budget, Clothing On pace, and Superstores with no Budget. Bills: Housing
// On pace, with its Benchmark context, and Utilities on track.
const USUAL_BUDGETS: BudgetsView = {
  ...BUDGETS,
  budgets: [
    monthly(
      "Housing",
      "Bills",
      180_000,
      140_000,
      185_000,
      "On pace",
      "Housing is 41% of Income; typical is 33%",
    ),
    monthly("Utilities", "Bills", 20_000, 10_000, 15_000, "on track"),
    monthly("Groceries", "Shopping", 50_000, 61_000, 80_000, "Over Budget"),
    monthly("Clothing", "Shopping", 20_000, 15_000, 26_000, "On pace"),
  ],
  unbudgeted: [
    { category: "Superstores", categoryGroup: "Shopping", spending: 4_000, projected: 6_000 },
  ],
  groups: [
    { ...group("Bills", 200_000, 150_000, 200_000), overBudget: 0, onPace: 1, status: "On pace" },
    {
      ...group("Shopping", 70_000, 80_000, 112_000),
      overBudget: 1,
      onPace: 1,
      status: "Over Budget",
    },
    group("Transportation", 0, null, null),
  ],
};

describe('"A usual month"', () => {
  it("shows the usual, the month's pace against it, and each group's Spending, Budget, and status", () => {
    const html = render(data({ budgets: USUAL_BUDGETS }));

    expect(slotText(html, "usual")).toBe("$3,000");
    // On pace for $3,120 against a usual of $3,000: $120 above, past the 2% band.
    expect(slotText(html, "usual-line")).toBe("October is on pace for $3,120, $120 above usual");
    expect(html).toContain('class="text-orange-700" data-slot="usual-line"');
    expect(listItems(html, "Category groups")).toEqual([
      "Bills $1,500 of $2,000 ◆ 1 on pace to go over",
      "Shopping $800 of $700 ▲ 1 over",
      "Transportation $0, no Budget",
    ]);
    // No group's Budgets show until a Member taps a group.
    expect(html).not.toContain('data-slot="group-budgets"');
  });

  it("words the pace line below usual and about usual", () => {
    const month = dashboardMonth(NOW, ZONE);
    expect(usualMonthLine(month, 290_000, 300_000)).toEqual({
      tone: "good",
      text: "October is on pace for $2,900, $100 below usual",
    });
    expect(usualMonthLine(month, 306_000, 300_000)).toEqual({
      tone: "muted",
      text: "October is on pace for $3,060, about usual",
    });
    expect(usualMonthLine(month, 306_000, null)).toEqual({
      tone: "muted",
      text: "October is on pace for $3,060",
    });
  });

  it("marks this month's bar and draws no Budget line before the first draft", () => {
    const shopping = USUAL_MONTH.groups[1];
    if (shopping === undefined) throw new Error("No Shopping group.");

    expect(groupBars(shopping, dashboardMonth(NOW, ZONE))).toEqual([
      { month: "2026-09", label: "Sep 2026", spending: 36_000, budget: null, current: false },
      { month: "2026-10", label: "Oct 2026", spending: 36_000, budget: 110_000, current: true },
    ]);
  });

  it("opens a group's Budgets worst first, each row opening its Transactions, with Close", () => {
    const html = render(data({ budgets: USUAL_BUDGETS }), "Shopping");
    const panel = slotHtml(html, "group-budgets");

    expect(text(panel)).toMatch(/^Shopping Budgets Close /);
    expect(listItems(panel, "Shopping Budgets")).toEqual([
      "Groceries $610 / $500 ▲ $110 over",
      "Clothing $150 / $200 ◆ on pace for $260",
      "Superstores $40 no Budget",
    ]);
    expect(hrefs(panel)).toEqual([
      "/transactions?category=Groceries&month=2026-10",
      "/transactions?category=Clothing&month=2026-10",
      "/transactions?category=Superstores&month=2026-10",
    ]);
    // Each flexible row with a Budget has a meter with a "today" tick.
    expect(panel.match(/data-slot="row-meter"/g)).toHaveLength(2);
    expect(panel.match(/data-slot="today"/g)).toHaveLength(2);
  });

  it("gives Bills rows their Benchmark context and no today tick", () => {
    const panel = slotHtml(render(data({ budgets: USUAL_BUDGETS }), "Bills"), "group-budgets");

    expect(listItems(panel, "Bills Budgets")).toEqual([
      "Housing $1,400 / $1,800 ◆ on pace for $1,850 Housing is 41% of Income; typical is 33%",
      "Utilities $100 / $200",
    ]);
    expect(panel.match(/data-slot="row-meter"/g)).toHaveLength(2);
    expect(panel).not.toContain('data-slot="today"');
  });
});

describe("Goals", () => {
  it("shows N of M on track, then a box per active Goal with its author, words, status, bar, and detail", () => {
    const html = render(data());
    const box = slotHtml(html, "goals");

    expect(text(box.slice(0, box.indexOf("<ul")))).toBe("Goals 2 of 3 on track Add a Goal");
    // A screen reader reads the heading's own text, so a space parts "Goals" from the count.
    expect(
      text(/<h2 id="goals"[^>]*>(.*?)<\/h2>/s.exec(box)?.[1]?.replace(/<[^>]+>/g, "") ?? ""),
    ).toBe("Goals 2 of 3 on track");
    expect(slotHtml(html, "add-goal")).toBe("Add a Goal");
    // It opens the Goals page with the "Add a Goal" form open.
    expect(box).toMatch(/<a (?=[^>]*href="\/goals\?add=1")[^>]*data-slot="add-goal"/);
    expect(listItems(box, "Active Goals")).toEqual([
      "Alex “Spend less on eating out” ◆ Behind 62% On pace for $540 this month; Goal is $480",
      "Sam “Save $5,000 for the trip by June” ✓ On track 40% estimated $2,000 of $5,000",
      "Alex “Pay off the car” ✓ Done 100% $0 left",
    ]);
    // Each bar is as long as its percentage.
    expect(
      [...box.matchAll(/data-slot="goal-bar" style="width:(\d+)%"/g)].map((m) => m[1]),
    ).toEqual(["62", "40", "100"]);
    // The done and dropped lists are on the Goals page only.
    expect(box).not.toContain("Old done Goal");
    expect(box).not.toContain("Dropped Goal");
  });

  it("names a removed Member, and shows only the words for a Goal with no progress", () => {
    const html = render(
      data({
        goals: {
          aiProvider: true,
          waitsForHistory: false,
          goals: [
            goal({ author: null, authorId: null }),
            goal({ id: "g2", words: "Be better with money", progress: null }),
            goal({
              id: "g3",
              words: "Save for a rainy day",
              progress: {
                kind: "save toward an amount",
                percentage: null,
                state: null,
                detail: "Goal amount not set yet",
                estimated: false,
              },
            }),
          ],
        },
      }),
    );

    expect(slotText(html, "on-track")).toBe("0 of 3 on track");
    expect(listItems(slotHtml(html, "goals"), "Active Goals")).toEqual([
      "A removed Member “Spend less on eating out” ◆ Behind 62% On pace for $540 this month; Goal is $480",
      "Alex “Be better with money”",
      "Alex “Save for a rainy day” Goal amount not set yet",
    ]);
  });

  it("says that Goals need an AI provider, linking to the AI settings, with no AI provider", () => {
    const html = render(data({ goals: { ...GOALS, aiProvider: false } }));
    const box = slotHtml(html, "goals");

    expect(box).toMatch(/<a (?=[^>]*href="\/settings\/ai")[^>]*data-slot="needs-ai"/);
    expect(slotText(html, "needs-ai")).toBe("Goals need an AI provider");
    expect(box).not.toContain("Add a Goal");
    // The active Goals still show.
    expect(listItems(box, "Active Goals")).toHaveLength(3);
  });

  it("says that Goals wait until history has loaded, with no Add a Goal", () => {
    const html = render(data({ goals: { ...GOALS, waitsForHistory: true } }));
    const box = slotHtml(html, "goals");

    expect(slotText(html, "goals-wait")).toBe("Goals open when your history has loaded.");
    expect(box).not.toContain("Add a Goal");
    expect(listItems(box, "Active Goals")).toHaveLength(3);
  });

  it("wraps a Goal's one long word, so the dashboard never scrolls sideways", () => {
    const long = "x".repeat(90);
    const goals = GOALS.goals.map((shown) => ({ ...shown, words: long }));
    const box = slotHtml(render(data({ goals: { ...GOALS, goals } })), "goals");

    const wrapped = box.match(
      new RegExp(
        `<span class="[^"]*\\bwrap-anywhere\\b[^"]*" data-slot="goal-words">“(?:<!-- -->)?${long}`,
        "g",
      ),
    );
    expect(wrapped).toHaveLength(listItems(box, "Active Goals").length);
  });

  it("shows only the heading and Add a Goal with no active Goal", () => {
    const ended = GOALS.goals.filter((shown) => shown.list !== "active");
    const box = slotHtml(render(data({ goals: { ...GOALS, goals: ended } })), "goals");

    expect(text(box)).toBe("Goals Add a Goal");
    expect(box).not.toContain("<ul");
  });
});

// The rows of the table in the element with `data-slot`: each row's class and its cells' words.
function tableRows(html: string, slot: string): { className: string; cells: string[] }[] {
  const body = /<tbody>(.*?)<\/tbody>/s.exec(slotHtml(html, slot))?.[1] ?? "";
  return [...body.matchAll(/<tr([^>]*)>(.*?)<\/tr>/gs)].map((row) => ({
    className: /class="([^"]*)"/.exec(row[1] ?? "")?.[1] ?? "",
    cells: [...(row[2] ?? "").matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((cell) =>
      text(cell[1] ?? ""),
    ),
  }));
}

describe("Coming up", () => {
  it("shows the total due, the lowest checking balance, and each row in cents, paydays in bold", () => {
    const html = render(data());
    const box = slotHtml(html, "coming-up");

    expect(text(box)).toContain("Due in the next 14 days");
    expect(slotText(html, "due-total")).toBe("$627");
    expect(slotText(html, "lowest")).toBe("Lowest checking balance: $400 on Oct 25");
    expect(text(/<thead>(.*?)<\/thead>/s.exec(box)?.[1] ?? "")).toBe(
      "Date What Amount Checking after",
    );
    const rows = tableRows(html, "coming-up");
    expect(rows.map((row) => row.cells)).toEqual([
      ["Oct 22", "Streamflix", "−$17.99", "on card"],
      ["Oct 25", "Rewards Card payment", "−$600.00", "$400.00"],
      ["Oct 30", "Northwind Logistics payday", "+$1,865.90", "$2,265.90"],
      ["Nov 2", "Ironworks Fitness", "−$9.00", "$2,256.90"],
    ]);
    expect(rows.map((row) => row.className.includes("font-semibold"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("holds the same rows on two lines each for a narrow box, paydays in bold", () => {
    const html = render(data());
    const lines = [...slotHtml(html, "due-lines").matchAll(/<li([^>]*)>(.*?)<\/li>/gs)].map(
      (item) => ({
        bold: (item[1] ?? "").includes("font-semibold"),
        lines: [...(item[2] ?? "").matchAll(/<span class="flex[^"]*">(.*?)<\/span><\/span>/gs)].map(
          (line) => text(`${line[1] ?? ""}</span>`),
        ),
      }),
    );

    expect(lines).toEqual([
      { bold: false, lines: ["Oct 22 Streamflix", "−$17.99 on card"] },
      { bold: false, lines: ["Oct 25 Rewards Card payment", "−$600.00 $400.00"] },
      { bold: true, lines: ["Oct 30 Northwind Logistics payday", "+$1,865.90 $2,265.90"] },
      { bold: false, lines: ["Nov 2 Ironworks Fitness", "−$9.00 $2,256.90"] },
    ]);
  });

  it('says "late" in place of the date for a late Recurring charge', () => {
    const late = {
      date: "2026-10-20",
      late: true,
      kind: "Recurring charge",
      what: "Oakwood Property Management",
      amount: -180_000,
      onCard: false,
      checkingAfter: -80_000,
    } as const;
    const html = render(data({ comingUp: { ...COMING_UP, rows: [late, ...COMING_UP.rows] } }));

    expect(tableRows(html, "coming-up")[0]?.cells).toEqual([
      "late",
      "Oakwood Property Management",
      "−$1,800.00",
      "−$800.00",
    ]);
    expect(text(slotHtml(html, "due-lines"))).toMatch(/^late Oakwood Property Management/);
  });

  it("opens the Recurring charges page when tapped", () => {
    const box = slotHtml(render(data()), "coming-up");

    expect(box).toMatch(/^<a [^>]*href="\/recurring-charges"/);
    expect(box.trim().endsWith("</a>")).toBe(true);
  });

  it("shows no lowest line and no checking balance with no connected checking Account", () => {
    const html = render(
      data({
        comingUp: {
          ...COMING_UP,
          checking: null,
          lowest: null,
          rows: COMING_UP.rows.map((row) => ({ ...row, checkingAfter: null })),
        },
      }),
    );

    expect(html).not.toContain('data-slot="lowest"');
    expect(tableRows(html, "coming-up").map((row) => row.cells[3])).toEqual([
      "on card",
      "",
      "",
      "",
    ]);
  });

  it("shows $0 and an empty table with nothing due", () => {
    const html = render(data({ comingUp: { ...COMING_UP, outgoing: 0, rows: [] } }));

    expect(slotText(html, "due-total")).toBe("$0");
    expect(tableRows(html, "coming-up")).toEqual([]);
  });
});

// --- Layout at a screen width, from the page's own Tailwind classes ----------------------------

type Rule = { minWidth: number; minBox: number; className: string; body: string };

// The class rules in Tailwind's CSS, each with the screen width it needs (0, or the N of an
// `@media (width >= Npx)` around it) and the box width it needs (0, or the N of an
// `@container (width >= Npx)` around it).
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (block: string, minWidth: number, minBox: number) => {
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
      const container = /^@container \(width >= (\d+)px\)$/.exec(head);
      if (media !== null) walk(body, Number(media[1]), minBox);
      else if (container !== null) walk(body, minWidth, Number(container[1]));
      else if (head.startsWith(".")) {
        rules.push({ minWidth, minBox, className: head.slice(1).replace(/\\(.)/g, "$1"), body });
      }
      at = end;
    }
  };
  walk(css, 0, 0);
  return rules;
}

// The CSS properties each element with a data-slot gets at a screen width, inside a box `box` px
// wide (its nearest `@container`).
async function layoutOf(html: string) {
  const all = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    (match[1] ?? "").split(/\s+/),
  );
  const rules = rulesOf((await compile("@tailwind utilities;")).build([...new Set(all)]));
  return (slot: string, width: number, box = 0) => {
    const classes = new Set(
      (new RegExp(`class="([^"]*)"[^>]*data-slot="${slot}"`).exec(html)?.[1] ?? "").split(/\s+/),
    );
    const style = new Map<string, string>();
    for (const rule of rules) {
      if (rule.minWidth > width || rule.minBox > box || !classes.has(rule.className)) continue;
      for (const declaration of rule.body.split(";")) {
        const [property = "", ...value] = declaration.split(":");
        if (property.trim() !== "") style.set(property.trim(), value.join(":").trim());
      }
    }
    return style;
  };
}

describe('the AI box, "This week"', () => {
  // The AI box's HTML: the box in the left column.
  const aiBox = (html: string) => {
    const end = html.lastIndexOf("</section>", html.indexOf('data-slot="right-column"'));
    return html.slice(html.indexOf('<section aria-label="This week"'), end + "</section>".length);
  };
  // True when the note's own row is faded.
  const faded = (item: string) =>
    (/^<li class="([^"]*)"/.exec(item)?.[1] ?? "").split(" ").includes("opacity-50");
  const box = (view: Partial<AiBoxView> = {}, whyOpen?: string) =>
    aiBox(render(data({ aiBox: { ...AI_BOX, ...view } }), undefined, whyOpen));
  const notes = (html: string) =>
    [...html.matchAll(/<li[^>]*data-slot="ai-note"[^>]*>(.*?)<\/li>/gs)].map((item) => item[0]);

  it("is labelled This week, counts the notes worth acting on that are not Done, and shows each group in order with its count", () => {
    const html = box();

    expect(html).toContain('aria-label="This week"');
    expect(slotText(html, "ai-heading")).toBe("1 thing worth acting on");
    expect(text(html)).toMatch(/^This week 1 thing worth acting on ◆ Worth acting on 2 /);
    expect(listItems(html, "Worth acting on")).toHaveLength(2);
    expect(listItems(html, "Heads up")).toHaveLength(1);
    expect(text(html).indexOf("◆ Worth acting on 2")).toBeLessThan(
      text(html).indexOf("● Heads up 1"),
    );
    // An empty group is hidden; nothing hides behind "Show all".
    expect(text(html)).not.toContain("Good news");
    expect(text(html)).not.toContain("Show all");
    expect(html).not.toContain('data-slot="nothing-new"');
    expect(html).not.toContain('data-slot="set-up-ai"');
    expect(html).not.toContain('data-slot="ai-paused"');

    const two = box({ worthActingOn: 2 });
    expect(slotText(two, "ai-heading")).toBe("2 things worth acting on");
    const none = box({ worthActingOn: 0 });
    expect(slotText(none, "ai-heading")).toBe("0 things worth acting on");
  });

  it("shows a note's number and label, what it is about and its title, Why?, the AI's Next step, Done, and Ask about this", () => {
    const [overBudget, done] = notes(box());

    expect(text(overBudget ?? "")).toBe(
      "$120 over Budget Restaurants Restaurants is over Budget for Oct 2026 Why? Restaurants is over Budget for Oct 2026: $600 of $480. Latest: $42.50 on Oct 19. Next step: Skip one takeout night this week. AI Done Ask about this",
    );
    expect(slotText(overBudget ?? "", "note-figure")).toBe("$120 over Budget");
    // "Why?" opens the reason in place; until then it is hidden.
    expect(overBudget).toMatch(/aria-expanded="false"/);
    expect(overBudget).toMatch(/<div id="[^"]+" hidden=""[^>]*data-slot="note-why"/);
    expect(overBudget).toContain('aria-pressed="false"');
    expect(faded(overBudget ?? "")).toBe(false);

    // Without advice, an Alert note has no Next step line.
    expect(done).not.toContain('data-slot="next-step"');
    expect(text(done ?? "")).not.toContain("Next step");
  });

  it('opens the reason with "Hide why"', () => {
    const [overBudget] = notes(box({}, "a2"));

    expect(overBudget).toMatch(/aria-expanded="true"/);
    expect(text(overBudget ?? "")).toContain("Hide why Restaurants is over Budget");
    expect(overBudget).not.toMatch(/hidden=""[^>]*data-slot="note-why"/);
  });

  it('fades a done note in place, with "Done ✓" to clear the mark', () => {
    const [, done] = notes(box());

    expect(faded(done ?? "")).toBe(true);
    expect(done).toContain('aria-pressed="true"');
    expect(text(done ?? "")).toContain("Done ✓ Ask about this");
  });

  it('shows "Set up AI for insights", linking to the AI settings, with no AI provider', () => {
    const html = box({ setUpAi: true });

    expect(slotText(html, "set-up-ai")).toBe("Set up AI for insights");
    expect(slotHtml(html, "set-up-ai")).toContain('href="/settings/ai"');
    expect(notes(html)).toHaveLength(3);
  });

  it("says when AI is paused, under the heading", () => {
    const capped = box({ paused: { reason: "cost cap", until: "2026-11-01" } });
    expect(slotText(capped, "ai-paused")).toBe("AI paused until Nov 1");
    expect(text(capped)).toMatch(/^This week 1 thing worth acting on AI paused until Nov 1 ◆/);

    const rejected = box({ paused: { reason: "key rejected" } });
    expect(slotText(rejected, "ai-paused")).toBe("AI paused: check the AI key");
  });

  it('says "Nothing new this week." with no notes', () => {
    const html = box({ worthActingOn: 0, groups: [] });

    expect(slotText(html, "nothing-new")).toBe("Nothing new this week.");
    expect(notes(html)).toEqual([]);
    expect(html).not.toContain('data-slot="ai-group"');

    // With no AI provider, the set-up note shows as well.
    const noAi = box({ worthActingOn: 0, groups: [], setUpAi: true });
    expect(text(noAi)).toBe(
      "This week 0 things worth acting on Nothing new this week. Set up AI for insights",
    );
  });

  it("shows an open Proposal first in Worth acting on: its change, its reason, Accept, Edit, Skip, and Ask about this, with no Done", () => {
    const proposal: AiBoxProposalView = {
      kind: "Proposal",
      id: "p1",
      createdAt: "2026-10-20T14:00:00.000Z",
      proposal: {
        id: "p1",
        kind: "Budget change",
        source: "Budget tailoring",
        createdAt: "2026-10-20T14:00:00.000Z",
        reason: "Takeout has been steady, so a lower Budget fits.",
        changes: ["Restaurants Budget: $600 → $480"],
        budgets: [{ category: "Restaurants", from: 60_000, to: 48_000, period: "monthly" }],
        goal: null,
        words: null,
      },
    };
    const [worth, ...rest] = AI_BOX.groups;
    const html = box({
      worthActingOn: 2,
      groups: [{ name: "Worth acting on", notes: [proposal, ...(worth?.notes ?? [])] }, ...rest],
    });

    expect(slotText(html, "ai-heading")).toBe("2 things worth acting on");
    const items = listItems(html, "Worth acting on");
    expect(items).toHaveLength(3);
    expect(items[0]).toBe(
      "Proposal Restaurants Budget: $600 → $480 Takeout has been steady, so a lower Budget fits. AI Accept Edit Skip Ask about this",
    );
    expect(items[0]).not.toContain("Done");
  });

  it('links to the Monthly review in Heads up, "Your October review is ready", with Done and no "Ask about this"', () => {
    const link: AiBoxReviewLinkView = {
      kind: "Review link",
      id: "2026-10",
      createdAt: "2026-11-01T14:00:00.000Z",
    };
    const [worth, headsUp] = AI_BOX.groups;
    const html = box({
      groups: [
        ...(worth === undefined ? [] : [worth]),
        { name: "Heads up", notes: [...(headsUp?.notes ?? []), link] },
      ],
    });

    const items = listItems(html, "Heads up");
    expect(items).toHaveLength(2);
    expect(items[1]).toBe("Your October review is ready Done");
    expect(slotHtml(html, "review-link")).toContain('href="/reviews/2026-10"');
    // The link counts in no "worth acting on" heading.
    expect(slotText(html, "ai-heading")).toBe("1 thing worth acting on");
  });

  it("shows Insight cards after the Alert notes in each group, in the AI's order, each with the AI mark", () => {
    const card = (fields: Partial<AiBoxInsightCardView>): AiBoxInsightCardView => ({
      kind: "Insight card",
      id: "c1",
      figure: "$84",
      figureLabel: "on takeout fees",
      about: "Restaurants",
      title: "Delivery fees add up",
      why: "Six delivery orders this month each paid a fee.",
      picture: { type: "days", category: "Restaurants" },
      month: "2026-10",
      nextStep: "Pick up two orders a week instead.",
      done: false,
      ...fields,
    });
    const [worth, headsUp] = AI_BOX.groups;
    const html = box(
      {
        worthActingOn: 2,
        groups: [
          { name: "Worth acting on", notes: [...(worth?.notes ?? []), card({})] },
          ...(headsUp === undefined ? [] : [headsUp]),
          {
            name: "Good news",
            notes: [
              card({
                id: "c2",
                figure: "3",
                figureLabel: "months under Budget",
                about: "Groceries",
                title: "Groceries stayed under Budget",
                why: "Groceries came in under Budget in Aug, Sep and Oct.",
                picture: null,
                nextStep: "That leaves room for the Goal.",
              }),
              card({ id: "c3", figure: "", figureLabel: "", title: "Saved on fuel", done: true }),
            ],
          },
        ],
      },
      "c1",
    );

    const worthItems = listItems(html, "Worth acting on");
    expect(worthItems).toHaveLength(3);
    expect(worthItems[2]).toBe(
      "$84 on takeout fees Restaurants Delivery fees add up AI Hide why Six delivery orders this month each paid a fee. AI Next step: Pick up two orders a week instead. AI Done Ask about this",
    );
    // The picture shows under "Why?", inside the reason it opens.
    const [, , acting, , groceries, fuel] = notes(html);
    expect(slotHtml(acting ?? "", "note-why")).toContain('data-slot="note-picture"');
    // Chat takes Alert notes only: an Insight card's "Ask about this" is disabled, an Alert's is not.
    const ask = (item: string) => /<button[^>]*>Ask about this<\/button>/.exec(item)?.[0] ?? "";
    expect(ask(acting ?? "")).toContain(' disabled=""');
    expect(ask(notes(html)[0] ?? "")).not.toContain(' disabled=""');

    // A Good news card's last words carry no "Next step:" label, and a card with no picture or
    // no figure shows neither.
    const good = listItems(html, "Good news");
    expect(good[0]).toBe(
      "3 months under Budget Groceries Groceries stayed under Budget AI Why? Groceries came in under Budget in Aug, Sep and Oct. AI That leaves room for the Goal. AI Done Ask about this",
    );
    expect(groceries).not.toContain('data-slot="note-picture"');
    expect(slotText(fuel ?? "", "note-figure")).toBe("");
    expect(faded(fuel ?? "")).toBe(true);
    expect(text(fuel ?? "")).toContain("Done ✓ Ask about this");
    expect(text(html)).toMatch(/◆ Worth acting on 3 .* ● Heads up 1 .* ✓ Good news 2 /);
  });

  it("shows Good news last", () => {
    const html = box({
      groups: [
        ...AI_BOX.groups,
        { name: "Good news", notes: [note({ id: "a4", title: "Good news note" })] },
      ],
    });

    expect(text(html)).toMatch(/◆ Worth acting on 2 .* ● Heads up 1 .* ✓ Good news 1 /);
  });

  it("lets the number column grow to fit a large number, and breaks a long word in a note", async () => {
    const html = box({
      groups: [
        {
          name: "Heads up",
          notes: [
            note({
              figure: "$12,450.00",
              about: "Northwindtradingcompanyoutletstores",
              title: "Large purchase at Northwindtradingcompanyoutletstores",
            }),
          ],
        },
      ],
    });
    const styleOf = await layoutOf(html);

    // No fixed width: the column is at least 5rem, and as wide as "$12,450.00" on one line. The
    // test build has no theme, so it emits no spacing sizes: the classes say it.
    const columnClasses = (/class="([^"]*)"[^>]*data-slot="note-figure"/.exec(html)?.[1] ?? "")
      .split(" ")
      .filter((name) => /^(?:min-|max-)?w-/.test(name));
    expect(columnClasses.sort()).toEqual(["max-w-32", "min-w-20"]);
    expect(styleOf("note-figure", 375).get("flex-shrink")).toBe("0");
    expect(styleOf("note-number", 375).get("white-space")).toBe("nowrap");
    expect(slotText(html, "note-number")).toBe("$12,450.00");
    // A Merchant name with no space breaks inside the note, so the page never scrolls sideways.
    expect(styleOf("ai-note", 375).get("overflow-wrap")).toBe("anywhere");
  });
});

const BOXES = /data-slot="(ai-box|left-to-spend|goals|number-tiles|usual-month|coming-up)"/g;

describe("the dashboard's layout", () => {
  it("stacks every box at 375 px with the AI box first, and keeps the AI box in view at 1,200 px", async () => {
    const html = render(data());
    const styleOf = await layoutOf(html);
    const boxes = [...html.matchAll(BOXES)].map((match) => match[1] ?? "");

    // The AI box, then the right column top to bottom: Left to spend, Goals, the four number
    // tiles, "A usual month", and "Coming up". Each part is a box, and as in prototype variant H
    // each number tile is a box of its own, with no box around the four.
    expect(boxes).toEqual([
      "ai-box",
      "left-to-spend",
      "goals",
      "number-tiles",
      "usual-month",
      "coming-up",
    ]);
    for (const box of boxes.filter((box) => box !== "number-tiles")) {
      expect(styleOf(box, 375).get("border-width")).toBe("1px");
    }
    expect(styleOf("number-tiles", 375).has("border-width")).toBe(false);
    expect(styleOf("tile", 375).get("border-width")).toBe("1px");
    expect(html.match(/data-slot="tile"/g)).toHaveLength(4);
    expect(html.indexOf('data-slot="ai-column"')).toBeLessThan(
      html.indexOf('data-slot="right-column"'),
    );

    // The header, as in prototype variant H: the month at the left and "Day N of M · synced" at
    // the right, on one line where both fit.
    expect(styleOf("dashboard-header", 375).get("display")).toBe("flex");
    expect(styleOf("dashboard-header", 375).get("flex-wrap")).toBe("wrap");
    expect(styleOf("dashboard-header", 375).get("justify-content")).toBe("space-between");
    expect(styleOf("dashboard-header", 375).get("align-items")).toBe("baseline");

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

  // The width inside the number tiles box and "A usual month" box, measured in Chromium inside the
  // Shell at each screen width. From 900 px the right column is narrower than at 375 px.
  const BOX_AT = { 375: 309, 900: 210, 1050: 360, 1200: 510 } as const;
  // The number tiles have no box around them, so they share the column's full width: 34 px more.
  const TILES_AT = { 375: 343, 900: 244, 1050: 394, 1200: 544 } as const;
  const columns = (count: number) => `repeat(${count}, minmax(0, 1fr))`;

  it("sizes the tiles and the Category groups by their box, not by the screen", async () => {
    const html = render(data());
    const styleOf = await layoutOf(html);

    for (const box of ["number-tiles", "usual-month"]) {
      expect(styleOf(box, 375).get("container-type")).toBe("inline-size");
    }
    // The four number tiles: two by two in a narrow box, four in a row from a 480 px box. At
    // 900 px each tile in a row of four would be 47 px, too narrow for its amount.
    expect(styleOf("tiles", 375, TILES_AT[375]).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("tiles", 900, TILES_AT[900]).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("tiles", 1050, TILES_AT[1050]).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("tiles", 1200, TILES_AT[1200]).get("grid-template-columns")).toBe(columns(4));
    expect(styleOf("tiles", 1200, 479).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("tiles", 1200, 480).get("grid-template-columns")).toBe(columns(4));
    // No screen width alone moves them.
    expect(styleOf("tiles", 1920).get("grid-template-columns")).toBe(columns(2));

    // The Category groups: one column in the 900 px right column, two on a phone, three in a
    // wide box.
    expect(styleOf("groups", 900, BOX_AT[900]).get("grid-template-columns")).toBe(columns(1));
    expect(styleOf("groups", 375, BOX_AT[375]).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("groups", 1050, BOX_AT[1050]).get("grid-template-columns")).toBe(columns(2));
    expect(styleOf("groups", 1200, BOX_AT[1200]).get("grid-template-columns")).toBe(columns(3));
    expect(styleOf("groups", 1920).get("grid-template-columns")).toBe(columns(1));
  });

  it("shows Coming up's rows on two lines in a box under 360 px, and as a table from 360 px", async () => {
    const html = render(data());
    const styleOf = await layoutOf(html);

    // The box has the number tiles' width. At 900 px it is 210 px, too narrow for four columns.
    expect(styleOf("coming-up", 375).get("container-type")).toBe("inline-size");
    for (const screen of [375, 900] as const) {
      expect(styleOf("due-rows", screen, BOX_AT[screen]).get("display")).toBe("none");
      expect(styleOf("due-lines", screen, BOX_AT[screen]).has("display")).toBe(false);
    }
    for (const screen of [1050, 1200] as const) {
      expect(styleOf("due-rows", screen, BOX_AT[screen]).get("display")).toBe("table");
      expect(styleOf("due-lines", screen, BOX_AT[screen]).get("display")).toBe("none");
    }
    expect(styleOf("due-rows", 1200, 359).get("display")).toBe("none");
    expect(styleOf("due-rows", 1200, 360).get("display")).toBe("table");
    // No screen width alone switches them.
    expect(styleOf("due-rows", 1920).get("display")).toBe("none");
  });

  it("puts the Goal boxes in a row of equal boxes in a wide box, and stacks them on a phone", async () => {
    const html = render(data());
    const styleOf = await layoutOf(html);

    // The Goals box sits in the same column as the number tiles, so it has their width.
    expect(styleOf("goals", 375).get("container-type")).toBe("inline-size");
    for (const screen of [375, 900, 1050] as const) {
      expect(styleOf("goal-boxes", screen, BOX_AT[screen]).get("grid-template-columns")).toBe(
        columns(1),
      );
      expect(styleOf("goal-boxes", screen, BOX_AT[screen]).has("grid-auto-flow")).toBe(false);
    }
    // One row, each column the same width; a grid row stretches each box to the same height.
    expect(styleOf("goal-boxes", 1200, BOX_AT[1200]).get("grid-auto-flow")).toBe("column");
    expect(styleOf("goal-boxes", 1200, BOX_AT[1200]).get("grid-auto-columns")).toBe(
      "minmax(0, 1fr)",
    );
    expect(styleOf("goal-boxes", 1200, BOX_AT[1200]).has("align-items")).toBe(false);
  });
});
