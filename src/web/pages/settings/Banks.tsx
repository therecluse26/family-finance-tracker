import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import type { SyncNowView, UnconnectedAccountView } from "../../../server/bank-views.ts";
import type { ManualLoanView } from "../../../server/money-movement-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { Card } from "../../components/Card.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { Connections } from "./Connections.tsx";
import { AddManualLoan, lenderInAddress, ManualLoanRows } from "./ManualLoans.tsx";
import {
  BOX,
  BUTTONS,
  DoneLine,
  Field,
  LABEL,
  Lead,
  SettingCard,
  TabHeading,
} from "./settings-ui.tsx";
import { AddUnconnectedAccount, UnconnectedAccountRows } from "./UnconnectedAccounts.tsx";

// Settings, Banks: Sync now (spec 02, Sync now), the Plaid keys and the count of Plaid Items
// (spec 02, Plaid keys and The 10 lifetime Items), the Connections, and the Unconnected accounts
// and Manual loans. The app never shows the secret again, only that it is set.

// The words to show for a refused request: the server's own, such as "Sign in first".
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

export function PlaidKeysForm(props: { plaid: PlaidView; onSaved: (plaid: PlaidView) => void }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await api.plaid.keys.$post({
        json: { clientId: clientId.trim(), secret: secret.trim() },
      });
      if (!res.ok) return setError(await refusal(res));
      const body = (await res.json()) as { plaid: PlaidView };
      setClientId("");
      setSecret("");
      props.onSaved(body.plaid);
      setDone("The keys work. They are saved.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 id="plaid-keys" className="flex-1 text-heading font-bold">
          Plaid keys
        </h3>
        {props.plaid.secretSet ? (
          <span className="text-small">
            <StatusText tone="good">Saved</StatusText>
          </span>
        ) : null}
      </div>
      <p className="mt-1.5">
        {props.plaid.secretSet
          ? `Client ID ${props.plaid.clientId ?? ""}. The secret is set.`
          : "No Plaid keys yet."}
      </p>
      <p className="mt-1.5 text-muted">
        Enter the client ID and the Production secret from Plaid's dashboard. The app tests them
        with Plaid at once, which spends no Item.
      </p>
      <Field label="Client ID" value={clientId} onChange={setClientId} required />
      <Field
        label="Production secret"
        type="password"
        value={secret}
        onChange={setSecret}
        required
      />
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Test and save the keys
        </Button>
      </div>
      <ErrorLine error={error} />
      <DoneLine done={done} />
    </form>
  );
}

export function ItemsUsedForm(props: { plaid: PlaidView; onSaved: (plaid: PlaidView) => void }) {
  const [itemsUsed, setItemsUsed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { plaid } = props;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.plaid["items-used"].$post({ json: { itemsUsed: Number(itemsUsed) } });
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { plaid: PlaidView }).plaid);
      setItemsUsed("");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h3 id="plaid-items" className="text-heading font-bold">
        Plaid Items
      </h3>
      <p className="mt-1.5 font-semibold tabular-nums">
        At least {plaid.itemsUsed} of {plaid.itemLimit} used
      </p>
      <p className="mt-1.5 text-muted">
        Plaid's free Trial plan allows {plaid.itemLimit} Items for the life of your Plaid team. Each
        bank linked or imported spends one, and removing a Connection does not give it back. If your
        Plaid team spent Items outside this app, raise the count here.
      </p>
      <label className={LABEL}>
        Items used, from {plaid.appItems} to {plaid.itemLimit}
        <input
          className={`${BOX} max-w-28 tabular-nums`}
          type="number"
          min={plaid.appItems}
          max={plaid.itemLimit}
          step={1}
          required
          value={itemsUsed}
          onChange={(e) => setItemsUsed(e.target.value)}
        />
      </label>
      <div className={BUTTONS}>
        <Button type="submit" variant="outlined" disabled={busy}>
          Save the count
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

