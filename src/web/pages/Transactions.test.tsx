import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountView } from "../../server/bank-views.ts";
import type {
  CategoryChosenBy,
  ShownPartView,
  TransactionDetailView,
  TransactionRowView,
} from "../../server/money-movement-views.ts";
import { MAIN_MENU } from "../menu.ts";
import { routes } from "../routes.tsx";
import {
  categoryOrType,
  filtersOf,
  transactionRequests,
  transactionsPath,
} from "../transactions.ts";
import {
  type CandidatePage,
  type DetailActions,
  type DetailForm,
  detailActions,
  formOf,
  TransactionDetailBody,
} from "./TransactionDetail.tsx";
import {
  accountLabels,
  datesKeyDown,
  datesLine,
  datesToggled,
  TransactionFilterForm,
  TransactionRows,
} from "./Transactions.tsx";

// The Transactions page and its detail view (spec 07, Transactions page): the filters and each
// edit, against the API.

const TODAY = "2026-11-04";

const ACCOUNT = (id: string, name: string, mask: string | null): AccountView => ({
  id,
  connectionId: "c1",
  name,
  kind: "depository",
  subtype: "checking",
  institutionName: "First Bank",
  mask,
  currentBalance: 250_000,
  availableBalance: 250_000,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
});
const ACCOUNTS = [
  ACCOUNT("a-checking", "Everyday Checking", "1234"),
  ACCOUNT("a-card", "Rewards Card", "9876"),
  { ...ACCOUNT("a-loan", "Lakeside Auto", null), kind: "loan", connectionId: null },
];

const part = (fields: Partial<ShownPartView> = {}): ShownPartView => ({
  type: "Spending",
  amount: -4_250,
  category: "Restaurants",
  linked: false,
  categoryChosenBy: "Plaid",
  ...fields,
});

const row = (id: string, fields: Partial<TransactionRowView> = {}): TransactionRowView => ({
  id,
  accountId: "a-card",
  amount: -4_250,
  postedDate: "2026-10-12",
  authorizedDate: null,
  pending: false,
  description: "CORNER BISTRO #12",
  merchantName: "Corner Bistro",
  merchant: "Corner Bistro",
  parts: [part()],
  ...fields,
});

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const inRouter = (node: ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);

type Props = Record<string, unknown> & { children?: ReactNode };

// Every element in a tree, with the trees of function components that use no hooks.
function elementsOf(node: ReactNode): { type: unknown; props: Props }[] {
  const found: { type: unknown; props: Props }[] = [];
  const walk = (each: ReactNode) => {
    if (Array.isArray(each)) return each.forEach(walk);
    if (!isValidElement<Props>(each)) return;
    found.push({ type: each.type, props: each.props });
    if (typeof each.type === "function" && each.type !== MemoryRouter) {
      const name = (each.type as { name?: string }).name ?? "";
      // Router links render with hooks; their children are words only.
      if (name !== "Link" && name !== "LinkWithRef") {
        walk((each.type as (props: Props) => ReactNode)(each.props));
        return;
      }
    }
    walk(each.props.children);
  };
  walk(node);
  return found;
}

const words = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(words).join("")
      : isValidElement<Props>(node)
        ? words(node.props.children)
        : "";

// The buttons by their words, and the fields by their names.
function controlsOf(node: ReactNode) {
  const elements = elementsOf(node);
  const buttons = new Map<string, () => void>();
  const fields = new Map<string, (value: string | boolean) => void>();
  for (const { type, props } of elements) {
    if (type === "button" && typeof props.onClick === "function") {
      buttons.set(words(props.children), props.onClick as () => void);
    }
    if ((type === "select" || type === "input") && typeof props.name === "string") {
      const onChange = props.onChange as (e: unknown) => void;
      fields.set(props.name, (value) =>
        onChange({ target: { value: String(value), checked: value === true } }),
      );
    }
  }
  return { buttons, fields };
}

// Each request sent: its method, path with query, and JSON body. Every route answers `answer`.
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

