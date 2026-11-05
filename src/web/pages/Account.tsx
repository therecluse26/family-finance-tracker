import { type FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { calendarDateIn, dateLabel, dollarsAndCents, wholeDollars } from "../../format.ts";
import type {
  AccountView,
  BalancePointView,
  ConnectionView,
  TransactionListView,
  UnconnectedAccountView,
} from "../../server/bank-views.ts";
import type {
  LoanView,
  ManualLoanView,
  TransactionRowView,
} from "../../server/money-movement-views.ts";
import { accountEdits } from "../account-edits.ts";
import { api } from "../api.ts";
import { BalanceChart } from "../components/BalanceChart.tsx";
import { BUTTON, ErrorLine, FIELD } from "../components/Fields.tsx";
import { accountLabel, browserZone, Marks, marksOf } from "./Accounts.tsx";
import { ManualLoanForm } from "./settings/ManualLoans.tsx";
import { UnconnectedAccountForm } from "./settings/UnconnectedAccounts.tsx";
import { merchantOf } from "./Transactions.tsx";

// An Account's page (spec 07, Account list): its balance over time, with estimated days marked,
// and its Transactions from the last year. A Member closes or reopens it, sets its Exclude switch,
// and edits it: a connected loan's type and APR, or an Unconnected account's or Manual loan's form.

const LINK = "text-blue-700 underline";
const SHOWN_DAYS = 365;

// The day `days` before a YYYY-MM-DD date.
export function daysBefore(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() - days);
  return moment.toISOString().slice(0, 10);
}

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// Runs one edit, then tells the page to load again, or shows why the edit did not work.
async function edit(
  run: () => Promise<Response>,
  setError: (error: string | undefined) => void,
  onChanged: () => void,
) {
  setError(undefined);
  try {
    const res = await run();
    if (!res.ok) return setError(await refusal(res));
    onChanged();
  } catch {
    setError("The server did not answer.");
  }
}

// The Exclude switch, and Close or Reopen.
export function AccountSwitches(props: { account: AccountView; onChanged: () => void }) {
  const { account, onChanged } = props;
  const [error, setError] = useState<string | undefined>();
  return (
    <section className="mt-6">
      <label className="block">
        <input
          type="checkbox"
          checked={account.excluded}
          onChange={(e) =>
            void edit(
              () => accountEdits.setExcluded(account.id, e.target.checked),
              setError,
              onChanged,
            )
          }
        />{" "}
        Exclude: its Transactions count nowhere, and its balance drops out of every total.
      </label>
      <button
        type="button"
        className={BUTTON}
        onClick={() =>
          void edit(
            () => (account.closed ? accountEdits.reopen : accountEdits.close)(account.id),
            setError,
            onChanged,
          )
        }
      >
        {account.closed ? "Reopen this Account" : "Close this Account"}
      </button>
      <ErrorLine error={error} />
    </section>
  );
}

const LOAN_TYPE_LABEL = { "cash loan": "Cash loan", "purchase loan": "Purchase loan" } as const;

