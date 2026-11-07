import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { categoryChoiceValue, readCategoryChoice } from "../../categorization/category-choice.ts";
import { AI_UNSURE_KIND, BEST_GUESS_KIND } from "../../categorization/index.ts";
import {
  MISSED_PAYMENT_KIND,
  MONEY_FROM_PERSON_KIND,
  PAIR_GUESS_KIND,
  POSSIBLE_PAYMENT_KIND,
  UNCLEAR_PAIR_KIND,
} from "../../money-movement/index.ts";
import { ONE_SIDED_KIND } from "../../money-movement/one-sided.ts";
import { UNTRACKED_LOAN_KIND as SERVER_UNTRACKED_LOAN_KIND } from "../../money-movement/untracked-loans.ts";
import type { ReviewItemView, ReviewTransactionView } from "../../server/review-views.ts";
import { MAIN_MENU } from "../menu.ts";
import {
  acceptOf,
  answerItem,
  changeOneCategory,
  changeOneType,
  reviewListRequests,
  UNTRACKED_LOAN_KIND,
} from "../review-list.ts";
import { routes } from "../routes.tsx";
import {
  cardTitle,
  categoryPickerOf,
  displayGroups,
  groupTitle,
  type ItemActions,
  KIND_LABEL,
  matchingCategories,
  pickedCategoryValue,
  ReviewItems,
  ReviewListItem,
  shownCount,
  withBusy,
} from "./ReviewList.tsx";

// The Review list page (spec 07, Review list page), with an item of every kind the app opens.

const TODAY = "2026-11-04";

const txn = (id: string, fields: Partial<ReviewTransactionView> = {}): ReviewTransactionView => ({
  id,
  amount: -4_250,
  postedDate: "2026-10-12",
  authorizedDate: null,
  description: "CORNER BISTRO",
  merchantName: "Corner Bistro",
  accountName: "Everyday Checking",
  categories: [],
  ...fields,
});

const item = (
  id: string,
  kind: string,
  bestAnswer: { value: string; label: string },
  fields: Partial<ReviewItemView> = {},
): ReviewItemView => ({
  id,
  kind,
  subject: { type: "transactions", transactionIds: [`${id}-txn`] },
  transactions: [txn(`${id}-txn`)],
  loanName: null,
  decided: "The app decided something.",
  bestAnswer,
  createdAt: "2026-11-03T14:00:00.000Z",
  needsAi: false,
  group: null,
  ...fields,
});

const out = txn("out", { amount: -50_000, description: "TRANSFER TO SAVINGS", merchantName: null });
const into = txn("in", {
  amount: 50_000,
  description: "TRANSFER FROM CHECKING",
  merchantName: null,
});

// One item of each kind, as its owner opens it.
const EVERY_KIND: ReviewItemView[] = [
  item(
    "guess",
    BEST_GUESS_KIND,
    { value: "Restaurants", label: "Yes, Restaurants" },
    {
      decided: "No AI was available, so the app guessed Restaurants.",
    },
  ),
  item(
    "unclear",
    UNCLEAR_PAIR_KIND,
    { value: "link", label: "Yes, they are one Transfer" },
    {
      subject: { type: "transactions", transactionIds: ["out", "in"] },
      transactions: [out, into],
      decided: "These match as a Transfer, but nothing more ties them, so they are not linked.",
    },
  ),
  item(
    "pair-guess",
    PAIR_GUESS_KIND,
    { value: "link", label: "Yes, they are one Transfer" },
    {
      subject: { type: "transactions", transactionIds: ["out", "in"] },
      transactions: [out, into],
      decided: "Two sets of Transfer pairs were equally good, so the app picked this one.",
    },
  ),
  item(
    "one-sided",
    ONE_SIDED_KIND,
    { value: "keep", label: "Keep it as a Transfer" },
    {
      decided: "It names no account, so it counts as a Transfer. Which account is this?",
    },
  ),
  item(
    "person",
    MONEY_FROM_PERSON_KIND,
    { value: "keep", label: "Keep as Income" },
    {
      transactions: [txn("person-txn", { amount: 3_000, description: "MOBILE DEPOSIT" })],
      decided: "Money from a person with no link counts as Income.",
    },
  ),
  item(
    "untracked",
    UNTRACKED_LOAN_KIND,
    {
      value: "/settings/banks?lender=Lakeside%20Auto#manual-loans",
      label: "Add it as a Manual loan",
    },
    { decided: "Payments to Lakeside Auto count as Transfers, so their interest cannot show." },
  ),
  item(
    "payment",
    POSSIBLE_PAYMENT_KIND,
    { value: "link loan-1", label: "Link to this loan" },
    {
      decided: "This payment may belong to Lakeside Auto.",
    },
  ),
  item(
    "missed",
    MISSED_PAYMENT_KIND,
    { value: "keep", label: "Keep the loan open" },
    {
      subject: { type: "loan", accountId: "loan-1" },
      transactions: [],
      loanName: "Lakeside Auto",
      decided: "No payment to Lakeside Auto has linked since 2026-08-15.",
    },
  ),
];