describe("the Transactions page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is in the main menu, with a detail view for each Transaction", () => {
    expect(MAIN_MENU).toContainEqual({ label: "Transactions", path: "/transactions" });
    const shell = routes.find((route) => route.path === "/");
    expect(shell?.children?.find((route) => route.path === "transactions")?.element).toBeDefined();
    expect(shell?.children?.find((route) => route.path === "transactions/:id")).toBeDefined();
  });

  it("opens filtered from other pages: by Category and month, by Merchant, and by last month's Income", () => {
    expect(transactionsPath({ category: "Restaurants", month: "2026-10" })).toBe(
      "/transactions?category=Restaurants&month=2026-10",
    );
    expect(transactionsPath({ merchant: "Corner Bistro" })).toBe(
      "/transactions?merchant=Corner+Bistro",
    );
    expect(transactionsPath({ type: "Income", month: "2026-10" })).toBe(
      "/transactions?type=Income&month=2026-10",
    );
    expect(transactionsPath()).toBe("/transactions");
    expect(
      filtersOf(new URLSearchParams("merchant=Corner+Bistro&type=Income&month=2026-10&x=1")),
    ).toEqual({ merchant: "Corner Bistro", type: "Income", month: "2026-10" });
    expect(filtersOf(new URLSearchParams("type=Fee&category=&account=a-card"))).toEqual({
      account: "a-card",
    });
  });

  it("edits each filter, then shows or clears them", () => {
    const onDraft = vi.fn();
    const onShow = vi.fn();
    const onClear = vi.fn();
    const draft = { merchant: "Corner Bistro" };
    const form = TransactionFilterForm({
      draft,
      accounts: ACCOUNTS,
      onDraft,
      onShow,
      onClear,
      today: TODAY,
    });
    const { buttons, fields } = controlsOf(form);

    expect([...fields.keys()]).toEqual([
      "account",
      "category",
      "type",
      "merchant",
      "from",
      "to",
      "month",
    ]);
    fields.get("account")?.("a-card");
    fields.get("category")?.("Groceries");
    fields.get("type")?.("Refund");
    fields.get("from")?.("2026-10-01");
    fields.get("to")?.("2026-10-31");
    fields.get("month")?.("2026-10");
    fields.get("merchant")?.("");
    expect(onDraft.mock.calls.map(([next]) => next)).toEqual([
      { merchant: "Corner Bistro", account: "a-card" },
      { merchant: "Corner Bistro", category: "Groceries" },
      { merchant: "Corner Bistro", type: "Refund" },
      { merchant: "Corner Bistro", from: "2026-10-01" },
      { merchant: "Corner Bistro", to: "2026-10-31" },
      { merchant: "Corner Bistro", month: "2026-10" },
      { merchant: undefined },
    ]);
    buttons.get("Clear the filters")?.();
    expect(onClear).toHaveBeenCalledOnce();
    const html = inRouter(form);
    expect(html).toContain('value="Corner Bistro"');
    expect(text(html)).toContain("Everyday Checking ··1234");
  });

  it("puts the filters in one row from 640 px, with the dates folded into one Dates control", () => {
    const form = (draft: Parameters<typeof TransactionFilterForm>[0]["draft"]) =>
      inRouter(
        TransactionFilterForm({
          draft,
          accounts: ACCOUNTS,
          onDraft: vi.fn(),
          onShow: vi.fn(),
          onClear: vi.fn(),
          today: TODAY,
        }),
      );
    const html = form({ month: "2026-10" });
    // Two to a line on a phone; one wrapping row from 640 px, as on the board.
    expect(html).toMatch(/<form class="grid grid-cols-2 [^"]*sm:flex sm:flex-wrap sm:items-end"/);
    // The From, To and Month fields sit inside the folded control, which names what is set.
    const dates = html.slice(html.indexOf('data-slot="dates">') + 'data-slot="dates">'.length);
    expect(dates).toMatch(/<details[^>]*><summary/);
    for (const name of ["from", "to", "month"]) expect(dates).toContain(`name="${name}"`);
    expect(text(dates)).toBe("Dates Dates: Oct 2026 From To Month Show Clear the filters");
    expect(text(form({}))).toContain("Dates: Any dates");
    // The control closes on Escape and on a click outside it.
    expect(dates).toMatch(/<details[^>]*>/);
    const details = elementsOf(
      TransactionFilterForm({
        draft: {},
        accounts: ACCOUNTS,
        onDraft: vi.fn(),
        onShow: vi.fn(),
        onClear: vi.fn(),
        today: TODAY,
      }),
    ).find((each) => each.type === "details");
    expect(details?.props.onKeyDown).toBe(datesKeyDown);
    expect(typeof details?.props.onToggle).toBe("function");
  });

  it("closes the open Dates panel on Escape, with the focus back on its summary", () => {
    const focused: string[] = [];
    const panel = (open: boolean) => ({
      open,
      querySelector: (selector: string) =>
        selector === "summary" ? { focus: () => void focused.push("summary") } : null,
    });
    const press = (key: string, details: ReturnType<typeof panel>) => {
      const preventDefault = vi.fn();
      datesKeyDown({ key, currentTarget: details, preventDefault } as unknown as Parameters<
        typeof datesKeyDown
      >[0]);
      return preventDefault;
    };

    const open = panel(true);
    expect(press("Escape", open)).toHaveBeenCalledOnce();
    expect(open.open).toBe(false);
    expect(focused).toEqual(["summary"]);
    // Another key, or Escape on a closed panel, does nothing, so Escape still works elsewhere.
    const other = panel(true);
    expect(press("Enter", other)).not.toHaveBeenCalled();
    expect(other.open).toBe(true);
    expect(press("Escape", panel(false))).not.toHaveBeenCalled();
    expect(focused).toEqual(["summary"]);
  });

  it("closes the open Dates panel on a click outside it, and not on one inside it", () => {
    const listeners = new Set<(event: Event) => void>();
    const doc = {
      addEventListener: (_: string, listener: (event: Event) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: Event) => void) =>
        listeners.delete(listener),
    };
    const inside = { name: "From" };
    const details = {
      open: true,
      isConnected: true,
      contains: (node: unknown) => node === inside,
    };
    const toggled = () =>
      datesToggled(details as unknown as HTMLDetailsElement, doc as unknown as Document);
    const click = (target: unknown) => {
      for (const listener of [...listeners]) listener({ target } as unknown as Event);
    };

    toggled();
    expect(listeners.size).toBe(1);
    click(inside);
    expect(details.open).toBe(true);
    click({ name: "the list" });
    expect(details.open).toBe(false);
    // Closing it takes its listener off the page.
    toggled();
    expect(listeners.size).toBe(0);
    // Opening it twice keeps one listener, and a panel gone from the page drops its own.
    details.open = true;
    toggled();
    toggled();
    expect(listeners.size).toBe(1);
    details.isConnected = false;
    click({ name: "the list" });
    expect(listeners.size).toBe(0);
  });

  it("names the dates the Dates control holds", () => {
    expect(datesLine({}, TODAY)).toBe("Any dates");
    expect(datesLine({ month: "2026-10" }, TODAY)).toBe("Oct 2026");
    expect(datesLine({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toBe("Oct 1 – Oct 31");
    expect(datesLine({ from: "2025-12-20" }, TODAY)).toBe("Dec 20, 2025 – …");
    expect(datesLine({ to: "2026-10-31" }, TODAY)).toBe("… – Oct 31");
    expect(datesLine({ month: "2026-09", from: "2026-09-05" }, TODAY)).toBe("Sep 2026, Sep 5 – …");
    // A value the browser has not finished shows as typed.
    expect(datesLine({ month: "2026-1" }, TODAY)).toBe("2026-1");
  });

  it("asks the API for one page with the filters, then the next page", async () => {
    const sent = recordRequests({ status: 200, body: { transactions: [], next: null } });

    await transactionRequests.list({
      account: "a-card",
      category: "Restaurants",
      merchant: "Corner Bistro",
      type: "Spending",
      from: "2026-10-01",
      to: "2026-10-31",
      month: "2026-10",
    });
    await transactionRequests.list({ type: "Income" }, "txn-100");

    expect(sent).toEqual([
      {
        method: "GET",
        path: "/api/transactions?account=a-card&category=Restaurants&merchant=Corner+Bistro&type=Spending&from=2026-10-01&to=2026-10-31&month=2026-10&limit=100",
        body: undefined,
      },
      {
        method: "GET",
        path: "/api/transactions?type=Income&limit=100&after=txn-100",
        body: undefined,
      },
    ]);
  });

  it("shows each row's date, Merchant, amount in cents, Account, Category or type, and a pending mark", () => {
    const rows = [
      row("pending", { pending: true, authorizedDate: "2026-11-03", postedDate: "2026-11-04" }),
      row("split", {
        merchant: "Target",
        amount: -12_000,
        parts: [
          part({ amount: -8_000, category: "Groceries", categoryChosenBy: "hand-set" }),
          part({ amount: -4_000, category: "Clothing", categoryChosenBy: "hand-set" }),
        ],
      }),
      row("refund", {
        merchant: "Target",
        amount: 3_000,
        parts: [
          part({ type: "Refund", amount: 3_000, category: "Groceries", linked: true }),
          part({ type: "Refund", amount: 0, category: "Clothing", linked: true }),
        ],
      }),
      row("pay", {
        accountId: "a-checking",
        amount: 320_000,
        merchant: null,
        merchantName: null,
        description: "ACME PAYROLL",
        postedDate: "2025-12-31",
        parts: [part({ type: "Income", amount: 320_000, category: null })],
      }),
      row("loan", {
        merchant: "Lakeside Auto",
        parts: [
          part({
            amount: -1_710,
            category: "Interest and fees",
            categoryChosenBy: "Money movement",
          }),
          part({ type: "Transfer", amount: -2_540, category: null }),
        ],
      }),
      row("new", { parts: [] }),
    ];
    const html = inRouter(
      <TransactionRows transactions={rows} accounts={accountLabels(ACCOUNTS)} today={TODAY} />,
    );
    const cellsOf = (tag: "th" | "td", within: string) =>
      [...within.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "gs"))].map((match) =>
        text(match[1] ?? ""),
      );
    const tbody = html.slice(html.indexOf("<tbody>"));
    const lines = [...tbody.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((match) =>
      cellsOf("td", match[1] ?? ""),
    );

    expect(cellsOf("th", html)).toEqual([
      "Date",
      "Merchant",
      "Category or type",
      "Account",
      "Amount",
    ]);
    expect(lines).toEqual([
      [
        "Nov 3",
        "Corner Bistro , Nov 3, −$42.50 pending",
        "Restaurants",
        "Rewards Card ··9876",
        "−$42.50",
      ],
      [
        "Oct 12",
        "Target , Oct 12, −$120.00",
        "Split: Groceries, Clothing",
        "Rewards Card ··9876",
        "−$120.00",
      ],
      ["Oct 12", "Target , Oct 12, +$30.00", "Refund: Groceries", "Rewards Card ··9876", "+$30.00"],
      [
        "Dec 31, 2025",
        "ACME PAYROLL , Dec 31, 2025, +$3,200.00",
        "Income",
        "Everyday Checking ··1234",
        "+$3,200.00",
      ],
      [
        "Oct 12",
        "Lakeside Auto , Oct 12, −$42.50",
        "Interest and fees + Transfer",
        "Rewards Card ··9876",
        "−$42.50",
      ],
      [
        "Oct 12",
        "Corner Bistro , Oct 12, −$42.50",
        "Not decided yet",
        "Rewards Card ··9876",
        "−$42.50",
      ],
    ]);
    // A signed amount never breaks after its sign (spec 07, Number formats).
    expect(html).toMatch(
      /<td class="[^"]*\bwhitespace-nowrap\b[^"]*">\+\$3,200\.00<a [^>]*><\/a><\/td>/,
    );
    expect(html).toMatch(
      /<td class="[^"]*\bwhitespace-nowrap\b[^"]*">−\$120\.00<a [^>]*><\/a><\/td>/,
    );
    // Money in is green, and its "+" says so too.
    expect(html).toMatch(/<td class="[^"]*\btext-good\b[^"]*">\+\$30\.00<a [^>]*><\/a><\/td>/);
    expect(html).not.toMatch(/<td class="[^"]*\btext-good\b[^"]*">−/);
    // Every cell opens the detail view. The row has one link for the keyboard and screen readers,
    // the Merchant's, which names the date and amount too. Each other cell holds a copy out of the
    // tab order and hidden from screen readers. No link is placed against the row itself.
    const firstRow = tbody.match(/<tr[^>]*>(.*?)<\/tr>/s)?.[0] ?? "";
    const links = [...firstRow.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
    expect(links).toHaveLength(5);
    expect(links.every((link) => link.includes('href="/transactions/pending"'))).toBe(true);
    const reached = links.filter((link) => !link.includes('tabindex="-1"'));
    expect(reached).toHaveLength(1);
    expect(reached[0]).not.toContain("aria-hidden");
    expect(links.filter((link) => /tabindex="-1" aria-hidden="true"/.test(link))).toHaveLength(4);
    expect(firstRow).toContain('<span class="sr-only">, Nov 3, −$42.50</span></a>');
    expect(firstRow).not.toMatch(/<tr class="[^"]*(?<![:-])\brelative\b/);
    expect(html).toContain('href="/transactions/split"');
    // A Category the AI chose carries the AI tag; one set by hand does not.
    const aiRows = inRouter(
      <TransactionRows
        transactions={[
          row("ai", { parts: [part({ categoryChosenBy: "AI, unsure" })] }),
          row("hand", { parts: [part({ categoryChosenBy: "hand-set" })] }),
          row("web", { parts: [part({ categoryChosenBy: "Web lookup" })] }),
        ]}
        accounts={accountLabels(ACCOUNTS)}
        today={TODAY}
      />,
    );
    expect(cellsOf("td", aiRows).filter((cell) => cell.startsWith("Restaurants"))).toEqual([
      "Restaurants AI (Category chosen by the AI)",
      "Restaurants",
      "Restaurants AI (Category chosen by the AI)",
    ]);
    // The tag's meaning reaches screen readers as words, not as a tooltip; the visible "AI" is
    // hidden from them.
    expect(aiRows).toMatch(/<span aria-hidden="true" class="[^"]*">AI<\/span>/);
    expect(aiRows).toContain('<span class="sr-only">(Category chosen by the AI)</span>');
    expect(aiRows).not.toContain("title=");
    expect(
      text(inRouter(<TransactionRows transactions={[]} accounts={new Map()} today={TODAY} />)),
    ).toBe("No Transactions match these filters.");
  });

  it("names a Refund on a split purchase per part", () => {
    expect(
      categoryOrType([
        part({ type: "Refund", amount: 2_000, category: "Groceries", linked: true }),
        part({ type: "Refund", amount: 1_000, category: "Clothing", linked: true }),
      ]),
    ).toBe("Refund: Groceries + Refund: Clothing");
  });
});

