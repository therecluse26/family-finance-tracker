import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORY_GROUPS } from "../../categories/list.ts";
import type { BudgetsView, MonthBudgetView } from "../../server/budgets-views.ts";
import {
  acceptAll,
  budgetRequests,
  budgetRows,
  ENTER_BUDGET,
  editBudget,
  followTheBill,
} from "../budgets.ts";
import { MORE_MENU } from "../menu.ts";
import { routes } from "../routes.tsx";
import {
  BEFORE_FIRST_DRAFT,
  type BudgetActions,
  BudgetRowItem,
  BudgetsReport,
  type RowState,
} from "./Budgets.tsx";

// The Budgets page (spec 07, Budgets page; spec 05, Context for Bills Budgets, Yearly Budgets).

const budget = (
  category: string,
  categoryGroup: string,
  fields: Partial<MonthBudgetView> = {},
): MonthBudgetView => ({
  category,
  categoryGroup,
  amount: 15_000,
  period: "monthly",
  takesEffect: "2026-11",
  source: "formula",
  setBy: null,
  reason: null,
  pinned: null,
  spending: 0,
  projected: null,
  status: "on track",
  shareOfYear: null,
  context: null,
  ...fields,
});

const housing = budget("Housing", "Bills", {
  amount: 246_000,
  spending: 246_000,
  pinned: false,
  context: "Housing is 41% of Income; typical is 33%",
});
const utilities = budget("Utilities", "Bills", {
  amount: 15_000,
  spending: 9_000,
  pinned: true,
  source: "Member edit",
  setBy: "member-a",
  context: "Utilities is 3% of Income; typical is 4%",
});
const interest = budget("Interest and fees", "Bills", {
  amount: 0,
  spending: 3_500,
  pinned: false,
  status: "Over Budget",
});
const restaurants = budget("Restaurants", "Leisure", {
  amount: 30_000,
  spending: 21_000,
  projected: 42_000,
  status: "On pace",
});
const travel = budget("Travel", "Leisure", {
  amount: 480_000,
  period: "yearly",
  takesEffect: "2026",
  spending: 180_000,
  shareOfYear: 0.842,
});

const VIEW: BudgetsView = {
  month: "2026-11",
  notice: null,
  fitNote: null,
  drafted: true,
  draftAccepted: false,
  budgets: [housing, utilities, interest, restaurants, travel],
  unbudgeted: [
    { category: "Groceries", categoryGroup: "Shopping", spending: 42_050, projected: 70_000 },
    { category: "Gifts and donations", categoryGroup: "Other", spending: 5_000, projected: null },
  ],
  groups: [],
};

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const noActions: BudgetActions = {
  type: () => {},
  save: () => {},
  followTheBill: () => {},
  acceptAll: () => {},
};
const report = (view: BudgetsView, states: Record<string, RowState> = {}) =>
  renderToString(<BudgetsReport view={view} states={states} accept={{}} actions={noActions} />);

// Each section's heading, and the words of each of its rows.
function sectionsOf(html: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  for (const [, heading = "", list = ""] of html.matchAll(
    /<h2[^>]*>(.*?)<\/h2><ul>(.*?)<\/ul><\/section>/gs,
  )) {
    sections[text(heading)] = [...list.matchAll(/<li[^>]*data-category[^>]*>(.*?)<\/li>/gs)].map(
      (row) => text(row[1] ?? ""),
    );
  }
  return sections;
}

// The controls in a tree, with what each does: each button by its words, and the "Follow the bill"
// switch. The row components have no state of their own, so each is called for its tree.
function controlsOf(element: ReactNode) {
  const buttons = new Map<string, () => void>();
  const switches: { checked: boolean; disabled: boolean; change: () => void }[] = [];
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
    const props = node.props as {
      children?: ReactNode;
      onClick?: () => void;
      onChange?: () => void;
      role?: string;
      checked?: boolean;
      disabled?: boolean;
    };
    if (node.type === "button" && props.onClick !== undefined) {
      buttons.set(words(props.children), props.onClick);
    }
    if (props.role === "switch" && props.onChange !== undefined) {
      switches.push({
        checked: props.checked === true,
        disabled: props.disabled === true,
        change: props.onChange,
      });
    }
    walk(props.children);
  };
  walk(element);
  return { buttons, switches };
}

