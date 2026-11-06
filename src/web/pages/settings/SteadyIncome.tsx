import { type FormEvent, useEffect, useState } from "react";
import { wholeDollars } from "../../../format.ts";
import type { SteadyIncomeView } from "../../../server/recurring-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { BOX, BUTTONS, LABEL, SettingCard } from "./settings-ui.tsx";
import { centsOf } from "./UnconnectedAccounts.tsx";

// Steady Income in Settings, Household (spec 05, Steady Income): the figure the app found, and an
// optional figure a Member types. A typed figure replaces the found one until a Member clears it.

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

export function SteadyIncomeForm(props: {
  income: SteadyIncomeView;
  onSaved: (income: SteadyIncomeView) => void;
}) {
  const { income } = props;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function save(amount: number | null) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api["steady-income"].$put({ json: { typed: amount } });
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { steadyIncome: SteadyIncomeView }).steadyIncome);
      setTyped("");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const amount = centsOf(typed);
    if (amount === undefined || amount < 0) {
      return setError("Enter Steady Income in dollars and cents per month.");
    }
    void save(amount);
  }

  return (
    <SettingCard id="steady-income" title="Steady Income">
      <p className="mt-1.5">Steady Income: {wholeDollars(income.amount)} a month.</p>
      <p className="mt-1.5 text-muted">
        {income.detectedFrom === "Income series"
          ? `The app found ${wholeDollars(income.detected)} a month from Income that repeats, such as paychecks. One-off Income, such as a tax refund, is left out.`
          : `No repeating Income counts yet, so the app uses the middle of the last 3 complete months of Income: ${wholeDollars(income.detected)}.`}{" "}
        It sets the Benchmarks and the Budget draft.
      </p>
      {income.typed === null ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p>
            A Member typed {wholeDollars(income.typed)}. It replaces the figure the app found until
            a Member clears it.
          </p>
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear the typed figure
          </Button>
        </div>
      )}
      <form onSubmit={submit}>
        <label className={LABEL}>
          A different figure, per month (optional)
          <input
            className={`${BOX} max-w-48 tabular-nums`}
            inputMode="decimal"
            required
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <div className={BUTTONS}>
          <Button type="submit" disabled={busy}>
            Save the figure
          </Button>
        </div>
      </form>
      <ErrorLine error={error} />
    </SettingCard>
  );
}

// Loads Steady Income for Settings, Household.
export function SteadyIncome() {
  const [income, setIncome] = useState<SteadyIncomeView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api["steady-income"]
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError(await refusal(res));
        setIncome(((await res.json()) as { steadyIncome: SteadyIncomeView }).steadyIncome);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <ErrorLine error={error} />
      {income === undefined ? null : <SteadyIncomeForm income={income} onSaved={setIncome} />}
    </>
  );
}