// Every kind the server registers, read from the source, so a kind added later fails the label
// test until it has a label. The registry fills only when the server's modules start, so the test
// reads each registerReviewKind(<NAME>_KIND, ...) call in the non-test files outside src/web, and
// each kind constant's string. A call that passes anything but a *_KIND constant is reported, so a
// string literal cannot slip past.
const SRC = fileURLToPath(new URL("../../", import.meta.url));

function serverSources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === join(SRC, "web") ? [] : serverSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function registeredKinds() {
  const files = serverSources().map((path) => ({ path, source: readFileSync(path, "utf8") }));
  const names: string[] = [];
  const notConstants: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(/(?<!function )\bregisterReviewKind\(\s*([^,)]*)/g)) {
      const argument = (match[1] ?? "").trim();
      if (/^[A-Z][A-Z0-9_]*_KIND$/.test(argument)) names.push(argument);
      else notConstants.push(`${relative(SRC, path)}: ${argument}`);
    }
  }
  const values = new Map<string, string[]>();
  for (const { source } of files) {
    for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*_KIND) = "([^"]*)";/g)) {
      const [, name = "", value = ""] = match;
      values.set(name, [...(values.get(name) ?? []), value]);
    }
  }
  return {
    calls: names.length,
    notConstants,
    // A name with no string, or with two different strings, cannot be checked.
    unresolved: names.filter((name) => new Set(values.get(name)).size !== 1),
    kinds: [...new Set(names.map((name) => values.get(name)?.[0] ?? name))].sort(),
  };
}

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const inRouter = (node: ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);
const noActions: ItemActions = {
  answer: () => {},
  notThis: () => {},
  changeOne: async () => undefined,
};

// The buttons in an item, by their words, with what each does when tapped. The item component has
// no state of its own, so the tree it returns holds each button's onClick.
function buttonsOf(element: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
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
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
    if (node.type === "button" && node.props.onClick !== undefined) {
      found.set(words(node.props.children), node.props.onClick);
    }
    walk(node.props.children);
  };
  walk(element);
  return found;
}