describe("the Budgets page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each request the page sends: its method, path with query, and JSON body. A change answers with
  // `answer`.
  function recordRequests(answer: { status: number; body: unknown } = { status: 200, body: {} }) {
    const sent: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json(answer.body, { status: answer.status });
    });
    return sent;
  }

  it("is in the More section of the main menu, with its own page", () => {
    expect(MORE_MENU).toContainEqual({ label: "Budgets", path: "/budgets" });
    const page = routes
      .find((route) => route.path === "/")
      ?.children?.find((route) => route.path === "budgets");
    expect(page?.element).toBeDefined();
  });

  it("shows every Category by Category group, with this month's Spending, its Budget, and its status", () => {
    const sections = sectionsOf(report(VIEW));

    expect(Object.keys(sections)).toEqual([
      ...CATEGORY_GROUPS.map((group) => group.name),
      "Yearly Budgets",
    ]);
    for (const group of CATEGORY_GROUPS) {
      const shown = (sections[group.name] ?? []).map((row) => row.split(" $")[0]);
      expect(shown, group.name).toEqual(
        group.categories.map(({ name }) => name).filter((name) => name !== "Travel"),
      );
    }
    const row = (category: string) =>
      Object.values(sections)
        .flat()
        .find((each) => each.startsWith(`${category} $`));
    expect(row("Housing")).toBe(
      "Housing $2,460 of $2,460 ✓ On track Housing is 41% of Income; typical is 33% Follow the bill Edit Budget per month Save",
    );
    expect(row("Interest and fees")).toBe(
      "Interest and fees $35 of $0 ▲ Over Budget Follow the bill Edit Budget per month Save",
    );
    expect(row("Restaurants")).toBe(
      "Restaurants $210 of $300 ◆ On pace to go over Edit Budget per month Save",
    );
  });

  it('shows "no Budget" and its Spending for a Category with no Budget', () => {
    const sections = sectionsOf(report(VIEW));

    expect(sections.Shopping?.[0]).toBe("Groceries $421 no Budget");
    expect(sections.Shopping?.[1]).toBe("Superstores $0 no Budget");
    // A yearly Category with no Budget stays in its Category group.
    expect(sections.Other).toContain("Gifts and donations $50 no Budget");
  });

  it("puts the yearly Budgets in their own section at the end, with the year's Spending and the share of the year passed", () => {
    const html = report(VIEW);
    const sections = sectionsOf(html);

    expect(Object.keys(sections).at(-1)).toBe("Yearly Budgets");
    expect(sections["Yearly Budgets"]).toEqual([
      "Travel $1,800 of $4,800 this year ✓ On track 84% of the year has passed Edit Budget per year Save",
    ]);
    expect(sections.Leisure?.some((row) => row.startsWith("Travel"))).toBe(false);
    expect(sectionsOf(report({ ...VIEW, budgets: [housing] }))["Yearly Budgets"]).toBeUndefined();
  });

  it("shows the context line on each Bills Budget with a Benchmark only", () => {
    const html = text(report(VIEW));

    expect(html.match(/is \d+% of Income; typical is \d+%/g)).toEqual([
      "is 41% of Income; typical is 33%",
      "is 3% of Income; typical is 4%",
    ]);
  });

  it("shows an AI draft Budget's reason, marked as written by AI", () => {
    const reason = "Eating out can drop a little to make room for the trip.";
    const html = report({
      ...VIEW,
      budgets: [housing, { ...restaurants, source: "AI draft", reason }],
    });

    expect(html).toContain('data-slot="budget-reason"');
    expect(text(html)).toContain(`${reason} AI`);
    expect(text(report(VIEW))).not.toContain("Written by AI");
    expect(report(VIEW)).not.toContain("budget-reason");
  });

  it(`says "${BEFORE_FIRST_DRAFT}" before the first draft`, () => {
    const html = report({ ...VIEW, drafted: false, budgets: [], unbudgeted: VIEW.unbudgeted });

    expect(text(html)).toBe(BEFORE_FIRST_DRAFT);
  });

  it("shows the sample label and the fit note", () => {
    const html = text(
      report({
        ...VIEW,
        notice: "Sample numbers, not real data",
        fitNote: "The fixed costs pass Steady Income.",
      }),
    );

    expect(html).toContain("Sample numbers, not real data The fixed costs pass Steady Income.");
  });

  it("asks for the Household's month", async () => {
    const sent = recordRequests();

    await budgetRequests.budgets("2026-11");

    expect(sent).toEqual([{ method: "GET", path: "/api/budgets?month=2026-11", body: undefined }]);
  });

  it("edits a Budget in whole cents, and says why a bad amount or a refused edit did not save", async () => {
    const sent = recordRequests();
    const typed: string[] = [];
    const saved: [string, string][] = [];
    const actions: BudgetActions = {
      ...noActions,
      type: (each, words) => typed.push(`${each.category}: ${words}`),
      save: (each, words) => {
        saved.push([each.category, words]);
        void editBudget(each.category, words);
      },
    };

    controlsOf(
      BudgetRowItem({
        row: { category: "Restaurants", spending: 21_000, budget: restaurants },
        state: { typed: "$1,250.50" },
        actions,
      }),
    ).buttons.get("Save")?.();
    controlsOf(
      BudgetRowItem({
        row: { category: "Interest and fees", spending: 3_500, budget: interest },
        state: {},
        actions,
      }),
    ).buttons.get("Save")?.();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(saved).toEqual([
      ["Restaurants", "$1,250.50"],
      ["Interest and fees", "0"],
    ]);
    expect(sent).toEqual([
      { method: "PUT", path: "/api/budgets/Restaurants", body: { amount: 125_050 } },
      { method: "PUT", path: "/api/budgets/Interest%20and%20fees", body: { amount: 0 } },
    ]);
    expect(await editBudget("Restaurants", "lots")).toEqual({
      changed: false,
      error: ENTER_BUDGET,
    });
    expect(await editBudget("Restaurants", "-5")).toEqual({ changed: false, error: ENTER_BUDGET });
    expect(sent).toHaveLength(2);

    recordRequests({ status: 404, body: { error: "This Category has no Budget to change." } });
    expect(await editBudget("Pets", "100")).toEqual({
      changed: false,
      error: "This Category has no Budget to change.",
    });
    const html = text(
      renderToString(
        <BudgetRowItem
          row={{ category: "Restaurants", spending: 21_000, budget: restaurants }}
          state={{ error: "This Category has no Budget to change." }}
          actions={noActions}
        />,
      ),
    );
    expect(html).toContain("Save This Category has no Budget to change.");
  });

  it('gives each Bills Budget a "Follow the bill" switch, off while pinned, that puts it back on the formula', async () => {
    const sent = recordRequests();
    const actions: BudgetActions = {
      ...noActions,
      followTheBill: (each) => void followTheBill(each.category),
    };
    const switchOf = (row: MonthBudgetView) =>
      controlsOf(
        BudgetRowItem({
          row: { category: row.category, spending: row.spending, budget: row },
          state: {},
          actions,
        }),
      ).switches;

    // A pinned Bills Budget: off, and turning it on follows the bill.
    const [pinned] = switchOf(utilities);
    expect(pinned).toMatchObject({ checked: false, disabled: false });
    pinned?.change();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual([
      { method: "POST", path: "/api/budgets/Utilities/follow-the-bill", body: {} },
    ]);
    // A Bills Budget that follows the formula: on.
    expect(switchOf(housing)).toEqual([expect.objectContaining({ checked: true, disabled: true })]);
    expect(switchOf(interest)).toHaveLength(1);
    // No other Budget has the switch.
    expect(switchOf(restaurants)).toEqual([]);
    expect(switchOf(travel)).toEqual([]);

    recordRequests({
      status: 409,
      body: { error: "Only a pinned Bills Budget can follow the bill." },
    });
    expect(await followTheBill("Housing")).toEqual({
      changed: false,
      error: "Only a pinned Bills Budget can follow the bill.",
    });
  });

  it('accepts the whole draft with "Accept all", shown until it is accepted', async () => {
    const sent = recordRequests();
    const actions: BudgetActions = { ...noActions, acceptAll: () => void acceptAll() };

    controlsOf(BudgetsReport({ view: VIEW, states: {}, accept: {}, actions })).buttons.get(
      "Accept all",
    )?.();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent).toEqual([{ method: "POST", path: "/api/budgets/accept-all", body: {} }]);
    const accepted = report({ ...VIEW, draftAccepted: true });
    expect(text(accepted)).toContain("The draft is accepted.");
    expect(accepted).not.toContain("Accept all");
  });

  it("lists each Category once: in its Category group, or in the yearly section", () => {
    const rows = budgetRows(VIEW);

    expect(rows.yearly.map(({ category }) => category)).toEqual(["Travel"]);
    expect(rows.groups.flatMap((group) => group.rows).map(({ category }) => category)).toHaveLength(
      29,
    );
  });
});