// What Sync now did with one Connection. Times show in this browser's time zone.
export function syncNowLine(result: SyncNowView, now = new Date()): string {
  if (result.outcome === "syncing") {
    return result.refreshed
      ? `${result.bankName}: syncing now, and again in 5 minutes for the bank's fresh data.`
      : `${result.bankName}: syncing now.`;
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = new Date(result.canSyncAt);
  const day = calendarDateIn(at, zone);
  const today = calendarDateIn(now, zone);
  const time = timeLabel(at, zone);
  const when = day === today ? `at ${time}` : `on ${dateLabel(day, today)} at ${time}`;
  return `${result.bankName} synced a short while ago. It can sync again ${when}.`;
}

export function SyncNowResults(props: { results: SyncNowView[] }) {
  if (props.results.length === 0) return <p className="mt-3">No bank is ready to sync.</p>;
  return (
    <ul className="mt-3">
      {props.results.map((result) => (
        <li key={result.connectionId} className="border-t border-line-soft py-2 first:border-t-0">
          {syncNowLine(result)}
        </li>
      ))}
    </ul>
  );
}

// Any Member may press Sync now. It syncs every Healthy or Retrying Connection. It sits at the top
// right of the tab, outside a card, as the Settings → Banks board draws it.
export function SyncNow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [results, setResults] = useState<SyncNowView[] | undefined>();

  async function press() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api["sync-now"].$post();
      if (!res.ok) return setError(await refusal(res));
      setResults(((await res.json()) as { connections: SyncNowView[] }).connections);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sync-now">
      <h3 id="sync-now" className="sr-only">
        Sync now
      </h3>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p className="min-w-0 flex-[1_1_240px] text-small text-muted min-[600px]:text-right">
          Each bank syncs by itself every 6 hours. Sync now syncs every working bank at once.
        </p>
        <Button type="button" variant="outlined" disabled={busy} onClick={press}>
          Sync now
        </Button>
      </div>
      <ErrorLine error={error} />
      {results === undefined ? null : <SyncNowResults results={results} />}
    </section>
  );
}

// The ids of the two forms that open in place under their buttons.
const ADD_ACCOUNT = "add-unconnected-account";
const ADD_LOAN = "add-manual-loan";

// The Unconnected accounts and Manual loans in one card, as the Settings → Banks board draws them:
// a row for each, and a "+" button for each kind that opens its add form in place. The buttons are
// small, so both fit on one line on a phone. A list that has not loaded yet shows no row. A link
// that fills in a lender, as the Review list's untracked loan item does, goes to #manual-loans: it
// opens "Add a Manual loan" at once with the focus on Lender, and scrolls the form into view once
// the rows above it have loaded, so they do not push it out of view.
export function NotSyncedList(props: {
  accounts: UnconnectedAccountView[] | undefined;
  loans: ManualLoanView[] | undefined;
  today: string;
  lender?: string;
  onSaved: () => void;
}) {
  const { accounts, loans } = props;
  const [adding, setAdding] = useState({ account: false, loan: props.lender !== undefined });
  // Where the focus goes after the next render: a form's first field once it opens, or its button
  // once it closes.
  const focusNext = useRef<string | undefined>(props.lender === undefined ? undefined : ADD_LOAN);
  // Set until the form a link opened has scrolled into view.
  const linked = useRef(props.lender !== undefined);
  const loaded = accounts !== undefined && loans !== undefined;

  useEffect(() => {
    const id = focusNext.current;
    focusNext.current = undefined;
    if (id === undefined) return;
    const target = document.getElementById(id);
    (target?.querySelector<HTMLElement>("input, select, textarea") ?? target)?.focus();
  });

  useEffect(() => {
    if (!linked.current || !loaded) return;
    linked.current = false;
    document.getElementById(ADD_LOAN)?.scrollIntoView({ block: "start" });
  }, [loaded]);

  function toggle(kind: "account" | "loan") {
    const id = kind === "account" ? ADD_ACCOUNT : ADD_LOAN;
    focusNext.current = adding[kind] ? undefined : id;
    setAdding({ ...adding, [kind]: !adding[kind] });
  }

  function close(kind: "account" | "loan") {
    focusNext.current = `${kind === "account" ? ADD_ACCOUNT : ADD_LOAN}-button`;
    setAdding((now) => ({ ...now, [kind]: false }));
  }

  const added = (kind: "account" | "loan") => () => {
    close(kind);
    props.onSaved();
  };

  const none = accounts?.length === 0 && loans?.length === 0;
  return (
    <SettingCard
      id="not-synced"
      title="Places your banks send money that Plaid cannot see"
      status={
        <div className="flex flex-wrap gap-2">
          <Button
            id={`${ADD_ACCOUNT}-button`}
            type="button"
            variant="outlined"
            size="small"
            aria-expanded={adding.account}
            aria-controls={adding.account ? ADD_ACCOUNT : undefined}
            onClick={() => toggle("account")}
          >
            + Unconnected account
          </Button>
          <Button
            id={`${ADD_LOAN}-button`}
            type="button"
            variant="outlined"
            size="small"
            aria-expanded={adding.loan}
            aria-controls={adding.loan ? ADD_LOAN : undefined}
            onClick={() => toggle("loan")}
          >
            + Manual loan
          </Button>
        </div>
      }
    >
      <Lead>
        Such as an HSA, a 401(k), or a loan from family. They do not sync: the app follows them from
        your synced Transactions.
      </Lead>
      {none ? <p className="mt-3">No Unconnected accounts or Manual loans yet.</p> : null}
      <div className="mt-2.5 empty:hidden">
        {accounts === undefined ? null : (
          <UnconnectedAccountRows accounts={accounts} today={props.today} onSaved={props.onSaved} />
        )}
        {loans === undefined ? null : <ManualLoanRows loans={loans} onSaved={props.onSaved} />}
      </div>
      {adding.account ? (
        <AddUnconnectedAccount
          id={ADD_ACCOUNT}
          onSaved={added("account")}
          onCancel={() => close("account")}
        />
      ) : null}
      {/* The Manual loans part: the Review list's link names it. */}
      <div id="manual-loans">
        {adding.loan ? (
          <AddManualLoan
            id={ADD_LOAN}
            lender={props.lender}
            onSaved={added("loan")}
            onCancel={() => close("loan")}
          />
        ) : null}
      </div>
    </SettingCard>
  );
}

