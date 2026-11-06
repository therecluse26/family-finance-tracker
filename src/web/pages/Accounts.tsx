import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { calendarDateIn, dateLabel, wholeDollars } from "../../format.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import { api } from "../api.ts";
import { browserZone } from "../browser-zone.ts";
import { Card, CardLabel } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { Pill } from "../components/Pill.tsx";
import { StatusText } from "../components/Status.tsx";
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

const LINK = "text-accent underline hover:text-accent-dark";

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

export { browserZone };

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

// The marks shown as a grey pill beside the name. The rest say a Connection needs a Member, so
// they show as a status, with its icon.
const PILL_MARKS = new Set(["estimated", "excluded", "Closed"]);

function MarkPills(props: { marks: readonly string[] }) {
  return (
    <>
      {props.marks
        .filter((mark) => PILL_MARKS.has(mark))
        .map((mark) => (
          <Fragment key={mark}>
            {" "}
            <Pill>{mark}</Pill>
          </Fragment>
        ))}
    </>
  );
}

function SyncMarks(props: { marks: readonly string[] }) {
  return (
    <>
      {props.marks
        .filter((mark) => !PILL_MARKS.has(mark))
        .map((mark) => (
          <StatusText key={mark} tone="serious">
            {mark}
          </StatusText>
        ))}
    </>
  );
}

// Every mark: the pills, then the Connection's status, such as on an Account's page.
export function Marks(props: { marks: readonly string[] }) {
  return (
    <>
      <MarkPills marks={props.marks} /> <SyncMarks marks={props.marks} />
    </>
  );
}

// What fixes a Connection that needs a Member, as Settings, Banks names it (spec 02, Repair).
export function fixOf(connection: ConnectionView | undefined): string | undefined {
  if (connection?.health === "needs a member") return "Repair";
  if (connection?.health === "broken") return "Link again";
  return undefined;
}

// The link to Settings, Banks that fixes a Connection, labelled as that page labels the fix.
export function FixLink(props: { fix: string }) {
  return (
    <Link className={LINK} to="/settings/banks">
      {props.fix}
    </Link>
  );
}

// A balance, or a dash. An Excluded or Closed Account counts in no total, so its dash says so to
// a screen reader; an open one's dash says the provider sent no balance.
export function Balance(props: {
  account: Pick<AccountView, "currentBalance" | "excluded" | "closed">;
}) {
  const { account } = props;
  const notCounted = account.excluded || account.closed;
  if (notCounted || account.currentBalance === null) {
    return (
      <span className="text-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{notCounted ? "Not counted" : "No balance"}</span>
      </span>
    );
  }
  return <>{wholeDollars(account.currentBalance)}</>;
}

// The sum of the balances that count: open Accounts not Excluded, and whether any of them is an
// estimate (spec 07, Status: an estimated number always carries the word "estimated"). Undefined
// when none has a balance.
export function groupTotal(
  accounts: readonly AccountView[],
): { amount: number; estimated: boolean } | undefined {
  const counted = accounts.filter(
    (account) => !account.closed && !account.excluded && account.currentBalance !== null,
  );
  if (counted.length === 0) return undefined;
  return {
    amount: counted.reduce((sum, account) => sum + (account.currentBalance ?? 0), 0),
    estimated: counted.some((account) => account.estimated),
  };
}

// The totals above the list, counted as the dashboard's tiles count them (spec 07, 4. Number
// tiles): Excluded and Closed Accounts count in none. Cash on hand is every connected checking and
// savings Account; Debt is every credit card and loan, as what is owed, so it is positive, and
// counts Manual loans, the app's own estimates.
export function accountTotals(accounts: readonly AccountView[]): {
  cashOnHand: number;
  debt: number;
  estimatedLoans: number;
  unconnected?: { amount: number; estimated: boolean };
} {
  const counted = accounts.filter((account) => !account.closed && !account.excluded);
  const sum = (each: readonly AccountView[]) =>
    each.reduce((total, account) => total + (account.currentBalance ?? 0), 0);
  const cash = counted.filter(
    (account) => account.kind === "depository" && account.connectionId !== null,
  );
  const debts = counted.filter((account) => account.kind === "credit" || account.kind === "loan");
  const unconnected = counted.filter((account) => groupOf(account) === "Unconnected accounts");
  return {
    cashOnHand: sum(cash),
    debt: 0 - sum(debts),
    estimatedLoans: debts.filter(
      (account) => account.kind === "loan" && account.connectionId === null,
    ).length,
    ...(unconnected.length === 0
      ? {}
      : {
          unconnected: {
            amount: sum(unconnected),
            estimated: unconnected.some((account) => account.estimated),
          },
        }),
  };
}

function TotalTile(props: { label: string; cents: number; note?: string }) {
  return (
    <Card as="div" className="min-w-0 flex-[1_1_180px]">
      <CardLabel>{props.label}</CardLabel>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{wholeDollars(props.cents)}</p>
      {props.note === undefined ? null : (
        <p className="mt-0.5 text-small text-muted">{props.note}</p>
      )}
    </Card>
  );
}

