import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CATEGORIES } from "../../categories/list.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type { AccountView, TransactionListView } from "../../server/bank-views.ts";
import type { CategoryChosenBy, TransactionRowView } from "../../server/money-movement-views.ts";
import { api } from "../api.ts";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { Pill } from "../components/Pill.tsx";
import {
  categoryOrType,
  filterQuery,
  filtersOf,
  partsToShow,
  TRANSACTION_TYPES,
  type TransactionFilters,
  transactionPath,
  transactionRequests,
} from "../transactions.ts";
import { accountLabel, browserZone } from "./Accounts.tsx";

// The Transactions page (spec 07, Transactions page): every Transaction that shows, newest first,
// one page at a time, with filters. The filters live in the page's address, so other pages open it
// filtered. Tapping a row opens its detail view. Using this page is never required.

// The boards' compact filter field: 38 px high, 14 px text.
const FILTER_FIELD =
  "mt-1 block h-[38px] w-full rounded-control border border-field bg-white px-2.5 text-sm text-ink";
const FILTER_LABEL = "block text-small font-semibold text-muted";

// The Merchant's clean name, else the provider's name, else the bank's line.
export const merchantOf = (txn: TransactionRowView) =>
  txn.merchant ?? txn.merchantName ?? txn.description;

// "Oct 9 · Corner Bistro · −$42.50 · Everyday Checking ··1234 · Restaurants". A Transaction's day is
// its purchase date when it has one. Money in shows "+", since the list shows both (spec 07, Number
// formats).
export function rowLine(
  txn: TransactionRowView,
  accounts: ReadonlyMap<string, string>,
  today: string,
): string {
  return [
    dateLabel(txn.authorizedDate ?? txn.postedDate, today),
    merchantOf(txn),
    dollarsAndCents(txn.amount, { signed: true }),
    accounts.get(txn.accountId) ?? "An Account",
    categoryOrType(txn.parts),
  ].join(" · ");
}

export const accountLabels = (accounts: readonly AccountView[]) =>
  new Map(accounts.map((account) => [account.id, accountLabel(account)]));

