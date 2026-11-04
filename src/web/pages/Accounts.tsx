import { useEffect, useState } from "react";
import { Link } from "react-router";
import { calendarDateIn, dateLabel, wholeDollars } from "../../format.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import { api } from "../api.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { ManualLoanForm } from "./settings/ManualLoans.tsx";
import { UnconnectedAccountForm } from "./settings/UnconnectedAccounts.tsx";

// The Account list (spec 07, Account list): every Account grouped by type, with its balance and
// its marks. Tapping an Account opens its page. Closed Accounts sit in a collapsed section at the
// end. A Member adds Unconnected accounts and Manual loans here.

export const ACCOUNT_GROUPS = [
  "Checking",
  "Savings",
  "Credit cards",
  "Loans",
  "Unconnected accounts",
] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

const LINK = "text-blue-700 underline";

// A synced investment Account counts like an Unconnected account of kind "investment or
// retirement" (spec 02, Account kinds), so it is listed with them.
export function groupOf(account: AccountView): AccountGroup {
  if (account.kind === "depository") return account.subtype === "checking" ? "Checking" : "Savings";
  if (account.kind === "credit") return "Credit cards";
  if (account.kind === "loan") return "Loans";
  return "Unconnected accounts";
}

// "Everyday Checking ··1234".
export function accountLabel(account: Pick<AccountView, "name" | "mask">): string {
  return `${account.name}${account.mask === null ? "" : ` ··${account.mask}`}`;
}

// The browser's own time zone, for "today" and for when a Connection last synced.
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The marks that apply, in order: "last synced <date>" while its Connection needs a Member or is
// Broken (spec 02, Broken Connections), "estimated", "excluded", and "Closed".
export function marksOf(
  account: AccountView,
  connections: readonly ConnectionView[],
  today: string,
  zone: string,
): string[] {
  const marks: string[] = [];
  const connection = connections.find((each) => each.id === account.connectionId);
  if (connection?.health === "needs a member" || connection?.health === "broken") {
    marks.push(
      connection.lastSyncedAt === null
        ? "never synced"
        : `last synced ${dateLabel(calendarDateIn(new Date(connection.lastSyncedAt), zone), today)}`,
    );
  }
  if (account.estimated) marks.push("estimated");
  if (account.excluded) marks.push("excluded");
  if (account.closed) marks.push("Closed");
  return marks;
}

export function Marks(props: { marks: readonly string[] }) {
  return (
    <>
      {props.marks.map((mark) => (
        <span key={mark} className="ml-2 text-sm text-gray-500">
          {mark}
        </span>
      ))}
    </>
  );
}

function AccountRow(props: { account: AccountView; marks: readonly string[] }) {
  const { account } = props;
  return (
    <li className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4">
      <span>
        <Link className={LINK} to={`/accounts/${account.id}`}>
          {accountLabel(account)}
        </Link>
        {account.institutionName === null ? null : (
          <span className="ml-2 text-gray-600">{account.institutionName}</span>
        )}
        <Marks marks={props.marks} />
      </span>
      <span>{account.currentBalance === null ? "" : wholeDollars(account.currentBalance)}</span>
    </li>
  );
}

export function AccountList(props: {
  accounts: readonly AccountView[];
  connections: readonly ConnectionView[];
  today: string;
  zone: string;
}) {
  const row = (account: AccountView) => (
    <AccountRow
      key={account.id}
      account={account}
      marks={marksOf(account, props.connections, props.today, props.zone)}
    />
  );
  const open = props.accounts.filter((account) => !account.closed);
  const closed = props.accounts.filter((account) => account.closed);
  return (
    <>
      {props.accounts.length === 0 ? <p className="mt-4">No Accounts yet.</p> : null}
      {ACCOUNT_GROUPS.map((group) => {
        const inGroup = open.filter((account) => groupOf(account) === group);
        if (inGroup.length === 0) return null;
        return (
          <section key={group} className="mt-6">
            <h2 className="text-lg font-semibold">{group}</h2>
            <ul>{inGroup.map(row)}</ul>
          </section>
        );
      })}
      {closed.length === 0 ? null : (
        <details className="mt-6">
          <summary className="text-lg font-semibold">Closed Accounts ({closed.length})</summary>
          <ul>{closed.map(row)}</ul>
        </details>
      )}
    </>
  );
}

export function Accounts() {
  const [accounts, setAccounts] = useState<AccountView[] | undefined>();
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [error, setError] = useState<string | undefined>();
  const zone = browserZone();
  const today = calendarDateIn(new Date(), zone);

  async function load() {
    try {
      const [listed, linked] = await Promise.all([api.accounts.$get(), api.connections.$get()]);
      if (!listed.ok || !linked.ok) return setError("That did not work.");
      setAccounts(((await listed.json()) as { accounts: AccountView[] }).accounts);
      setConnections(((await linked.json()) as { connections: ConnectionView[] }).connections);
    } catch {
      setError("The server did not answer.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <ErrorLine error={error} />
      {accounts === undefined ? null : (
        <AccountList accounts={accounts} connections={connections} today={today} zone={zone} />
      )}
      <details className="mt-6">
        <summary className="font-semibold">Add an Unconnected account</summary>
        <UnconnectedAccountForm account={null} onSaved={() => void load()} />
      </details>
      <details className="mt-3">
        <summary className="font-semibold">Add a Manual loan</summary>
        <ManualLoanForm loan={null} onSaved={() => void load()} />
      </details>
    </main>
  );
}
