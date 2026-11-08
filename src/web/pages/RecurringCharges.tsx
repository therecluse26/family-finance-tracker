import { useEffect, useState } from "react";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type { RecurringChargeView } from "../../server/recurring-views.ts";
import { api } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { Pill } from "../components/Pill.tsx";
import { browserZone } from "./Accounts.tsx";
import { RecurringChargeEdit } from "./RecurringChargeEdit.tsx";

// The Recurring charges page (spec 07, Recurring charges page): each Recurring charge by next
// expected date. Tapping a row opens its edits and its price history (spec 06, Member edits).
// Inactive ones sit in a collapsed "Inactive" section, with those a Member marked ended. A Member
// may mark one ended; it never comes back by itself (spec 06, Inactive and ended).

// The name a Member gave it, else the Merchant's.
export const chargeName = (charge: RecurringChargeView) => charge.name ?? charge.merchantName;

const byNextDate = (a: RecurringChargeView, b: RecurringChargeView) =>
  a.nextExpectedDate.localeCompare(b.nextExpectedDate) ||
  chargeName(a).localeCompare(chargeName(b), "en-US", { sensitivity: "base" });

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

// The line under the Merchant: "monthly · Subscriptions". The page shows its first letter upper
// case.
export function chargeFacts(charge: RecurringChargeView): string {
  return [charge.schedule, ...(charge.category === null ? [] : [charge.category])].join(" · ");
}

// The bars draw at most this many of the latest charges.
const SHOWN_CHARGES = 12;

// The price history as bars, oldest at the left, the latest in full color (spec 07, Charts). The
// list under it says each charge's date and amount, so the bars are hidden from screen readers.
function PriceBars(props: { history: RecurringChargeView["priceHistory"] }) {
  const shown = props.history.slice(-SHOWN_CHARGES);
  if (shown.length < 2) return null;
  const top = Math.max(...shown.map((entry) => entry.amount), 1);
  const height = 64;
  return (
    <svg
      className="block h-16 w-full max-w-[240px]"
      viewBox={`0 0 ${shown.length * 20} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {shown.map((entry, index) => {
        const tall = Math.max(2, Math.round((Math.max(entry.amount, 0) / top) * height));
        return (
          <rect
            key={entry.transactionId}
            className={index === shown.length - 1 ? "fill-accent" : "fill-accent/40"}
            x={index * 20}
            y={height - tall}
            width={16}
            height={tall}
          />
        );
      })}
    </svg>
  );
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
  // A Member's edit answered with the Recurring charge after it.
  changed(charge: RecurringChargeView): void;
};

// Each row: the next date, the name with its marks, the Merchant under a name a Member gave, its
// interval and Category, and the amount. The row is one button that opens the edits and the price
// history; "Mark ended" sits beside it.
export function RecurringChargeRow(props: {
  charge: RecurringChargeView;
  state: ChargeState;
  today: string;
  actions: ChargeActions;
}) {
  const { charge, state, actions } = props;
  const historyId = `price-history-${charge.id}`;
  return (
    <li
      className="border-t border-line-soft py-[13px] first:border-t-0"
      data-status={charge.status}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          className="group grid min-w-0 flex-[1_1_100%] grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-control text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-1 sm:grid-cols-[5.75rem_minmax(0,1fr)_110px]"
          aria-expanded={state.open === true}
          aria-controls={state.open === true ? historyId : undefined}
          onClick={() => actions.toggle(charge)}
        >
          <span className="text-muted tabular-nums">
            <span className="sr-only">next </span>
            {dateLabel(charge.nextExpectedDate, props.today)}
          </span>
          <span className="min-w-0">
            <span className="font-semibold text-ink group-hover:text-accent group-hover:underline">
              {chargeName(charge)}
            </span>
            {charge.onCard ? (
              <>
                {" "}
                <Pill>on card</Pill>
              </>
            ) : null}
            {charge.status === "ended" ? (
              <>
                {" "}
                <Pill>ended</Pill>
              </>
            ) : null}
            {charge.name === null ? null : (
              <span className="mt-0.5 block text-small text-muted">{charge.merchantName}</span>
            )}
            <span className="mt-0.5 block text-small text-muted first-letter:uppercase">
              {chargeFacts(charge)}
            </span>
          </span>
          <span className="whitespace-nowrap text-right font-semibold tabular-nums">
            {dollarsAndCents(-charge.latestAmount)}
          </span>
        </button>
        <div
          // On a phone the buttons wrap under the row, in line with the Merchant.
          className="flex flex-wrap gap-2 pl-[4.25rem] sm:min-w-[7.5rem] sm:justify-end sm:pl-0"
        >
          {charge.status === "ended" ? null : state.confirming === true ? (
            <>
              <Button
                type="button"
                variant="outlined"
                size="small"
                disabled={state.busy === true}
                onClick={() => actions.end(charge)}
              >
                Yes, it ended
              </Button>
              <Button
                type="button"
                variant="outlined"
                size="small"
                onClick={() => actions.keep(charge)}
              >
                Keep it
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outlined"
              size="small"
              onClick={() => actions.askEnd(charge)}
            >
              Mark ended
            </Button>
          )}
        </div>
      </div>
      {state.open === true ? (
        <div id={historyId} className="mt-3 grid gap-3 rounded-control bg-page p-3 sm:ml-[6.5rem]">
          <PriceBars history={charge.priceHistory} />
          <RecurringChargeEdit charge={charge} today={props.today} onChange={actions.changed} />
        </div>
      ) : null}
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
      {active.length === 0 ? (
        <Card>
          <p className="text-muted">No active Recurring charges.</p>
        </Card>
      ) : (
        <Card padding="list">
          <ul>{active.map(row)}</ul>
        </Card>
      )}
      {active.some((charge) => charge.onCard) ? (
        <p className="text-small text-muted">
          "On card" means the charge lands on a credit card. Checking pays it later with the card
          payment.
        </p>
      ) : null}
      {inactive.length === 0 ? null : (
        <Card padding="list">
          <details className="py-2">
            <summary className="cursor-pointer py-2 font-semibold">
              Inactive ({inactive.length})
            </summary>
            <ul>{inactive.map(row)}</ul>
          </details>
        </Card>
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
    changed: (changed) =>
      setCharges((all) => all?.map((each) => (each.id === changed.id ? changed : each))),
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
    <Page>
      <PageHeading title="Recurring charges">
        {charges === undefined ? null : (
          <span className="text-muted tabular-nums">
            {recurringSections(charges).active.length} active
          </span>
        )}
      </PageHeading>
      <ErrorLine error={error} />
      {charges === undefined ? null : (
        <RecurringChargeList charges={charges} states={states} today={today} actions={actions} />
      )}
    </Page>
  );
}
