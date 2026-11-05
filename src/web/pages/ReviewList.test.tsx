import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEST_GUESS_KIND } from "../../categorization/index.ts";
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
import { acceptOf, answerItem, reviewListRequests, UNTRACKED_LOAN_KIND } from "../review-list.ts";
import { routes } from "../routes.tsx";
import { type ItemActions, ReviewItems, ReviewListItem } from "./ReviewList.tsx";

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

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const inRouter = (node: ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);
const noActions: ItemActions = { answer: () => {}, notThis: () => {} };

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
      ...html.matchAll(/<li class="mt-4[^>]*>(.*?)<\/li>(?=<li class="mt-4|<\/ul>$)/gs),
    ].map((match) => text(match[1] ?? ""));

    expect([...html.matchAll(/data-kind="([^"]*)"/g)].map((match) => match[1])).toEqual(
      EVERY_KIND.map((each) => each.kind),
    );
    expect(rows).toEqual([
      "Oct 12 · Corner Bistro · −$42.50 · Everyday Checking No AI was available, so the app guessed Restaurants. Yes, Restaurants Not this",
      "Oct 12 · TRANSFER TO SAVINGS · −$500.00 · Everyday Checking Oct 12 · TRANSFER FROM CHECKING · +$500.00 · Everyday Checking These match as a Transfer, but nothing more ties them, so they are not linked. Yes, they are one Transfer Not this",
      "Oct 12 · TRANSFER TO SAVINGS · −$500.00 · Everyday Checking Oct 12 · TRANSFER FROM CHECKING · +$500.00 · Everyday Checking Two sets of Transfer pairs were equally good, so the app picked this one. Yes, they are one Transfer Not this",
      "Oct 12 · Corner Bistro · −$42.50 · Everyday Checking It names no account, so it counts as a Transfer. Which account is this? Keep it as a Transfer Not this",
      "Oct 12 · Corner Bistro · +$30.00 · Everyday Checking Money from a person with no link counts as Income. Keep as Income Not this",
      "Oct 12 · Corner Bistro · −$42.50 · Everyday Checking Payments to Lakeside Auto count as Transfers, so their interest cannot show. Add it as a Manual loan Not this",
      "Oct 12 · Corner Bistro · −$42.50 · Everyday Checking This payment may belong to Lakeside Auto. Link to this loan Not this",
      "Lakeside Auto No payment to Lakeside Auto has linked since 2026-08-15. Keep the loan open Not this",
    ]);
    // A signed amount never breaks after its sign (spec 07, Number formats).
    expect(html).toContain(' · <span class="whitespace-nowrap">−$42.50</span> · ');
    expect(html).toContain(' · <span class="whitespace-nowrap">+$500.00</span> · ');
    // The untracked loan's best answer opens the Manual loan form, with the lender filled in.
    expect(html).toContain('href="/settings/banks?lender=Lakeside%20Auto#manual-loans"');
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