// The filter fields, as a Member edits them before pressing Show.
export function TransactionFilterForm(props: {
  draft: TransactionFilters;
  accounts: readonly AccountView[];
  onDraft: (draft: TransactionFilters) => void;
  onShow: () => void;
  onClear: () => void;
}) {
  const { draft, onDraft } = props;
  const set = (name: keyof TransactionFilters) => (value: string) =>
    onDraft({ ...draft, [name]: value === "" ? undefined : value });
  const select = (
    name: "account" | "category" | "type",
    label: string,
    any: string,
    options: readonly { value: string; label: string }[],
  ) => (
    <label className={FILTER_LABEL}>
      {label}
      <select
        name={name}
        className={FILTER_FIELD}
        value={draft[name] ?? ""}
        onChange={(e) => set(name)(e.target.value)}
      >
        <option value="">{any}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const field = (name: "merchant" | "from" | "to" | "month", label: string, type: string) => (
    <label className={FILTER_LABEL}>
      {label}
      <input
        name={name}
        type={type}
        className={FILTER_FIELD}
        value={draft[name] ?? ""}
        onChange={(e) => set(name)(e.target.value)}
      />
    </label>
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    props.onShow();
  }
  return (
    <form
      className="grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-4"
      onSubmit={submit}
      aria-label="Filters"
    >
      {select(
        "account",
        "Account",
        "All Accounts",
        props.accounts.map((account) => ({ value: account.id, label: accountLabel(account) })),
      )}
      {select(
        "category",
        "Category",
        "All Categories",
        CATEGORIES.map((category) => ({ value: category.name, label: category.name })),
      )}
      {select(
        "type",
        "Type",
        "All types",
        TRANSACTION_TYPES.map((type) => ({ value: type, label: type })),
      )}
      {field("merchant", "Merchant", "text")}
      {field("from", "From", "date")}
      {field("to", "To", "date")}
      {field("month", "Month", "month")}
      <div className="col-span-2 flex flex-wrap items-end gap-2 sm:col-span-1">
        <button type="submit" className={buttonClass("primary")}>
          Show
        </button>
        <button type="button" className={buttonClass("outlined")} onClick={props.onClear}>
          Clear the filters
        </button>
      </div>
    </form>
  );
}

export function TransactionRows(props: {
  transactions: readonly TransactionRowView[];
  accounts: ReadonlyMap<string, string>;
  today: string;
}) {
  if (props.transactions.length === 0) {
    return (
      <Card>
        <p className="text-muted">No Transactions match these filters.</p>
      </Card>
    );
  }
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full border-collapse text-sm">
        <thead className="max-sm:hidden">
          <tr>
            <th className={TH}>Date</th>
            <th className={TH}>Merchant</th>
            <th className={TH}>Category or type</th>
            <th className={TH}>Account</th>
            <th className={`${TH} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {props.transactions.map((txn) => (
            <TransactionRow
              key={txn.id}
              txn={txn}
              account={props.accounts.get(txn.accountId) ?? "An Account"}
              today={props.today}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The table's head and cells, from the boards. Below 640 px a row folds into two lines: the
// Merchant and the amount, then the date, the Category or type, and the Account.
const TH = "border-b border-line px-3 py-2.5 text-left text-xs font-semibold text-muted";
const TD =
  "border-b border-line-soft px-3 py-[11px] tabular-nums sm:relative max-sm:border-0 max-sm:p-0";
const FOLDED_FACT = `${TD} text-muted max-sm:order-3 max-sm:text-small`;
// On a phone a dot ends each fact but the last, so a wrapped line never starts with one.
const DOT_AFTER = "max-sm:after:px-1 max-sm:after:content-['·']";
const AI_CHOSEN: readonly CategoryChosenBy[] = ["AI", "AI, unsure"];

// One row. The whole row opens the detail view. The Merchant's link is the row's one link for the
// keyboard and screen readers, and it names the date and amount too, so a list of links tells the
// rows apart. From 640 px each other cell holds a copy of the link that covers that cell, out of
// the tab order and hidden from screen readers. The links are placed against their own cell, never
// against the row: some WebKit versions do not place against a table row. On a phone the row is
// a flex box, so the Merchant's link covers all of it.
function TransactionRow(props: { txn: TransactionRowView; account: string; today: string }) {
  const { txn } = props;
  const path = transactionPath(txn.id);
  const parts = partsToShow(txn.parts);
  const typeOnly = parts.every((part) => part.category === null);
  const byAi = parts.some(
    (part) => part.categoryChosenBy !== null && AI_CHOSEN.includes(part.categoryChosenBy),
  );
  const date = dateLabel(txn.authorizedDate ?? txn.postedDate, props.today);
  const amount = dollarsAndCents(txn.amount, { signed: true });
  return (
    <tr className="hover:bg-page has-[a:focus-visible]:bg-selected max-sm:relative max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-y-0.5 max-sm:border-t max-sm:border-line-soft max-sm:px-4 max-sm:py-[11px] max-sm:first:border-t-0">
      <td className={`${FOLDED_FACT} ${DOT_AFTER} whitespace-nowrap sm:text-ink`}>
        {date}
        <CellLink to={path} />
      </td>
      <td className={`${TD} max-sm:order-1 max-sm:w-[calc(100%-7.5rem)] max-sm:min-w-0`}>
        <Link
          className="font-medium text-ink after:absolute after:inset-0 after:content-[''] hover:text-accent hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
          to={path}
        >
          {merchantOf(txn)}
          <span className="sr-only">{`, ${date}, ${amount}`}</span>
        </Link>
        {txn.pending ? (
          <>
            {" "}
            <Pill>pending</Pill>
          </>
        ) : null}
      </td>
      <td className={`${FOLDED_FACT} ${DOT_AFTER} ${typeOnly ? "" : "sm:text-ink"}`}>
        {categoryOrType(txn.parts)}
        {byAi ? (
          <>
            {" "}
            <ChosenByAiMark />
          </>
        ) : null}
        <CellLink to={path} />
      </td>
      <td className={`${FOLDED_FACT} whitespace-nowrap`}>
        {props.account}
        <CellLink to={path} />
      </td>
      <td
        className={`${TD} whitespace-nowrap text-right max-sm:order-2 max-sm:w-[7.5rem] ${txn.amount > 0 ? "text-good" : ""}`}
      >
        {amount}
        <CellLink to={path} />
      </td>
    </tr>
  );
}

// A copy of the row's link that covers its cell from 640 px. The Merchant's link is the one the
// keyboard and screen readers reach.
function CellLink(props: { to: string }) {
  return (
    <Link
      to={props.to}
      tabIndex={-1}
      aria-hidden="true"
      className="absolute inset-0 max-sm:hidden"
    />
  );
}

// The boards' purple AI tag beside a Category the AI chose. Screen readers hear what it means, so
// it does not rest on a tooltip. The shared AiMark says "Written by AI", which suits AI text, not a
// Category.
function ChosenByAiMark() {
  return (
    <>
      <span
        aria-hidden="true"
        className="inline-block rounded-tag bg-ai-soft px-1.5 py-px align-middle text-[10px] font-bold tracking-[.05em] text-ai"
      >
        AI
      </span>
      <span className="sr-only">(Category chosen by the AI)</span>
    </>
  );
}

// Reads one page of the list, or why it could not.
export async function readPage(
  filters: TransactionFilters,
  after?: string,
): Promise<TransactionListView | string> {
  try {
    const res = await transactionRequests.list(filters, after);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      return typeof body.error === "string" ? body.error : "That did not work.";
    }
    return (await res.json()) as TransactionListView;
  } catch {
    return "The server did not answer.";
  }
}

export function Transactions() {
  const [params, setParams] = useSearchParams();
  const filters = filtersOf(params);
  const shown = new URLSearchParams(filterQuery(filters)).toString();
  const [draft, setDraft] = useState<TransactionFilters>(filters);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [rows, setRows] = useState<TransactionRowView[] | undefined>();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const today = calendarDateIn(new Date(), browserZone());

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.accounts.$get();
        if (res.ok) setAccounts(((await res.json()) as { accounts: AccountView[] }).accounts);
      } catch {
        setError("The server did not answer.");
      }
    })();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read the first page again when the filters change.
  useEffect(() => {
    let current = true;
    setDraft(filters);
    setRows(undefined);
    void readPage(filters).then((page) => {
      if (!current) return;
      if (typeof page === "string") return setError(page);
      setError(undefined);
      setRows(page.transactions);
      setNext(page.next);
    });
    return () => {
      current = false;
    };
  }, [shown]);

  async function showMore() {
    if (next === null) return;
    const page = await readPage(filters, next);
    if (typeof page === "string") return setError(page);
    setRows((all) => [...(all ?? []), ...page.transactions]);
    setNext(page.next);
  }

  return (
    <Page width="wide">
      <PageHeading title="Transactions" />
      <TransactionFilterForm
        draft={draft}
        accounts={accounts}
        onDraft={setDraft}
        onShow={() => setParams(new URLSearchParams(filterQuery(draft)))}
        onClear={() => setParams(new URLSearchParams())}
      />
      <ErrorLine error={error} />
      {rows === undefined ? null : (
        <TransactionRows transactions={rows} accounts={accountLabels(accounts)} today={today} />
      )}
      {next === null ? null : (
        <div className="flex justify-center">
          <button type="button" className={buttonClass("outlined")} onClick={() => void showMore()}>
            Show more
          </button>
        </div>
      )}
    </Page>
  );
}
