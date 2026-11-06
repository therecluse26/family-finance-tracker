import { type FormEvent, useEffect, useState } from "react";
import { wholeDollars } from "../../../format.ts";
import {
  MANUAL_LOAN_KINDS,
  type ManualLoanKind,
  type ManualLoanView,
} from "../../../server/money-movement-views.ts";
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
import { centsOf } from "./UnconnectedAccounts.tsx";

// Settings, Banks: Manual loans (spec 02, Manual loans). Any Member adds a loan that no Bank-data
// provider syncs, and edits it at any time. The app works out each payment's interest from the
// balance and the APR. A link to the form may fill in the lender: /settings/banks?lender=...

// The loan types a Member picks from, and the two the form refuses with why.
const KIND_LABEL: Record<ManualLoanKind, string> = {
  personal: "Personal",
  car: "Car",
  student: "Student",
  mortgage: "Mortgage",
  "buy now pay later": "Buy now pay later",
};
const REFUSED_KINDS = ["credit card", "line of credit"] as const;
type FormKind = ManualLoanKind | (typeof REFUSED_KINDS)[number];
export const NOT_A_MANUAL_LOAN =
  "A credit card or a line of credit can't be a Manual loan: its balance moves with purchases the app cannot see.";

const LOAN_TYPE_LABEL = { "cash loan": "Cash loan", "purchase loan": "Purchase loan" } as const;

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export function ManualLoanForm(props: {
  loan: ManualLoanView | null;
  // The lender to fill in on a new loan, such as from a Review list item.
  lender?: string;
  onSaved: (loan: ManualLoanView) => void;
}) {
  const { loan } = props;
  const [lender, setLender] = useState(loan?.lender ?? props.lender ?? "");
  const [kind, setKind] = useState<FormKind>(loan?.kind ?? "personal");
  const [balance, setBalance] = useState(dollars(loan?.balance ?? null));
  const [balanceDate, setBalanceDate] = useState(loan?.balanceDate ?? "");
  const [apr, setApr] = useState(loan === null ? "" : String(loan.apr));
  const [regularPayment, setRegularPayment] = useState(dollars(loan?.regularPayment ?? null));
  const [escrow, setEscrow] = useState(dollars(loan?.escrow ?? null));
  const [loanType, setLoanType] = useState<"app" | "cash loan" | "purchase loan">(
    loan === null || loan.setBy === "app" ? "app" : loan.loanType,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const refused = kind === "credit card" || kind === "line of credit";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (refused) return setError(NOT_A_MANUAL_LOAN);
    const owed = centsOf(balance);
    if (owed === undefined || owed < 0) return setError("Enter the balance in dollars and cents.");
    const optional = (typed: string) => (typed.trim() === "" ? null : centsOf(typed));
    const payment = optional(regularPayment);
    const perPayment = kind === "mortgage" ? optional(escrow) : null;
    if (payment === undefined || perPayment === undefined) {
      return setError("Enter amounts in dollars and cents.");
    }
    setBusy(true);
    setError(undefined);
    try {
      const json = {
        lender,
        kind,
        balance: owed,
        balanceDate,
        apr: Number(apr),
        regularPayment: payment,
        escrow: perPayment,
        loanType: loanType === "app" ? null : loanType,
      };
      const res = await accountEdits.saveManualLoan(loan?.id ?? null, json);
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { loan: ManualLoanView }).loan);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  const name = loan?.id ?? "new";
  return (
    <form className="mt-3" onSubmit={submit}>
      <label className={LABEL}>
        Lender
        <input
          className={INPUT}
          required
          maxLength={100}
          value={lender}
          onChange={(e) => setLender(e.target.value)}
        />
      </label>
      <fieldset className="mt-3.5">
        <legend className="text-sm font-semibold">Loan type</legend>
        {MANUAL_LOAN_KINDS.map((each) => (
          <label key={each} className="mt-2 block">
            <input
              type="radio"
              name={`loan-kind-${name}`}
              value={each}
              checked={kind === each}
              onChange={() => setKind(each)}
            />{" "}
            {KIND_LABEL[each]}
          </label>
        ))}
        {loan === null
          ? REFUSED_KINDS.map((each) => (
              <label key={each} className="mt-2 block">
                <input
                  type="radio"
                  name={`loan-kind-${name}`}
                  value={each}
                  checked={kind === each}
                  onChange={() => setKind(each)}
                />{" "}
                {each === "credit card" ? "Credit card" : "Line of credit"}
              </label>
            ))
          : null}
      </fieldset>
      {refused ? <p className="mt-2 text-critical">{NOT_A_MANUAL_LOAN}</p> : null}
      <label className={LABEL}>
        Current balance
        <input
          className={INPUT}
          required
          inputMode="decimal"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
        />
      </label>
      <label className={LABEL}>
        Balance date
        <input
          className={INPUT}
          required
          type="date"
          value={balanceDate}
          onChange={(e) => setBalanceDate(e.target.value)}
        />
      </label>
      <label className={LABEL}>
        Interest rate (APR, %)
        <input
          className={INPUT}
          required
          inputMode="decimal"
          value={apr}
          onChange={(e) => setApr(e.target.value)}
        />
      </label>
      <label className={LABEL}>
        Regular payment amount (optional)
        <input
          className={INPUT}
          inputMode="decimal"
          value={regularPayment}
          onChange={(e) => setRegularPayment(e.target.value)}
        />
      </label>
      {kind === "mortgage" ? (
        <label className={LABEL}>
          Escrow per payment (optional)
          <input
            className={INPUT}
            inputMode="decimal"
            value={escrow}
            onChange={(e) => setEscrow(e.target.value)}
          />
        </label>
      ) : null}
      <label className={LABEL}>
        Counts as
        <select
          className={INPUT}
          value={loanType}
          onChange={(e) => setLoanType(e.target.value as typeof loanType)}
        >
          <option value="app">Let the app decide</option>
          <option value="cash loan">Cash loan: the money landed in one of our accounts</option>
          <option value="purchase loan">Purchase loan: the lender paid the seller</option>
        </select>
      </label>
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy || refused}>
          {loan === null ? "Add the loan" : "Save the loan"}
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

export function ManualLoanList(props: {
  loans: ManualLoanView[];
  lender?: string;
  onSaved: (loan: ManualLoanView) => void;
}) {
  return (
    <SettingCard id="manual-loans" title="Manual loans">
      <Lead>
        A personal, car, student, or buy now pay later loan, or a mortgage, that no bank connection
        syncs. The app works out each payment's interest from the balance and the APR. Credit cards
        and lines of credit can't be added: their balances move with purchases the app cannot see.
      </Lead>
      {props.loans.length === 0 ? <p className="mt-3">No Manual loans yet.</p> : null}
      {props.loans.map((loan) => (
        <details key={loan.id} className={DETAILS}>
          <summary className={SUMMARY}>
            {loan.lender}, {KIND_LABEL[loan.kind]}: {wholeDollars(loan.balance)} owed,{" "}
            {LOAN_TYPE_LABEL[loan.loanType]}
          </summary>
          <ManualLoanForm loan={loan} onSaved={props.onSaved} />
        </details>
      ))}
      <h4 className={SUBHEADING}>Add a Manual loan</h4>
      <ManualLoanForm loan={null} lender={props.lender} onSaved={props.onSaved} />
    </SettingCard>
  );
}

// The lender a link fills in, from ?lender= in the address.
function lenderInAddress(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("lender") ?? undefined;
}

export function ManualLoans() {
  const [loans, setLoans] = useState<ManualLoanView[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [lender] = useState(lenderInAddress);

  async function load() {
    try {
      const res = await api["manual-loans"].$get();
      if (!res.ok) return setError(await refusal(res));
      setLoans(((await res.json()) as { loans: ManualLoanView[] }).loans);
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
      {loans === undefined ? null : (
        <ManualLoanList loans={loans} lender={lender} onSaved={() => void load()} />
      )}
    </>
  );
}
