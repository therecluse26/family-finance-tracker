import { useEffect, useState } from "react";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type { RecurringChargeView } from "../../server/recurring-views.ts";
import { api } from "../api.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { browserZone } from "./Accounts.tsx";

// The Recurring charges page (spec 07, Recurring charges page): each Recurring charge by next
// expected date. Tapping a row opens its price history. Inactive ones sit in a collapsed "Inactive"
// section, with those a Member marked ended. A Member may mark one ended; it never comes back by
// itself (spec 06, Inactive and ended).

const BUTTON = "rounded border border-gray-300 px-3 py-1";
const LINK = "text-left text-blue-700 underline";

const byNextDate = (a: RecurringChargeView, b: RecurringChargeView) =>
  a.nextExpectedDate.localeCompare(b.nextExpectedDate) ||
  a.merchantName.localeCompare(b.merchantName, "en-US", { sensitivity: "base" });

// The active Recurring charges, then the rest for the "Inactive" section; each by next date.
export function recurringSections(charges: readonly RecurringChargeView[]): {
  active: RecurringChargeView[];
  inactive: RecurringChargeView[];
} {
  return {
    active: charges.filter((charge) => charge.status === "active").sort(byNextDate),
    inactive: charges.filter((charge) => charge.status !== "active").sort(byNextDate),
  };
}

// "Streamly · −$15.49 · monthly · next Oct 3 · Subscriptions · on card". An ended one says "ended".
export function chargeLine(charge: RecurringChargeView, today: string): string {
  return [
    charge.merchantName,
    dollarsAndCents(-charge.latestAmount),
    charge.schedule,
    `next ${dateLabel(charge.nextExpectedDate, today)}`,
    ...(charge.category === null ? [] : [charge.category]),
    ...(charge.onCard ? ["on card"] : []),
    ...(charge.status === "ended" ? ["ended"] : []),
  ].join(" · ");
}

export type ChargeState = {
  // The price history is open.
  open?: boolean;
  // "Mark ended" was tapped, and waits for "Yes, it ended".
  confirming?: boolean;
  busy?: boolean;
  error?: string;
};

export type ChargeActions = {
  toggle(charge: RecurringChargeView): void;
  askEnd(charge: RecurringChargeView): void;
  end(charge: RecurringChargeView): void;
  keep(charge: RecurringChargeView): void;
};

export function RecurringChargeRow(props: {
  charge: RecurringChargeView;
  state: ChargeState;
  today: string;
  actions: ChargeActions;
}) {
  const { charge, state, actions } = props;
  return (
    <li className="mt-3" data-status={charge.status}>
      <button
        type="button"
        className={LINK}
        aria-expanded={state.open === true}
        onClick={() => actions.toggle(charge)}
      >
        {keepAmountsWhole(chargeLine(charge, props.today))}
      </button>
      {state.open === true ? (
        <ul className="ml-4 mt-1 text-gray-700" aria-label="Price history">
          {[...charge.priceHistory].reverse().map((entry) => (
            <li key={entry.date}>
              {dateLabel(entry.date, props.today)} · {dollarsAndCents(-entry.amount)}
            </li>
          ))}
        </ul>
      ) : null}
      {charge.status === "ended" ? null : (
        <div className="mt-1 flex flex-wrap gap-2">
          {state.confirming === true ? (
            <>
              <button
                type="button"
                className={BUTTON}
                disabled={state.busy === true}
                onClick={() => actions.end(charge)}
              >
                Yes, it ended
              </button>
              <button type="button" className={BUTTON} onClick={() => actions.keep(charge)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className={BUTTON} onClick={() => actions.askEnd(charge)}>
              Mark ended
            </button>
          )}
        </div>
      )}
      <ErrorLine error={state.error} />
    </li>
  );
}

export function RecurringChargeList(props: {
  charges: readonly RecurringChargeView[];
  states: Readonly<Record<string, ChargeState>>;
  today: string;
  actions: ChargeActions;
}) {
  const { active, inactive } = recurringSections(props.charges);
  const row = (charge: RecurringChargeView) => (
    <RecurringChargeRow
      key={charge.id}
      charge={charge}
      state={props.states[charge.id] ?? {}}
      today={props.today}
      actions={props.actions}
    />
  );
  return (
    <>
      {active.length === 0 ? <p className="mt-4">No active Recurring charges.</p> : null}
      <ul>{active.map(row)}</ul>
      {inactive.length === 0 ? null : (
        <details className="mt-6">
          <summary className="text-lg font-semibold">Inactive ({inactive.length})</summary>
          <ul>{inactive.map(row)}</ul>
        </details>
      )}
    </>
  );
}

export const recurringChargeRequests = {
  list: () => api["recurring-charges"].$get(),
  end: (id: string) => api["recurring-charges"][":id"].end.$post({ param: { id } }),
};

export function RecurringCharges() {
  const [charges, setCharges] = useState<RecurringChargeView[] | undefined>();
  const [states, setStates] = useState<Record<string, ChargeState>>({});
  const [error, setError] = useState<string | undefined>();
  const today = calendarDateIn(new Date(), browserZone());

  const update = (id: string, change: ChargeState) =>
    setStates((all) => ({ ...all, [id]: { ...all[id], ...change } }));

  async function load() {
    try {
      const res = await recurringChargeRequests.list();
      if (!res.ok) return setError("That did not work.");
      setCharges(((await res.json()) as { charges: RecurringChargeView[] }).charges);
      setError(undefined);
    } catch {
      setError("The server did not answer.");
    }
  }

  const actions: ChargeActions = {
    toggle: (charge) => update(charge.id, { open: states[charge.id]?.open !== true }),
    askEnd: (charge) => update(charge.id, { confirming: true, error: undefined }),
    keep: (charge) => update(charge.id, { confirming: false }),
    async end(charge) {
      update(charge.id, { busy: true, error: undefined });
      try {
        const res = await recurringChargeRequests.end(charge.id);
        if (!res.ok) {
          update(charge.id, { busy: false, error: "That did not work." });
          return load();
        }
        const { charge: ended } = (await res.json()) as { charge: RecurringChargeView };
        setCharges((all) => all?.map((each) => (each.id === ended.id ? ended : each)));
        update(charge.id, { busy: false, confirming: false });
      } catch {
        update(charge.id, { busy: false, error: "The server did not answer." });
      }
    },
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Recurring charges</h1>
      <ErrorLine error={error} />
      {charges === undefined ? null : (
        <RecurringChargeList charges={charges} states={states} today={today} actions={actions} />
      )}
    </main>
  );
}