// A connected loan's type, Cash loan or Purchase loan, and the APR a Member typed.
export function LoanSettings(props: { loan: LoanView; onChanged: () => void }) {
  const { loan } = props;
  const [loanType, setLoanType] = useState<"app" | LoanView["loanType"]>(
    loan.setBy === "app" ? "app" : loan.loanType,
  );
  const [apr, setApr] = useState(loan.apr === null ? "" : String(loan.apr));
  const [error, setError] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const typed = apr.trim() === "" ? null : Number(apr);
    if (typed !== null && !(typed >= 0 && typed <= 100)) {
      return setError("Enter the APR as a percent from 0 to 100.");
    }
    void edit(
      () =>
        accountEdits.setLoan(loan.accountId, {
          loanType: loanType === "app" ? null : loanType,
          apr: typed,
        }),
      setError,
      props.onChanged,
    );
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h2 className="text-lg font-semibold">Loan</h2>
      <fieldset className="mt-3">
        <legend>
          Loan type, now {LOAN_TYPE_LABEL[loan.loanType]}
          {loan.setBy === "app" ? " (set by the app)" : ""}
        </legend>
        {(["app", "cash loan", "purchase loan"] as const).map((each) => (
          <label key={each} className="mt-1 block">
            <input
              type="radio"
              name="loan-type"
              checked={loanType === each}
              onChange={() => setLoanType(each)}
            />{" "}
            {each === "app" ? "Let the app decide" : LOAN_TYPE_LABEL[each]}
          </label>
        ))}
      </fieldset>
      <label className="mt-3 block">
        APR, as a percent (optional)
        <input
          className={FIELD}
          inputMode="decimal"
          value={apr}
          onChange={(e) => setApr(e.target.value)}
        />
      </label>
      <button type="submit" className={BUTTON}>
        Save
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function TransactionList(props: {
  transactions: readonly TransactionRowView[];
  today: string;
}) {
  if (props.transactions.length === 0) {
    return <p className="mt-3 text-gray-600">No Transactions in the last year.</p>;
  }
  // Each row names the Merchant and its day as the Transactions page does.
  return (
    <ul>
      {props.transactions.map((txn) => (
        <li key={txn.id} className="mt-2 flex justify-between gap-x-4">
          <span>
            <span className="text-gray-600">
              {dateLabel(txn.authorizedDate ?? txn.postedDate, props.today)}
            </span>{" "}
            {merchantOf(txn)}
            {txn.pending ? <span className="ml-2 text-sm text-gray-500">pending</span> : null}
          </span>
          <span className="whitespace-nowrap">{dollarsAndCents(txn.amount, { signed: true })}</span>
        </li>
      ))}
    </ul>
  );
}

// What the page shows once every request has answered.
export type AccountFacts = {
  account: AccountView;
  marks: string[];
  points: BalancePointView[];
  transactions: TransactionRowView[];
  // A connected loan's settings.
  loan?: LoanView;
  unconnected?: UnconnectedAccountView;
  manualLoan?: ManualLoanView;
};

export function AccountDetail(props: {
  facts: AccountFacts;
  today: string;
  onChanged: () => void;
}) {
  const { account, marks, points, transactions, loan, unconnected, manualLoan } = props.facts;
  return (
    <>
      <p className="mt-2 text-gray-600">
        {account.institutionName ?? ""}
        <Marks marks={marks} />
      </p>
      <p className="mt-2 text-xl">
        {account.currentBalance === null ? "" : wholeDollars(account.currentBalance)}
      </p>
      <h2 className="mt-6 text-lg font-semibold">Balance over time</h2>
      <BalanceChart points={points} today={props.today} />
      <AccountSwitches account={account} onChanged={props.onChanged} />
      {loan === undefined ? null : <LoanSettings loan={loan} onChanged={props.onChanged} />}
      {unconnected === undefined ? null : (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Edit this Unconnected account</h2>
          <UnconnectedAccountForm account={unconnected} onSaved={props.onChanged} />
        </section>
      )}
      {manualLoan === undefined ? null : (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Edit this Manual loan</h2>
          <ManualLoanForm loan={manualLoan} onSaved={props.onChanged} />
        </section>
      )}
      <h2 className="mt-6 text-lg font-semibold">Transactions</h2>
      <TransactionList transactions={transactions} today={props.today} />
    </>
  );
}

// Reads the Account and everything its page shows. Undefined when no Account has the ID.
async function loadFacts(
  id: string,
  today: string,
  zone: string,
): Promise<AccountFacts | undefined> {
  const from = daysBefore(today, SHOWN_DAYS);
  // The routes read their query themselves, so the typed client does not name it.
  const range = { param: { id }, query: { from } };
  const [listed, linked, balances, txns] = await Promise.all([
    api.accounts.$get(),
    api.connections.$get(),
    api.accounts[":id"].balances.$get(range),
    api.transactions.$get({ query: { account: id, from } }),
  ]);
  if (!listed.ok || !linked.ok || !balances.ok || !txns.ok) throw new Error("refused");
  const { accounts } = (await listed.json()) as { accounts: AccountView[] };
  const account = accounts.find((each) => each.id === id);
  if (account === undefined) return undefined;
  const { connections } = (await linked.json()) as { connections: ConnectionView[] };
  const facts: AccountFacts = {
    account,
    marks: marksOf(account, connections, today, zone),
    points: ((await balances.json()) as { points: BalancePointView[] }).points,
    transactions: ((await txns.json()) as TransactionListView).transactions,
  };
  if (account.kind === "unconnected") {
    const res = await api["unconnected-accounts"].$get();
    const listedAccounts = ((await res.json()) as { accounts: UnconnectedAccountView[] }).accounts;
    facts.unconnected = listedAccounts.find((each) => each.id === id);
  } else if (account.kind === "loan" && account.connectionId === null) {
    const res = await api["manual-loans"].$get();
    const loans = ((await res.json()) as { loans: ManualLoanView[] }).loans;
    facts.manualLoan = loans.find((each) => each.id === id);
  } else if (account.kind === "loan") {
    const res = await api.accounts[":id"].loan.$get({ param: { id } });
    if (res.ok) facts.loan = ((await res.json()) as { loan: LoanView }).loan;
  }
  return facts;
}

export function Account() {
  const { id = "" } = useParams();
  const [facts, setFacts] = useState<AccountFacts | null | undefined>();
  const [error, setError] = useState<string | undefined>();
  const zone = browserZone();
  const today = calendarDateIn(new Date(), zone);

  async function load() {
    try {
      setFacts((await loadFacts(id, today, zone)) ?? null);
    } catch {
      setError("The server did not answer.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load again when the ID changes.
  useEffect(() => {
    void load();
  }, [id]);

  return (
    <main>
      <p>
        <Link className={LINK} to="/accounts">
          Accounts
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">{facts ? accountLabel(facts.account) : "Account"}</h1>
      <ErrorLine error={error} />
      {facts === null ? <p className="mt-3">No Account has this ID.</p> : null}
      {facts ? <AccountDetail facts={facts} today={today} onChanged={() => void load()} /> : null}
    </main>
  );
}