describe("the Review list page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each request the page sends: its method, path, and JSON body. The answer route answers with
  // `answer`, and the open count is 2.
  function recordRequests(answer: { status: number; body: unknown } = { status: 200, body: {} }) {
    const sent: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      const method = init?.method ?? "GET";
      sent.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.pathname.endsWith("/count")) return Response.json({ open: 2 });
      if (url.pathname.endsWith("/choices")) {
        return Response.json({ choices: [{ value: "other", label: "Something else" }] });
      }
      return Response.json(answer.body, { status: answer.status });
    });
    return sent;
  }

  it("is in the main menu", () => {
    expect(MAIN_MENU).toContainEqual({ label: "Review list", path: "/review-list" });
    const page = routes
      .find((route) => route.path === "/")
      ?.children?.find((route) => route.path === "review-list");
    expect(page?.element).toBeDefined();
    expect(UNTRACKED_LOAN_KIND).toBe(SERVER_UNTRACKED_LOAN_KIND);
  });

  it("opens only the Manual loan form from an item", () => {
    const untracked = (value: string) =>
      acceptOf({ kind: UNTRACKED_LOAN_KIND, bestAnswer: { value, label: "Add it" } });

    expect(untracked("/settings/banks?lender=Lakeside#manual-loans")).toEqual({
      does: "open",
      path: "/settings/banks?lender=Lakeside#manual-loans",
      label: "Add it",
    });
    for (const value of ["https://evil.example/", "//evil.example", "/settings/banksx", "leave"]) {
      expect(untracked(value).does, value).toBe("answer");
    }
    expect(
      acceptOf({ kind: BEST_GUESS_KIND, bestAnswer: { value: "/settings/banks", label: "Yes" } }),
    ).toEqual({ does: "answer", value: "/settings/banks", label: "Yes" });
  });

  it("renders every kind with its Transaction or loan, what the app decided, its best answer, and Not this, newest first", () => {
    const html = inRouter(
      <ReviewItems items={EVERY_KIND} states={{}} today={TODAY} actions={noActions} />,
    );
    const rows = [
      ...html.matchAll(
        /<li [^>]*data-kind="[^"]*"[^>]*>(.*?)<\/li>(?=<li [^>]*data-kind=|<\/ul>$)/gs,
      ),
    ].map((match) => text(match[1] ?? ""));

    expect([...html.matchAll(/data-kind="([^"]*)"/g)].map((match) => match[1])).toEqual(
      EVERY_KIND.map((each) => each.kind),
    );
    expect(rows).toEqual([
      "Category guess Oct 12 · Corner Bistro · −$42.50 · Everyday Checking No AI was available, so the app guessed Restaurants. Yes, Restaurants Not this",
      "Transfer guess Oct 12 · TRANSFER TO SAVINGS · −$500.00 · Everyday Checking Oct 12 · TRANSFER FROM CHECKING · +$500.00 · Everyday Checking These match as a Transfer, but nothing more ties them, so they are not linked. Yes, they are one Transfer Not this",
      "Transfer guess Oct 12 · TRANSFER TO SAVINGS · −$500.00 · Everyday Checking Oct 12 · TRANSFER FROM CHECKING · +$500.00 · Everyday Checking Two sets of Transfer pairs were equally good, so the app picked this one. Yes, they are one Transfer Not this",
      "One-sided Transfer Oct 12 · Corner Bistro · −$42.50 · Everyday Checking It names no account, so it counts as a Transfer. Which account is this? Keep it as a Transfer Not this",
      "Money from a person Oct 12 · Corner Bistro · +$30.00 · Everyday Checking Money from a person with no link counts as Income. Keep as Income Not this",
      "Untracked loan Oct 12 · Corner Bistro · −$42.50 · Everyday Checking Payments to Lakeside Auto count as Transfers, so their interest cannot show. Add it as a Manual loan Not this",
      "Possible loan payment Oct 12 · Corner Bistro · −$42.50 · Everyday Checking This payment may belong to Lakeside Auto. Link to this loan Not this",
      "Missed loan payment Lakeside Auto No payment to Lakeside Auto has linked since 2026-08-15. Keep the loan open Not this",
    ]);
    // A signed amount never breaks after its sign (spec 07, Number formats).
    expect(html).toContain(' · <span class="whitespace-nowrap">−$42.50</span> · ');
    expect(html).toContain(' · <span class="whitespace-nowrap">+$500.00</span> · ');
    // The untracked loan's best answer opens the Manual loan form, with the lender filled in.
    expect(html).toContain('href="/settings/banks?lender=Lakeside%20Auto#manual-loans"');
  });

  it("labels each kind the app opens in the owner specs' words", () => {
    // Every kind the server registers has a label, and every label belongs to a registered kind.
    const registered = registeredKinds();
    expect(registered.notConstants).toEqual([]);
    expect(registered.unresolved).toEqual([]);
    expect(registered.calls).toBeGreaterThanOrEqual(9);
    expect(Object.keys(KIND_LABEL).sort()).toEqual(registered.kinds);
    // The scan reads the same strings the kind constants hold.
    expect(Object.keys(KIND_LABEL).sort()).toEqual(
      [
        BEST_GUESS_KIND,
        AI_UNSURE_KIND,
        UNCLEAR_PAIR_KIND,
        PAIR_GUESS_KIND,
        ONE_SIDED_KIND,
        MONEY_FROM_PERSON_KIND,
        SERVER_UNTRACKED_LOAN_KIND,
        POSSIBLE_PAYMENT_KIND,
        MISSED_PAYMENT_KIND,
      ].sort(),
    );
    // A kind with no label shows none, and the item still shows in full.
    const html = inRouter(
      <ReviewItems
        items={[item("new", "a kind added later", { value: "keep", label: "Keep it" })]}
        states={{}}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(text(html)).toBe(
      "Oct 12 · Corner Bistro · −$42.50 · Everyday Checking The app decided something. Keep it Not this",
    );
  });

  it("shows the other choices under their label once Not this is open", () => {
    const html = inRouter(
      <ReviewListItem
        item={EVERY_KIND[0] as ReviewItemView}
        state={{ choices: [{ value: "other", label: "Something else" }] }}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<p [^>]*id="choices-guess"[^>]*>Other choices<\/p>/);
    expect(html).toContain('<ul class="flex flex-wrap gap-2" aria-labelledby="choices-guess">');
    expect(text(html)).toContain("Not this Other choices Something else");
  });

  // The choices the server sends behind "Not this" on a Category item: each Category, and each
  // Category for only this Transaction when the Merchant may have a rule.
  const categoryChoices = (onlyThis: boolean) => [
    { value: "Groceries", label: "Groceries" },
    { value: "Restaurants", label: "Restaurants" },
    ...(onlyThis
      ? [
          {
            value: categoryChoiceValue("Groceries", true),
            label: "Groceries, only this Transaction",
          },
          {
            value: categoryChoiceValue("Restaurants", true),
            label: "Restaurants, only this Transaction",
          },
        ]
      : []),
  ];

  it("shows a Category item's choices as a Category search box and Only this Transaction", () => {
    const html = inRouter(
      <ReviewListItem
        item={EVERY_KIND[0] as ReviewItemView}
        state={{ choices: categoryChoices(true) }}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(html).toMatch(/<label [^>]*for="category-guess"[^>]*>Another Category<\/label>/);
    expect(html).toMatch(/<input [^>]*id="category-guess"[^>]*role="combobox"/);
    expect(html).toMatch(/role="combobox"[^>]*aria-controls="categories-guess"/);
    expect(html).toMatch(/<div [^>]*id="categories-guess"[^>]*role="listbox"/);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toMatch(/<input type="checkbox"[^>]*aria-describedby="only-this-guess"/);
    expect(text(html)).toContain("Groceries Restaurants Only this Transaction Without it");
    expect(text(html)).not.toContain("Other choices");
    expect(text(html)).not.toContain(", only this Transaction");
  });

  it("shows no Only this Transaction box when the server offers no such choice", () => {
    const html = inRouter(
      <ReviewListItem
        item={EVERY_KIND[0] as ReviewItemView}
        state={{ choices: categoryChoices(false) }}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain('type="checkbox"');
    expect(text(html)).not.toContain("Only this Transaction");
  });

  it("reads Category choices as one Category list, and leaves any other list as round choices", () => {
    expect(categoryPickerOf(categoryChoices(true))).toEqual({
      categories: ["Groceries", "Restaurants"],
      onlyThisOffered: true,
    });
    expect(categoryPickerOf(categoryChoices(false))).toEqual({
      categories: ["Groceries", "Restaurants"],
      onlyThisOffered: false,
    });
    expect(categoryPickerOf([...categoryChoices(true), { value: "other", label: "Other" }])).toBe(
      undefined,
    );
    expect(categoryPickerOf([])).toBe(undefined);
  });

  it("finds Categories by any part of their name, in either case", () => {
    const all = ["Groceries", "Home and garden", "Alcohol and tobacco", "Gas"] as const;
    expect(matchingCategories(all, "gro")).toEqual(["Groceries"]);
    expect(matchingCategories(all, " AND ")).toEqual(["Home and garden", "Alcohol and tobacco"]);
    expect(matchingCategories(all, "")).toEqual(all);
    expect(matchingCategories(all, "shopping")).toEqual([]);
  });

  it("posts a picked Category, with the box only when it was offered, then reads the count", async () => {
    const sent = recordRequests();
    const pick = (offered: boolean, checked: boolean) =>
      answerItem("guess", pickedCategoryValue("Groceries", { offered, checked }));

    expect(await pick(true, false)).toEqual({ answered: true, openCount: 2 });
    expect(await pick(true, true)).toEqual({ answered: true, openCount: 2 });
    // A box that was not offered cannot make the answer only this Transaction.
    expect(await pick(false, true)).toEqual({ answered: true, openCount: 2 });

    expect(
      sent.filter((request) => request.method === "POST").map((request) => request.body),
    ).toEqual([
      { value: "Groceries" },
      { value: categoryChoiceValue("Groceries", true) },
      { value: "Groceries" },
    ]);
    expect(sent.filter((request) => request.path.endsWith("/count"))).toHaveLength(3);
  });

  it("sends a picked Category with or without only this Transaction as the server reads it", () => {
    expect(readCategoryChoice(categoryChoiceValue("Groceries", false))).toEqual({
      category: "Groceries",
      onlyThisTransaction: false,
    });
    expect(readCategoryChoice(categoryChoiceValue("Groceries", true))).toEqual({
      category: "Groceries",
      onlyThisTransaction: true,
    });
  });

  describe("a Category card", () => {
    const card = item(
      "card",
      AI_UNSURE_KIND,
      { value: "Gas", label: "Yes, Gas" },
      {
        subject: { type: "transactions", transactionIds: ["m1", "m2", "m3"] },
        transactions: [
          txn("m1", { merchantName: "Marathon", postedDate: "2026-11-02", categories: ["Gas"] }),
          txn("m2", { merchantName: "Marathon", postedDate: "2026-10-30", categories: ["Gas"] }),
          txn("m3", {
            merchantName: "Marathon",
            postedDate: "2026-10-12",
            accountName: null,
            categories: ["Groceries"],
          }),
        ],
        decided: "The AI chose Gas for 2 of 3, but it was unsure.",
      },
    );

    it("reads as the Merchant and its count, with a folded row for each Transaction", () => {
      const raw = inRouter(
        <ReviewListItem item={card} state={{}} today={TODAY} actions={noActions} />,
      );
      const html = text(raw);

      expect(html).toContain("Category guess Marathon · 3 Transactions");
      expect(html).toContain("The AI chose Gas for 2 of 3, but it was unsure.");
      expect(html).toContain("Show the 3 Transactions");
      expect(html).toContain("Nov 2 · −$42.50 · Everyday Checking · Gas");
      expect(html).toContain("Oct 12 · −$42.50 · Groceries");
      expect(raw.match(/>Change<\/button>/g)).toHaveLength(3);
      expect(cardTitle(card)).toBe("Marathon · 3 Transactions");
    });

    it("shows a card of one Transaction, and every other kind, as each Transaction's line", () => {
      const one = { ...card, transactions: card.transactions.slice(0, 1) };
      expect(cardTitle(one)).toBeUndefined();
      const html = text(
        inRouter(<ReviewListItem item={one} state={{}} today={TODAY} actions={noActions} />),
      );
      expect(html).toContain("Nov 2 · Marathon · −$42.50 · Everyday Checking");
      expect(html).not.toContain("Change");
      const pair = EVERY_KIND.find((each) => each.kind === UNCLEAR_PAIR_KIND);
      expect(pair === undefined ? "missing" : cardTitle(pair)).toBeUndefined();
    });

    it("holds the card's answers while a row saves, and the rows while the card answers", () => {
      const raw = inRouter(
        <ReviewListItem item={card} state={{ busy: true }} today={TODAY} actions={noActions} />,
      );

      expect(raw.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(3);
      expect(raw).toMatch(/<button[^>]*disabled=""[^>]*>Yes, Gas<\/button>/);
      expect(raw).toMatch(/<button[^>]*disabled=""[^>]*>Not this<\/button>/);
      const idle = inRouter(
        <ReviewListItem item={card} state={{}} today={TODAY} actions={noActions} />,
      );
      expect(idle).not.toContain('disabled=""');

      // A row's save marks its card busy, and clears it after, keeping the card's other state.
      const before = { card: { error: "Earlier." }, other: {} };
      const saving = withBusy(before, "card", true);
      expect(saving).toEqual({ card: { error: "Earlier.", busy: true }, other: {} });
      expect(withBusy(saving, "card", false)).toEqual({
        card: { error: "Earlier.", busy: false },
        other: {},
      });
    });

    it("sets one row's Category alone, with only this Transaction", async () => {
      const sent = recordRequests();

      expect(await changeOneCategory("m3", "Gas")).toBeUndefined();

      expect(sent).toEqual([
        {
          method: "PUT",
          path: "/api/transactions/m3/category",
          body: { category: "Gas", onlyThisTransaction: true },
        },
      ]);
    });
  });

  describe("a Money movement card", () => {
    const transfers = item(
      "sav",
      ONE_SIDED_KIND,
      { value: "keep", label: "Keep it as a Transfer" },
      {
        subject: { type: "transactions", transactionIds: ["s1", "s2"] },
        transactions: ["2026-11-02", "2026-10-02"].map((postedDate, i) =>
          txn(`s${i + 1}`, {
            amount: -50_000,
            postedDate,
            description: "ONLINE TRANSFER TO SAV XXXX5678",
            merchantName: "Online Transfer To Sav",
          }),
        ),
        decided: "They name no account, so they count as Transfers. Which account is this?",
      },
    );
    const person = item(
      "zelle",
      MONEY_FROM_PERSON_KIND,
      { value: "keep", label: "Keep all as Income" },
      {
        subject: { type: "transactions", transactionIds: ["p1", "p2", "p3"] },
        transactions: ["p1", "p2", "p3"].map((id) =>
          txn(id, { amount: 2_000, description: "ZELLE FROM JOHN SMITH", merchantName: null }),
        ),
        decided: "3 payments from this person have no link, so they count as Income.",
      },
    );

    it("reads as its name and count, with a type Change on each row and no Category", () => {
      const raw = inRouter(
        <ReviewListItem item={transfers} state={{}} today={TODAY} actions={noActions} />,
      );
      const html = text(raw);

      expect(html).toContain("One-sided Transfer Online Transfer To Sav · 2 Transactions");
      expect(html).toContain("Nov 2 · −$500.00 · Everyday Checking Change");
      expect(html).not.toContain("No Category yet");
      expect(raw).toContain('aria-label="Change the type of Nov 2 · −$500.00 · Everyday Checking"');
      expect(raw).not.toContain(">Open</a>");
      expect(html).toContain("and nothing is remembered for it.");
    });

    it("opens each money from a person row's Transaction, and says why Not this has nothing", () => {
      const raw = inRouter(
        <ReviewListItem item={person} state={{ choices: [] }} today={TODAY} actions={noActions} />,
      );
      const html = text(raw);

      expect(html).toContain("Money from a person ZELLE FROM JOHN SMITH · 3 Transactions");
      expect(html).toContain("Keep all as Income");
      expect(raw).toContain('href="/transactions/p1"');
      expect(raw.match(/>Open<\/a>/g)).toHaveLength(3);
      expect(html).toContain(
        "No other answer covers the whole card. Change a row to set it alone.",
      );
    });

    it("sets one row's type by hand", async () => {
      const sent = recordRequests();

      expect(await changeOneType("s2", "Spending")).toBeUndefined();
      expect(await changeOneType("s2", "Refund")).toBe("Pick a type.");

      expect(sent).toEqual([
        { method: "PUT", path: "/api/transactions/s2/type", body: { type: "Spending" } },
      ]);
    });
  });

  describe("Transfer pair guesses between the same two Accounts", () => {
    const guess = (id: string, group: string | null, accounts: [string, string]) =>
      item(
        id,
        PAIR_GUESS_KIND,
        { value: "yes", label: "Yes, it is a Transfer" },
        {
          subject: { type: "transactions", transactionIds: [`${id}-out`, `${id}-in`] },
          transactions: [
            txn(`${id}-out`, { accountName: accounts[0] }),
            txn(`${id}-in`, { accountName: accounts[1] }),
          ],
          group,
        },
      );
    const items = [
      guess("g1", "accounts a b", ["Everyday Checking", "Savings"]),
      item("other", BEST_GUESS_KIND, { value: "Gas", label: "Yes, Gas" }),
      guess("g2", "accounts a b", ["Savings", "Everyday Checking"]),
      guess("g3", "accounts a c", ["Everyday Checking", "Brokerage"]),
    ];

    it("show as one group where the first is, each with its own answer, and count once", () => {
      expect(displayGroups(items).map((group) => group.map((each) => each.id))).toEqual([
        ["g1", "g2"],
        ["other"],
        ["g3"],
      ]);
      expect(shownCount(items)).toBe(3);
      expect(groupTitle(displayGroups(items)[0] ?? [])).toBe(
        "Everyday Checking and Savings · 2 Transfer guesses",
      );
      const raw = inRouter(
        <ReviewItems items={items} states={{}} today={TODAY} actions={noActions} />,
      );
      expect(text(raw)).toContain(
        "Transfer guess Everyday Checking and Savings · 2 Transfer guesses",
      );
      expect(raw.match(/>Yes, it is a Transfer<\/button>/g)).toHaveLength(3);
    });
  });

  it('says "Nothing to check." with no items', () => {
    const html = inRouter(<ReviewItems items={[]} states={{}} today={TODAY} actions={noActions} />);

    expect(text(html)).toBe("Nothing to check.");
  });

  it("sends each kind's best answer, Not this, and another choice to the right route", async () => {
    const sent = recordRequests();
    const actions: ItemActions = {
      answer: (each, value) => void answerItem(each.id, value),
      notThis: (each) => void reviewListRequests.choices(each.id),
      changeOne: async () => undefined,
    };

    for (const each of EVERY_KIND) {
      const buttons = buttonsOf(
        ReviewListItem({
          item: each,
          state: { choices: [{ value: "other", label: "Something else" }] },
          today: TODAY,
          actions,
        }),
      );
      buttons.get(each.bestAnswer.label)?.();
      buttons.get("Not this")?.();
      buttons.get("Something else")?.();
    }
    await vi.waitFor(() => expect(sent.length).toBe(EVERY_KIND.length * 5 - 2));

    const answers = (id: string, value: string) => [
      { method: "POST", path: `/api/review-list/${id}/answer`, body: { value } },
      { method: "GET", path: "/api/review-list/count", body: undefined },
    ];
    const choices = (id: string) => ({
      method: "GET",
      path: `/api/review-list/${id}/choices`,
      body: undefined,
    });
    for (const each of EVERY_KIND) {
      const mine = sent.filter((request) => request.path.includes(`/${each.id}/`));
      const bestAnswer =
        each.kind === UNTRACKED_LOAN_KIND
          ? []
          : [
              {
                method: "POST",
                path: `/api/review-list/${each.id}/answer`,
                body: { value: each.bestAnswer.value },
              },
            ];
      expect(mine, each.kind).toEqual(
        expect.arrayContaining([...bestAnswer, choices(each.id), answers(each.id, "other")[0]]),
      );
      expect(mine, each.kind).toHaveLength(bestAnswer.length + 2);
    }
  });

  it("reads the open count again after each answer, for the main menu", async () => {
    const sent = recordRequests();

    expect(await answerItem("guess", "Restaurants")).toEqual({ answered: true, openCount: 2 });
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/review-list/guess/answer",
      "GET /api/review-list/count",
    ]);
  });

  it("keeps an item whose answer is no longer a choice, and shows why", async () => {
    recordRequests({ status: 400, body: { error: "That is not a choice for this item." } });

    const outcome = await answerItem("person", "link spent-1");

    expect(outcome).toEqual({
      answered: false,
      error: "That is not a choice for this item.",
      stillOpen: true,
    });
    const person = EVERY_KIND.find((each) => each.id === "person");
    if (person === undefined || outcome.answered) throw new Error("No item");
    const html = inRouter(
      <ReviewItems
        items={[person]}
        states={{ person: { error: outcome.error } }}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(text(html)).toContain("Keep as Income Not this That is not a choice for this item.");
  });
});
