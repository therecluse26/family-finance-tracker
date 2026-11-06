import { type FormEvent, useEffect, useState } from "react";
import { UNCONNECTED_KINDS, type UnconnectedKind } from "../../../bank/unconnected-kinds.ts";
import { calendarDateIn, dateLabel, wholeDollars } from "../../../format.ts";
import type { UnconnectedAccountView } from "../../../server/bank-views.ts";
import { accountEdits } from "../../account-edits.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import {
  BUTTONS,
  DETAILS,
  INPUT,
  LABEL,
  Lead,
  SettingCard,
  SUBHEADING,
  SUMMARY,
} from "./settings-ui.tsx";

// Settings, Banks: Unconnected accounts (spec 02, Unconnected accounts). Any Member adds one and
// edits it, and may type its true balance at any time. Its balance is an estimate from the
// Transfers and Saving the app assigns to it.

const KIND_LABEL: Record<UnconnectedKind, string> = {
  savings: "Savings",
  HSA: "HSA",
  "investment or retirement": "Investment or retirement",
  other: "Other",
};

const KIND_HELP: Record<UnconnectedKind, string> = {
  savings: "A savings account at a bank the app does not connect to.",
  HSA: "A health savings account.",
  "investment or retirement": "A brokerage, 401(k), or IRA account.",
  other:
    "Any other account. A payment app, such as Venmo or PayPal, is never an Unconnected account.",
};

// "1,234.56" or "$1234" in whole cents, or undefined when it is not an amount of money.
export function centsOf(typed: string): number | undefined {
  const plain = typed
    .trim()
    .replace(/[$,\s]/g, "")
    .replace("−", "-");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(plain);
  if (match === null) return undefined;
  const [, minus, dollars = "0", cents = "0"] = match;
  const value = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return minus === "-" ? -value : value;
}

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// The balance as the app shows it: as typed with its date, or estimated.
export function BalanceLine(props: { account: UnconnectedAccountView; today: string }) {
  const { balance, state, typedOn } = props.account.estimate;
  const amount = wholeDollars(balance);
  if (state === "typed" && typedOn !== null) {
    return (
      <span>
        {amount}, as typed on {dateLabel(typedOn, props.today)}
      </span>
    );
  }
  return <span>{amount}, estimated</span>;
}

export function UnconnectedAccountForm(props: {
  account: UnconnectedAccountView | null;
  onSaved: (account: UnconnectedAccountView) => void;
}) {
  const { account } = props;
  const [name, setName] = useState(account?.name ?? "");
  const [kind, setKind] = useState<UnconnectedKind>(account?.kind ?? "savings");
  const [institutionName, setInstitutionName] = useState(account?.institutionName ?? "");
  const [mask, setMask] = useState(account?.mask ?? "");
  const [balance, setBalance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = balance.trim() === "" ? null : centsOf(balance);
    if (cents === undefined) return setError("Enter the balance in dollars and cents.");
    setBusy(true);
    setError(undefined);
    try {
      const json = { name, kind, institutionName, mask, balance: cents };
      const res = await accountEdits.saveUnconnectedAccount(account?.id ?? null, json);
      if (!res.ok) return setError(await refusal(res));
      const saved = ((await res.json()) as { account: UnconnectedAccountView }).account;
      setBalance("");
      if (account === null) {
        setName("");
        setInstitutionName("");
        setMask("");
      }
      props.onSaved(saved);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-3" onSubmit={submit}>
      <label className={LABEL}>
        Name
        <input
          className={INPUT}
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset className="mt-3.5">
        <legend className="text-sm font-semibold">Kind</legend>
        {UNCONNECTED_KINDS.map((each) => (
          <label key={each} className="mt-2 block">
            <input
              type="radio"
              name={`kind-${account?.id ?? "new"}`}
              value={each}
              checked={kind === each}
              onChange={() => setKind(each)}
            />{" "}
            {KIND_LABEL[each]}
            <span className="block pl-5 text-small text-muted">{KIND_HELP[each]}</span>
          </label>
        ))}
      </fieldset>
      <label className={LABEL}>
        {account === null ? "Current balance (optional)" : "True balance today (optional)"}
        <input
          className={INPUT}
          inputMode="decimal"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
        />
      </label>
      <label className={LABEL}>
        Institution name (optional)
        <input
          className={INPUT}
          maxLength={100}
          value={institutionName}
          onChange={(e) => setInstitutionName(e.target.value)}
        />
      </label>
      <label className={LABEL}>
        Last 4 digits (optional)
        <input
          className={INPUT}
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          value={mask}
          onChange={(e) => setMask(e.target.value)}
        />
      </label>
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          {account === null ? "Add the account" : "Save the account"}
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

export function UnconnectedAccountList(props: {
  accounts: UnconnectedAccountView[];
  today: string;
  onSaved: (account: UnconnectedAccountView) => void;
}) {
  return (
    <SettingCard id="unconnected-accounts" title="Unconnected accounts">
      <Lead>
        An account the app cannot connect to. Its balance is an estimate from the Transfers and
        Saving the app links to it, and leaves out interest and market growth. Type its true balance
        at any time. A loan is added as a Manual loan, not here.
      </Lead>
      {props.accounts.length === 0 ? <p className="mt-3">No Unconnected accounts yet.</p> : null}
      {props.accounts.map((account) => (
        <details key={account.id} className={DETAILS}>
          <summary className={SUMMARY}>
            {account.name}
            {account.mask === null ? "" : ` ··${account.mask}`}:{" "}
            <BalanceLine account={account} today={props.today} />
          </summary>
          <UnconnectedAccountForm account={account} onSaved={props.onSaved} />
        </details>
      ))}
      <h4 className={SUBHEADING}>Add an Unconnected account</h4>
      <UnconnectedAccountForm account={null} onSaved={props.onSaved} />
    </SettingCard>
  );
}

export function UnconnectedAccounts() {
  const [accounts, setAccounts] = useState<UnconnectedAccountView[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const today = calendarDateIn(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function load() {
    try {
      const res = await api["unconnected-accounts"].$get();
      if (!res.ok) return setError(await refusal(res));
      setAccounts(((await res.json()) as { accounts: UnconnectedAccountView[] }).accounts);
    } catch {
      setError("The server did not answer.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <ErrorLine error={error} />
      {accounts === undefined ? null : (
        <UnconnectedAccountList accounts={accounts} today={today} onSaved={() => void load()} />
      )}
    </>
  );
}