export function AccountTotals(props: { accounts: readonly AccountView[] }) {
  if (props.accounts.length === 0) return null;
  const totals = accountTotals(props.accounts);
  const loans = totals.estimatedLoans;
  return (
    <div className="flex flex-wrap gap-3">
      <TotalTile label="Cash on hand" cents={totals.cashOnHand} />
      <TotalTile
        label="Debt"
        cents={totals.debt}
        note={
          loans === 0 ? undefined : `Includes ${loans} estimated ${loans === 1 ? "loan" : "loans"}`
        }
      />
      {totals.unconnected === undefined ? null : (
        <TotalTile
          label="Unconnected accounts"
          cents={totals.unconnected.amount}
          note={totals.unconnected.estimated ? "Includes estimated balances" : undefined}
        />
      )}
    </div>
  );
}

// Each row: the name and last 4 digits with its pills, the institution and any Connection status
// under it, and the balance at the right.
function AccountRow(props: { account: AccountView; marks: readonly string[]; fix?: string }) {
  const { account, marks, fix } = props;
  const facts: ReactNode[] = [
    ...(account.institutionName === null ? [] : [account.institutionName]),
    ...(marks.some((mark) => !PILL_MARKS.has(mark))
      ? [<SyncMarks key="sync" marks={marks} />]
      : []),
    ...(fix === undefined ? [] : [<FixLink key="fix" fix={fix} />]),
  ];
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 border-t border-line-soft py-3">
      <div className="min-w-0">
        <Link
          className="font-semibold text-ink hover:text-accent hover:underline"
          to={`/accounts/${account.id}`}
        >
          {accountLabel(account)}
        </Link>
        <MarkPills marks={marks} />
        {facts.length === 0 ? null : (
          <p className="mt-0.5 text-small text-muted">
            {facts.map((fact, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts keep their order.
              <Fragment key={index}>
                {index === 0 ? null : " · "}
                {fact}
              </Fragment>
            ))}
          </p>
        )}
      </div>
      <span className="min-w-[96px] text-right font-semibold tabular-nums">
        <Balance account={account} />
      </span>
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
      fix={fixOf(props.connections.find((each) => each.id === account.connectionId))}
    />
  );
  const open = props.accounts.filter((account) => !account.closed);
  const closed = props.accounts.filter((account) => account.closed);
  if (props.accounts.length === 0) {
    return (
      <Card>
        <p className="text-muted">No Accounts yet.</p>
      </Card>
    );
  }
  return (
    <>
      {open.length === 0 ? null : (
        <Card padding="list">
          {ACCOUNT_GROUPS.map((group) => {
            const inGroup = open.filter((account) => groupOf(account) === group);
            if (inGroup.length === 0) return null;
            const total = groupTotal(inGroup);
            return (
              <section key={group}>
                <div className="flex items-baseline justify-between gap-3 pt-3.5 pb-1.5 text-small font-semibold tracking-[.05em] text-muted uppercase">
                  <h2>{group}</h2>
                  {total === undefined ? null : (
                    <span className="tabular-nums">
                      {total.estimated ? (
                        <>
                          <span className="normal-case">
                            <Pill>estimated</Pill>
                          </span>{" "}
                        </>
                      ) : null}
                      {wholeDollars(total.amount)}
                    </span>
                  )}
                </div>
                <ul>{inGroup.map(row)}</ul>
              </section>
            );
          })}
        </Card>
      )}
      {closed.length === 0 ? null : (
        <Card padding="list">
          <details className="py-2">
            <summary className="cursor-pointer py-2 font-semibold">
              Closed Accounts ({closed.length})
            </summary>
            <ul>{closed.map(row)}</ul>
          </details>
        </Card>
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
    <Page>
      <PageHeading title="Accounts" />
      <ErrorLine error={error} />
      {accounts === undefined ? null : (
        <>
          <AccountTotals accounts={accounts} />
          <AccountList accounts={accounts} connections={connections} today={today} zone={zone} />
        </>
      )}
      <Card padding="list">
        <details className="py-2">
          <summary className="cursor-pointer py-2 font-semibold">
            Add an Unconnected account
          </summary>
          <div className="pb-2">
            <UnconnectedAccountForm account={null} onSaved={() => void load()} />
          </div>
        </details>
      </Card>
      <Card padding="list">
        <details className="py-2">
          <summary className="cursor-pointer py-2 font-semibold">Add a Manual loan</summary>
          <div className="pb-2">
            <ManualLoanForm loan={null} onSaved={() => void load()} />
          </div>
        </details>
      </Card>
      <p className="text-small text-muted">
        Add or remove a bank in{" "}
        <Link className={LINK} to="/settings/banks">
          Settings → Banks
        </Link>
        .
      </p>
    </Page>
  );
}
