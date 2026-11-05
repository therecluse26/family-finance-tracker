import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CATEGORIES } from "../../categories/list.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type { AccountView, TransactionListView } from "../../server/bank-views.ts";
import type { TransactionRowView } from "../../server/money-movement-views.ts";
import { api } from "../api.ts";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import {
  categoryOrType,
  filterQuery,
  filtersOf,
  TRANSACTION_TYPES,
  type TransactionFilters,
  transactionPath,
  transactionRequests,
} from "../transactions.ts";
import { accountLabel, browserZone } from "./Accounts.tsx";

// The Transactions page (spec 07, Transactions page): every Transaction that shows, newest first,
// one page at a time, with filters. The filters live in the page's address, so other pages open it
// filtered. Tapping a row opens its detail view. Using this page is never required.

const LINK = "text-blue-700 underline";
const BUTTON = "mt-4 mr-2 rounded border border-gray-300 px-3 py-1";

// The Merchant's clean name, else the provider's name, else the bank's line.
export const merchantOf = (txn: TransactionRowView) =>
  txn.merchant ?? txn.merchantName ?? txn.description;

// "Oct 9 · Corner Bistro · −$42.50 · Everyday Checking ··1234 · Restaurants". A Transaction's day is
// its purchase date when it has one.
export function rowLine(
  txn: TransactionRowView,
  accounts: ReadonlyMap<string, string>,
  today: string,
): string {
  return [
    dateLabel(txn.authorizedDate ?? txn.postedDate, today),
    merchantOf(txn),
    dollarsAndCents(txn.amount),
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
    options: readonly { value: string; label: string }[],
  ) => (
    <label className="block">
      {label}
      <select
        name={name}
        className={FIELD}
        value={draft[name] ?? ""}
        onChange={(e) => set(name)(e.target.value)}
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const field = (name: "merchant" | "from" | "to" | "month", label: string, type: string) => (
    <label className="block">
      {label}
      <input
        name={name}
        type={type}
        className={FIELD}
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
    <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={submit} aria-label="Filters">
      {select(
        "account",
        "Account",
        props.accounts.map((account) => ({ value: account.id, label: accountLabel(account) })),
      )}
      {select(
        "category",
        "Category",
        CATEGORIES.map((category) => ({ value: category.name, label: category.name })),
      )}
      {select(
        "type",
        "Type",
        TRANSACTION_TYPES.map((type) => ({ value: type, label: type })),
      )}
      {field("merchant", "Merchant", "text")}
      {field("from", "From", "date")}
      {field("to", "To", "date")}
      {field("month", "Month", "month")}
      <div className="sm:col-span-3">
        <button type="submit" className={BUTTON}>
          Show
        </button>
        <button type="button" className={BUTTON} onClick={props.onClear}>
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
    return <p className="mt-4">No Transactions match these filters.</p>;
  }
  return (
    <ul className="mt-4">
      {props.transactions.map((txn) => (
        <li key={txn.id} className="mt-2 flex justify-between gap-x-4">
          <Link className={LINK} to={transactionPath(txn.id)}>
            {rowLine(txn, props.accounts, props.today)}
          </Link>
          {txn.pending ? <span className="text-sm text-gray-500">pending</span> : null}
        </li>
      ))}
    </ul>
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
    <main>
      <h1 className="text-2xl font-semibold">Transactions</h1>
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
        <button type="button" className={BUTTON} onClick={() => void showMore()}>
          Show more
        </button>
      )}
    </main>
  );
}