describe("the Transaction detail view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const purchase = row("purchase", {
    merchant: "Target",
    amount: -12_000,
    parts: [
      part({ amount: -8_000, category: "Groceries", categoryChosenBy: "hand-set" }),
      part({ amount: -4_000, category: "Clothing", categoryChosenBy: "hand-set" }),
      part({ amount: 0, category: "Pets", categoryChosenBy: "hand-set" }),
    ],
  });
  const refund = row("refund", {
    merchant: "Target",
    amount: 3_000,
    postedDate: "2026-10-20",
    parts: [
      part({ type: "Refund", amount: 2_000, category: "Groceries", linked: true }),
      part({ type: "Refund", amount: 1_000, category: "Clothing", linked: true }),
      part({ type: "Refund", amount: 0, category: "Pets", linked: true }),
    ],
  });
  const detailOf = (
    transaction: TransactionRowView,
    fields: Partial<TransactionDetailView> = {},
  ): TransactionDetailView => ({
    transaction,
    decision: { step: "5.7", provisionalUntil: null, parts: transaction.parts },
    transferLink: null,
    otherLinks: [],
    matched: [],
    webLookup: null,
    ...fields,
  });
  const refundLink = {
    id: "link-refund",
    kind: "Refund" as const,
    otherTransactionId: "purchase",
    loanAccountId: null,
    tier: "Strong" as const,
    signals: ["same Account", "same Merchant"],
    aiAnswer: null,
    aiConfidence: null,
    madeBy: "app" as const,
  };
  const refundDetail = detailOf(refund, { otherLinks: [refundLink], matched: [purchase] });
  const noActions: DetailActions = {
    setForm: () => {},
    saveCategory: () => {},
    saveType: () => {},
    saveSplit: () => {},
    removeSplit: () => {},
    undoLink: () => {},
    linkByHand: () => {},
    findCandidates: () => {},
    showMoreCandidates: () => {},
  };
  const body = (
    detail: TransactionDetailView,
    actions: DetailActions = noActions,
    form: DetailForm = formOf(detail),
    candidates: TransactionRowView[] = [],
    moreCandidates = false,
  ) => (
    <TransactionDetailBody
      detail={detail}
      accounts={ACCOUNTS}
      candidates={candidates}
      moreCandidates={moreCandidates}
      form={form}
      outcome={{}}
      today={TODAY}
      actions={actions}
    />
  );

  it("shows its one heading before the Transaction loads, so the focus has a place to go", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/transactions/dinner"] });
    const html = renderToString(<RouterProvider router={router} />);

    expect(
      [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gs)].map((match) => text(match[1] ?? "")),
    ).toEqual(["Transaction"]);
    expect(html).toContain('href="/transactions"');
  });

  it("shows how each Category was chosen", () => {
    const chosen: CategoryChosenBy[] = [
      "hand-set",
      "Category rule",
      "Plaid",
      "Merchant history",
      "AI",
      "AI, unsure",
      "Web lookup",
      "Web lookup, unsure",
      "best guess",
      "Money movement",
    ];
    const html = text(
      inRouter(
        body(
          detailOf(
            row("each", {
              parts: chosen.map((by) => part({ amount: -100, categoryChosenBy: by })),
            }),
          ),
        ),
      ),
    );

    for (const by of chosen)
      expect(html).toContain(`Restaurants · −$1.00 · Category chosen by: ${by} `);
    expect(text(inRouter(body(detailOf(row("new"), { decision: null }))))).toContain(
      "The app has not decided this Transaction yet.",
    );
    // A Web lookup's Category shows the line it kept about the business.
    const looked = text(
      inRouter(
        body(
          detailOf(row("looked", { parts: [part({ categoryChosenBy: "Web lookup" })] }), {
            webLookup: { description: "A pet supply shop." },
          }),
        ),
      ),
    );
    expect(looked).toContain("Category chosen by: Web lookup");
    expect(looked).toContain("Web lookup: A pet supply shop.");
    expect(html).not.toContain("Web lookup: ");
  });

  it("shows a Refund on a split purchase per part, and a part the bank shrank to $0 sensibly", () => {
    const refundHtml = text(inRouter(body(refundDetail)));
    expect(refundHtml).toContain(
      "Refund: Groceries · $20.00 · Category chosen by: the linked Spending's Category Refund: Clothing · $10.00",
    );
    expect(refundHtml).not.toContain("Refund: Pets");

    const purchaseHtml = text(inRouter(body(detailOf(purchase))));
    expect(purchaseHtml).toContain(
      "Pets · $0.00 · Category chosen by: hand-set · The bank lowered the amount, so this part has nothing left.",
    );
    // The split to edit leaves the $0 part out.
    expect(formOf(detailOf(purchase)).split).toEqual([
      { amount: "80.00", category: "Groceries" },
      { amount: "40.00", category: "Clothing" },
    ]);
  });

  it("shows the evidence for each link with the Transaction it matched, and Undo", () => {
    const transfer = detailOf(
      row("out", {
        accountId: "a-checking",
        amount: -50_000,
        parts: [part({ type: "Transfer", amount: -50_000, category: null })],
      }),
      {
        transferLink: {
          id: "link-transfer",
          otherTransactionId: "in",
          tier: "Unclear",
          signals: [],
          aiAnswer: "yes",
          aiConfidence: "high",
          madeBy: "AI",
          uncertain: true,
        },
        otherLinks: [
          {
            id: "link-loan",
            kind: "loan",
            otherTransactionId: null,
            loanAccountId: "a-loan",
            tier: "Strong",
            signals: ["lender name"],
            aiAnswer: null,
            aiConfidence: null,
            madeBy: "Member",
          },
        ],
        matched: [
          row("in", {
            accountId: "a-card",
            amount: 50_000,
            merchant: null,
            merchantName: null,
            description: "PAYMENT THANK YOU",
            parts: [part({ type: "Transfer", amount: 50_000, category: null })],
          }),
        ],
      },
    );
    const shown = inRouter(body(transfer));
    const html = text(shown);

    // A signed amount never breaks after its sign (spec 07, Number formats): in the header, and in
    // the Transaction each link matched.
    expect(shown).toMatch(/<p class="[^"]*\bwhitespace-nowrap\b[^"]*">−\$500\.00<\/p>/);
    expect(html).toContain("Oct 12 · Everyday Checking ··1234 −$500.00 The bank's line:");
    expect(shown).toContain(' · <span class="whitespace-nowrap">+$500.00</span> · ');

    expect(html).toContain(
      "Transfer with: Oct 12 · PAYMENT THANK YOU · +$500.00 · Rewards Card ··9876 · Transfer Tier: Unclear No strong signal matched. The AI said yes, with high confidence. Made by the AI. The app picked it from two equally good sets of pairs. Undo",
    );
    expect(html).toContain(
      "Linked to the loan Lakeside Auto Tier: Strong Signals that matched: lender name. The AI was not asked. Made by a Member. Undo",
    );
    expect(text(inRouter(body(refundDetail)))).toContain(
      "Refund for: Oct 12 · Target · −$120.00 · Rewards Card ··9876 · Split: Groceries, Clothing Tier: Strong Signals that matched: same Account, same Merchant. The AI was not asked. Made by the app. Undo",
    );
    expect(
      text(
        inRouter(
          body(
            detailOf(purchase, {
              otherLinks: [{ ...refundLink, otherTransactionId: "refund" }],
              matched: [refund],
            }),
          ),
        ),
      ),
    ).toContain("Reduced by this Refund: Oct 20 · Target · +$30.00");
  });

  it("sends each edit to its route, and shows what it did", async () => {
    const sent = recordRequests({
      status: 200,
      body: {
        category: "Groceries",
        rule: { id: "r1", merchantName: "Corner Bistro", category: "Groceries", madeAt: "" },
        setSpending: false,
      },
    });
    const dinner = detailOf(row("dinner"));
    const outcomes: unknown[] = [];
    const forms: DetailForm[] = [];
    const edit = (detail: TransactionDetailView, patch: Partial<DetailForm>) => {
      const form = { ...formOf(detail), ...patch };
      const actions = detailActions(
        detail,
        form,
        (next) => forms.push(next),
        (outcome) => outcomes.push(outcome),
      );
      return controlsOf(body(detail, actions, form));
    };

    // The fields change the form.
    const fields = edit(dinner, {}).fields;
    fields.get("category")?.("Groceries");
    fields.get("onlyThisTransaction")?.(true);
    fields.get("type")?.("Transfer");
    expect(forms.map((form) => [form.category, form.onlyThisTransaction, form.type])).toEqual([
      ["Groceries", false, "Spending"],
      ["Restaurants", true, "Spending"],
      ["Restaurants", false, "Transfer"],
    ]);

    edit(dinner, { category: "Groceries" }).buttons.get("Save the Category")?.();
    edit(dinner, { category: "Groceries", onlyThisTransaction: true }).buttons.get(
      "Save the Category",
    )?.();
    edit(dinner, { type: "Transfer" }).buttons.get("Set the type")?.();
    edit(detailOf(purchase), {}).buttons.get("Save the split")?.();
    edit(detailOf(purchase), {}).buttons.get("Remove the split")?.();
    edit(refundDetail, {}).buttons.get("Undo")?.();
    const money = detailOf(
      row("cash-in", {
        amount: 3_000,
        parts: [part({ type: "Income", amount: 3_000, category: null })],
      }),
    );
    const spent = row("spent", { amount: -9_000 });
    const linkForm = {
      ...formOf(money),
      linkKind: "Reimbursement" as const,
      spendingTransactionId: "spent",
    };
    const linkActions = detailActions(
      money,
      linkForm,
      () => {},
      (outcome) => outcomes.push(outcome),
    );
    const linkControls = controlsOf(body(money, linkActions, linkForm, [spent]));
    expect(inRouter(body(money, linkActions, linkForm, [spent]))).toContain(
      "Oct 12 · Corner Bistro · −$90.00 · Rewards Card ··9876 · Restaurants",
    );
    linkControls.buttons.get("Link")?.();
    await vi.waitFor(() => expect(sent).toHaveLength(7));

    expect(sent).toEqual([
      {
        method: "PUT",
        path: "/api/transactions/dinner/category",
        body: { category: "Groceries", onlyThisTransaction: false },
      },
      {
        method: "PUT",
        path: "/api/transactions/dinner/category",
        body: { category: "Groceries", onlyThisTransaction: true },
      },
      { method: "PUT", path: "/api/transactions/dinner/type", body: { type: "Transfer" } },
      {
        method: "PUT",
        path: "/api/transactions/purchase/split",
        body: {
          parts: [
            { amount: 8_000, category: "Groceries" },
            { amount: 4_000, category: "Clothing" },
          ],
        },
      },
      { method: "DELETE", path: "/api/transactions/purchase/split", body: undefined },
      { method: "DELETE", path: "/api/links/link-refund", body: undefined },
      {
        method: "POST",
        path: "/api/links",
        body: { kind: "Reimbursement", transactionId: "cash-in", spendingTransactionId: "spent" },
      },
    ]);
    await vi.waitFor(() => expect(outcomes).toHaveLength(7));
    expect(outcomes).toContainEqual({
      notice:
        "A Category rule now gives Corner Bistro's Transactions Groceries, except those set by hand.",
    });
    expect(outcomes).toContainEqual({ notice: "Linked as a Reimbursement." });
  });

  it("finds Spending older than the first page by Merchant and date, pages through it, and links it by hand", async () => {
    // 130 Corner Bistro meals: the first page holds the newest 100, the next page the rest.
    const meals = Array.from({ length: 130 }, (_, index) =>
      row(`meal-${String(index).padStart(3, "0")}`, { amount: -1_000 - index }),
    );
    const sent: { method: string; path: string; query: Record<string, string>; body: unknown }[] =
      [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      const query = Object.fromEntries(url.searchParams);
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        query,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.pathname !== "/api/transactions") return Response.json({});
      const page =
        query.after === undefined
          ? { transactions: meals.slice(0, 100), next: "meal-099" }
          : { transactions: meals.slice(100), next: null };
      return Response.json(page);
    });
    const money = detailOf(
      row("cash-in", {
        amount: 3_000,
        postedDate: "2026-10-12",
        parts: [part({ type: "Income", amount: 3_000, category: null })],
      }),
    );
    // The search starts at the 120 days before the money posted.
    expect(formOf(money).candidates).toEqual({
      merchant: "",
      from: "2026-06-14",
      to: "2026-10-12",
    });

    let page: CandidatePage = { filters: {}, rows: [], next: null };
    const forms: DetailForm[] = [];
    const outcomes: unknown[] = [];
    const actionsFor = (form: DetailForm) =>
      detailActions(
        money,
        form,
        (next) => forms.push(next),
        (outcome) => outcomes.push(outcome),
        { page, setPage: (next) => (page = next) },
      );

    // The Member narrows the search to a Merchant and a wider date range. A "to" after the money
    // posted is cut back to that day.
    const search = {
      ...formOf(money),
      spendingTransactionId: "meal-001",
      candidates: { merchant: " Corner Bistro ", from: "2025-01-01", to: "2026-12-31" },
    };
    actionsFor(search).findCandidates();
    await vi.waitFor(() => expect(page.rows).toHaveLength(100));
    const filters = {
      merchant: "Corner Bistro",
      type: "Spending",
      from: "2025-01-01",
      to: "2026-10-12",
      limit: "100",
    };
    expect(sent).toEqual([
      { method: "GET", path: "/api/transactions", query: filters, body: undefined },
    ]);
    // A new search drops the Spending picked from the last one.
    expect(forms).toEqual([{ ...search, spendingTransactionId: "" }]);
    const firstPage = inRouter(body(money, noActions, search, page.rows, page.next !== null));
    expect(firstPage).toContain("Show more Spending");
    expect(firstPage).not.toContain('value="meal-120"');

    // The Member edits the search but presses Show more: the next page keeps the first page's
    // filters.
    actionsFor({
      ...search,
      candidates: { merchant: "Target", from: "", to: "" },
    }).showMoreCandidates();
    await vi.waitFor(() => expect(page.rows).toHaveLength(130));
    expect(sent[1]).toEqual({
      method: "GET",
      path: "/api/transactions",
      query: { ...filters, after: "meal-099" },
      body: undefined,
    });
    expect(page.next).toBeNull();
    const lastPage = inRouter(body(money, noActions, search, page.rows, page.next !== null));
    expect(lastPage).toContain('value="meal-120"');
    expect(lastPage).not.toContain("Show more Spending");
    // On the last page, Show more reads nothing.
    actionsFor(search).showMoreCandidates();

    // The Member picks the old meal and links it.
    const picked = {
      ...search,
      linkKind: "Reimbursement" as const,
      spendingTransactionId: "meal-120",
    };
    const controls = controlsOf(body(money, actionsFor(picked), picked, page.rows, false));
    controls.fields.get("candidateMerchant")?.("Target");
    expect(forms.at(-1)?.candidates).toEqual({ ...search.candidates, merchant: "Target" });
    controls.buttons.get("Link")?.();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({
      method: "POST",
      path: "/api/links",
      query: {},
      body: { kind: "Reimbursement", transactionId: "cash-in", spendingTransactionId: "meal-120" },
    });
    await vi.waitFor(() => expect(outcomes).toEqual([{ notice: "Linked as a Reimbursement." }]));
  });

  it("checks a split and a hand link before sending them, and shows a refusal", async () => {
    const sent = recordRequests({
      status: 400,
      body: { error: "The parts must add up to the Transaction's amount." },
    });
    const outcomes: unknown[] = [];
    const purchaseDetail = detailOf(purchase);
    const badSplit = {
      ...formOf(purchaseDetail),
      split: [
        { amount: "80", category: "Groceries" },
        { amount: "forty", category: "Clothing" },
      ],
    };
    detailActions(
      purchaseDetail,
      badSplit,
      () => {},
      (o) => outcomes.push(o),
    ).saveSplit();
    detailActions(
      refundDetail,
      formOf(refundDetail),
      () => {},
      (o) => outcomes.push(o),
    ).linkByHand();
    expect(sent).toEqual([]);

    const short = {
      ...formOf(purchaseDetail),
      split: [
        { amount: "80", category: "Groceries" },
        { amount: "30", category: "Clothing" },
      ],
    };
    detailActions(
      purchaseDetail,
      short,
      () => {},
      (o) => outcomes.push(o),
    ).saveSplit();
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));

    expect(outcomes).toEqual([
      { error: "Give each part an amount in dollars and cents, and a Category." },
      { error: "Pick the Spending it pays back." },
      { error: "The parts must add up to the Transaction's amount." },
    ]);
    // A Transaction already linked as money in offers no second link; Spending offers none.
    expect(text(inRouter(body(refundDetail)))).not.toContain("Link as a Refund or Reimbursement");
    expect(text(inRouter(body(purchaseDetail)))).not.toContain("Link as a Refund or Reimbursement");
    expect(text(inRouter(body(refundDetail)))).not.toContain("Split by amount");
  });
});