// Settings, Banks: Unconnected accounts (spec 02, Unconnected accounts) and Manual loans (spec 02,
// Manual loans). Any Member adds and edits either. A link may fill in a Manual loan's lender:
// /settings/banks?lender=...
export function NotSynced() {
  const [accounts, setAccounts] = useState<UnconnectedAccountView[] | undefined>();
  const [loans, setLoans] = useState<ManualLoanView[] | undefined>();
  const [accountsError, setAccountsError] = useState<string | undefined>();
  const [loansError, setLoansError] = useState<string | undefined>();
  const [lender] = useState(lenderInAddress);
  const today = calendarDateIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);

  const load = useCallback(() => {
    api["unconnected-accounts"]
      .$get()
      .then(async (res) => {
        if (!res.ok) return setAccountsError(await refusal(res));
        setAccounts(((await res.json()) as { accounts: UnconnectedAccountView[] }).accounts);
      })
      .catch(() => setAccountsError("The server did not answer."));
    api["manual-loans"]
      .$get()
      .then(async (res) => {
        if (!res.ok) return setLoansError(await refusal(res));
        setLoans(((await res.json()) as { loans: ManualLoanView[] }).loans);
      })
      .catch(() => setLoansError("The server did not answer."));
  }, []);

  useEffect(load, [load]);

  return (
    <>
      <ErrorLine error={accountsError} />
      <ErrorLine error={loansError} />
      <NotSyncedList
        accounts={accounts}
        loans={loans}
        today={today}
        lender={lender}
        onSaved={load}
      />
    </>
  );
}

// The Plaid keys, then the ways to add a bank or an Account: Import Plaid Connection and a new
// Connection, then the Unconnected accounts and Manual loans in one card, then the count of Plaid
// Items. Settings, Banks shows them. The first-run
// wizard's step 5 uses only the Plaid keys form and the link buttons (spec 12, The first-run
// wizard).
export function BankSources() {
  const [plaid, setPlaid] = useState<PlaidView | undefined>();
  const [error, setError] = useState<string | undefined>();

  const loadPlaid = useCallback(() => {
    api.plaid.settings
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError(await refusal(res));
        setPlaid(((await res.json()) as { plaid: PlaidView }).plaid);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  useEffect(loadPlaid, [loadPlaid]);

  return (
    <>
      <ErrorLine error={error} />
      {plaid === undefined ? null : (
        <>
          <Card aria-labelledby="plaid-keys">
            <PlaidKeysForm plaid={plaid} onSaved={setPlaid} />
          </Card>
          <Connections plaid={plaid} onChanged={loadPlaid} />
        </>
      )}
      <NotSynced />
      {plaid === undefined ? null : (
        <Card aria-labelledby="plaid-items">
          <ItemsUsedForm plaid={plaid} onSaved={setPlaid} />
        </Card>
      )}
    </>
  );
}

export function Banks() {
  return (
    <>
      <TabHeading>Banks</TabHeading>
      <SyncNow />
      <BankSources />
    </>
  );
}
