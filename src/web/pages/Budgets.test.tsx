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
  monthSpentLine,
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

// Each section's heading, and each of its rows: its Category and its words. The group's total and
// status sit between the heading and the rows.
type Row = { category: string; words: string };
function sectionsOf(html: string): Record<string, Row[]> {
  const sections: Record<string, Row[]> = {};
  for (const [, heading = "", list = ""] of html.matchAll(
    /<h2[^>]*>(.*?)<\/h2>(?:(?!<\/section>).)*?<ul>(.*?)<\/ul><\/section>/gs,
  )) {
    sections[text(heading)] = [
      ...list.matchAll(/<li[^>]*data-category="([^"]*)"[^>]*>(.*?)<\/li>/gs),
    ].map((row) => ({ category: row[1] ?? "", words: text(row[2] ?? "") }));
  }
  return sections;
}

// The value in a Category's Budget box.
const boxValue = (html: string, category: string) =>
  new RegExp(`<input id="${category}"[^>]*value="([^"]*)"`).exec(html)?.[1];

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
    const html = report(VIEW);
    const sections = sectionsOf(html);

    expect(Object.keys(sections)).toEqual([
      ...CATEGORY_GROUPS.map((group) => group.name),
      "Yearly Budgets",
    ]);
    for (const group of CATEGORY_GROUPS) {
      const shown = (sections[group.name] ?? []).map((row) => row.category);
      expect(shown, group.name).toEqual(
        group.categories.map(({ name }) => name).filter((name) => name !== "Travel"),
      );
    }
    const row = (category: string) =>
      Object.values(sections)
        .flat()
        .find((each) => each.category === category)?.words;
    expect(row("Housing")).toBe(
      "Housing Housing is 41% of Income; typical is 33% $2,460 spent ✓ On track Follow the bill Housing Budget per month Save",
    );
    expect(row("Interest and fees")).toBe(
      "Interest and fees $35 spent ▲ $35 over Follow the bill Interest and fees Budget per month Save",
    );
    expect(row("Restaurants")).toBe(
      "Restaurants $210 spent ◆ on pace for $420 Restaurants Budget per month Save",
    );
    // Each Budget sits in its own box.
    expect(boxValue(html, "budget-housing")).toBe("2460");
    expect(boxValue(html, "budget-interest-and-fees")).toBe("0");
    expect(boxValue(html, "budget-restaurants")).toBe("300");
  });

  it("gives On pace with no projection its word, and an On track Budget its word", () => {
    const html = text(
      report({
        ...VIEW,
        budgets: [{ ...restaurants, projected: null }, budget("Groceries", "Shopping")],
      }),
    );

    expect(html).toContain("Restaurants $210 spent ◆ On pace to go over");
    expect(html).toContain("Groceries $0 spent ✓ On track");
  });

  it("heads each Category group with its Spending of its monthly Budget, and its status", () => {
    const group = (
      categoryGroup: string,
      fields: Partial<BudgetsView["groups"][number]>,
    ): BudgetsView["groups"][number] => ({
      categoryGroup,
      monthly: 0,
      yearly: 0,
      spending: null,
      projected: null,
      overBudget: null,
      onPace: null,
      status: null,
      ...fields,
    });
    const html = report({
      ...VIEW,
      groups: [
        group("Bills", {
          monthly: 261_000,
          spending: 258_500,
          overBudget: 1,
          status: "Over Budget",
        }),
        group("Leisure", { monthly: 30_000, spending: 21_000, onPace: 1, status: "On pace" }),
        group("Shopping", { monthly: 65_000, spending: 13_300, status: "on track" }),
        group("Other", { monthly: 0, yearly: 480_000 }),
      ],
    });
    const heading = (name: string) =>
      text(new RegExp(`<h2[^>]*>${name}</h2>(.*?)<ul>`, "s").exec(html)?.[1] ?? "");

    expect(heading("Bills")).toBe("$2,585 of $2,610 ▲ 1 over");
    expect(heading("Leisure")).toBe("$210 of $300 ◆ 1 on pace to go over");
    expect(heading("Shopping")).toBe("$133 of $650 ✓ on track");
    // A group with no monthly Budget has neither.
    expect(heading("Other")).toBe("");
    expect(heading("Pets")).toBe("");
    expect(
      monthSpentLine({
        ...VIEW,
        groups: [group("Leisure", { monthly: 30_000, spending: 21_000 })],
      }),
    ).toBe("$210 of $300 spent");
    expect(monthSpentLine({ ...VIEW, drafted: false })).toBeUndefined();
  });

  it("ticks today on each flexible Category's meter and the year's share on a yearly one, never on Bills", () => {
    const ticks = (html: string) =>
      Object.fromEntries(
        [...html.matchAll(/<li[^>]*data-category="([^"]*)"[^>]*>(.*?)<\/li>/gs)].map((row) => [
          row[1],
          /data-slot="meter-today"/.test(row[2] ?? "")
            ? /left:([\d.]+)%;?"[^>]*data-slot="meter-today"/.exec(row[2] ?? "")?.[1]
            : undefined,
        ]),
      );
    const withTicks = renderToString(
      <BudgetsReport view={VIEW} states={{}} accept={{}} actions={noActions} monthGone={0.2} />,
    );
    const shown = ticks(withTicks);

    expect(shown.Restaurants).toBe("20");
    expect(shown.Travel).toBe("84.2");
    expect(shown.Housing).toBeUndefined();
    expect(shown.Utilities).toBeUndefined();
    // A Category with no Budget has an empty meter and no tick.
    expect(shown.Groceries).toBeUndefined();
    expect(text(withTicks)).toContain("The black tick on each meter is today.");
    // Without the share of the month, only the yearly Budgets have a tick.
    expect(ticks(report(VIEW))).toMatchObject({ Restaurants: undefined, Travel: "84.2" });
    expect(report(VIEW)).not.toContain("tick-note");
  });

  it("colors each meter by its status", () => {
    const fill = (html: string, category: string) =>
      new RegExp(
        `data-category="${category}".*?class="([^"]*)"[^>]*data-slot="meter-fill"`,
        "s",
      ).exec(html)?.[1];
    const html = report(VIEW);

    expect(fill(html, "Interest and fees")).toContain("bg-critical");
    expect(fill(html, "Restaurants")).toContain("bg-serious");
    expect(fill(html, "Housing")).toContain("bg-accent");
  });

  it('shows "no Budget" and its Spending for a Category with no Budget', () => {
    const sections = sectionsOf(report(VIEW));

    expect(sections.Shopping?.[0]?.words).toBe("Groceries $421 spent no Budget");
    expect(sections.Shopping?.[1]?.words).toBe("Superstores $0 spent no Budget");
    // A yearly Category with no Budget stays in its Category group.
    expect(sections.Other?.map((row) => row.words)).toContain(
      "Gifts and donations $50 spent no Budget",
    );
  });

  it("puts the yearly Budgets in their own section at the end, with the year's Spending and the share of the year passed", () => {
    const html = report(VIEW);
    const sections = sectionsOf(html);

    expect(Object.keys(sections).at(-1)).toBe("Yearly Budgets");
    expect(sections["Yearly Budgets"]?.map((row) => row.words)).toEqual([
      "Travel 84% of the year has passed $1,800 spent this year ✓ On track Travel Budget per year Save",
    ]);
    expect(boxValue(html, "budget-travel")).toBe("4800");
    expect(sections.Leisure?.some((row) => row.category === "Travel")).toBe(false);
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
