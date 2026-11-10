import type { HandLinkBody, ShownPartView, SplitBody } from "../server/money-movement-views.ts";
import { api } from "./api.ts";

// The Transactions page's filters, requests, and words (spec 07, Transactions page). The routes
// that read their query or body themselves are not named in the typed client, so each goes in
// through a separate object.

export const TRANSACTION_TYPES = [
  "Spending",
  "Income",
  "Transfer",
  "Saving",
  "Refund",
  "Reimbursement",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// The types a Member may set by hand (spec 03, Transaction types).
export const HAND_SET_TYPES = ["Spending", "Transfer", "Income", "Saving"] as const;
export type HandSetType = (typeof HAND_SET_TYPES)[number];

export const PAGE_SIZE = 100;

// The filters, as the page's address holds them. Dates are YYYY-MM-DD posted dates, and a month is
// YYYY-MM, from the purchase date, else the posted date.
export type TransactionFilters = {
  account?: string;
  category?: string;
  merchant?: string;
  // The provider's Merchant ID, matched exactly, as the Reports page's drill-down sets it.
  merchantId?: string;
  type?: TransactionType;
  from?: string;
  to?: string;
  month?: string;
};

export const FILTER_NAMES = [
  "account",
  "category",
  "merchant",
  "merchantId",
  "type",
  "from",
  "to",
  "month",
] as const satisfies readonly (keyof TransactionFilters)[];

const isType = (value: string): value is TransactionType =>
  (TRANSACTION_TYPES as readonly string[]).includes(value);

// The filters in an address's query. An empty or unknown one is left out.
export function filtersOf(params: URLSearchParams): TransactionFilters {
  const filters: TransactionFilters = {};
  for (const name of FILTER_NAMES) {
    const value = params.get(name)?.trim();
    if (value === undefined || value === "") continue;
    if (name === "type") {
      if (isType(value)) filters.type = value;
    } else {
      filters[name] = value;
    }
  }
  return filters;
}

// The query of the filters that are set, in a fixed order.
export function filterQuery(filters: TransactionFilters): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of FILTER_NAMES) {
    const value = filters[name];
    if (value !== undefined && value !== "") query[name] = value;
  }
  return query;
}

// The Transactions page, filtered. Other pages open it this way: by Category and month, by
// Merchant, or by last month's Income, such as transactionsPath({ type: "Income", month }).
export function transactionsPath(filters: TransactionFilters = {}): string {
  const query = new URLSearchParams(filterQuery(filters)).toString();
  return query === "" ? "/transactions" : `/transactions?${query}`;
}

export const transactionPath = (id: string) => `/transactions/${encodeURIComponent(id)}`;

// How a Member narrows the Spending that money in may pay back: its Merchant's clean name, and its
// posted dates, YYYY-MM-DD. An empty field is left out.
export type CandidateSearch = { merchant: string; from: string; to: string };

// The filters for the Spending that money in posted on `postedDate` may pay back by hand (spec 03,
// Undo and hand links): Spending posted on or before that day, narrowed by the search. A later
// "to" is cut back to that day.
export function candidateFilters(search: CandidateSearch, postedDate: string): TransactionFilters {
  const merchant = search.merchant.trim();
  return {
    type: "Spending",
    ...(merchant === "" ? {} : { merchant }),
    ...(search.from === "" ? {} : { from: search.from }),
    to: search.to !== "" && search.to < postedDate ? search.to : postedDate,
  };
}

export const transactionRequests = {
  // One page of the list, after the Transaction with the ID `after`.
  list: (filters: TransactionFilters, after?: string) => {
    const query = {
      ...filterQuery(filters),
      limit: String(PAGE_SIZE),
      ...(after === undefined ? {} : { after }),
    };
    return api.transactions.$get({ query });
  },
  detail: (id: string) => api.transactions[":id"].$get({ param: { id } }),
  // Without "only this Transaction", the app also makes a Category rule for its Merchant.
  setCategory: (id: string, category: string, onlyThisTransaction: boolean) => {
    const edit = { param: { id }, json: { category, onlyThisTransaction } };
    return api.transactions[":id"].category.$put(edit);
  },
  setType: (id: string, type: HandSetType) => {
    const edit = { param: { id }, json: { type } };
    return api.transactions[":id"].type.$put(edit);
  },
  split: (id: string, body: SplitBody) => {
    const edit = { param: { id }, json: body };
    return api.transactions[":id"].split.$put(edit);
  },
  removeSplit: (id: string) => api.transactions[":id"].split.$delete({ param: { id } }),
  link: (body: HandLinkBody) => {
    const edit = { json: body };
    return api.links.$post(edit);
  },
  undoLink: (linkId: string) => api.links[":id"].$delete({ param: { id: linkId } }),
};

// The parts worth a line: a linked Refund or Reimbursement's share of a split part that rounds to
// $0 is left out.
export function partsToShow(parts: readonly ShownPartView[]): ShownPartView[] {
  return parts.filter((part) => !(part.linked && part.amount === 0));
}

// A part's words: its Category for Spending, "Refund: Groceries" for a Refund or Reimbursement, and
// its type for the rest.
export function partLabel(part: ShownPartView): string {
  if (part.type === "Spending") return part.category ?? "Spending, no Category yet";
  if (part.type === "Refund" || part.type === "Reimbursement") {
    return part.category === null ? part.type : `${part.type}: ${part.category}`;
  }
  return part.type;
}

// A row's Category or type: "Restaurants", "Transfer", "Split: Groceries, Clothing", or each part's
// words, such as "Interest and fees + Transfer" for a loan payment. A split part the bank shrank to
// $0 is left out of the row; the detail view shows it.
export function categoryOrType(parts: readonly ShownPartView[]): string {
  const visible = partsToShow(parts);
  if (visible.length === 0) return "Not decided yet";
  const nonZero = visible.filter((part) => part.amount !== 0);
  const shown = nonZero.length === 0 ? visible : nonZero;
  const labels = [...new Set(shown.map(partLabel))];
  if (shown.length > 1 && (isSplit(shown) || fromLineItems(shown))) {
    return `Split: ${labels.join(", ")}`;
  }
  return labels.join(" + ");
}

// A split from Amazon items: every part Spending, and every Category from the Transaction's Line
// items (spec 14, Splits from Line items).
export function fromLineItems(parts: readonly ShownPartView[]): boolean {
  return (
    parts.length > 1 &&
    parts.every((part) => part.type === "Spending" && part.categoryChosenBy === "Amazon items")
  );
}

// A Member's split: every part Spending, and every Category hand-set.
export function isSplit(parts: readonly ShownPartView[]): boolean {
  return (
    parts.length > 1 &&
    parts.every((part) => part.type === "Spending" && part.categoryChosenBy === "hand-set")
  );
}

// How the part's Category was chosen (spec 04, Provenance), or undefined when it has none.
export function chosenByLabel(part: ShownPartView): string | undefined {
  if (part.linked) return "the linked Spending's Category";
  if (part.categoryChosenBy === "Amazon items") return undefined;
  return part.categoryChosenBy ?? undefined;
}
