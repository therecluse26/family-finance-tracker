import { useEffect, useState } from "react";
import { calendarDateIn, percent, wholeDollars } from "../../format.ts";
import type { BudgetsView, MonthBudgetView } from "../../server/budgets-views.ts";
import type { HouseholdFactsView } from "../../server/household-views.ts";
import { api } from "../api.ts";
import {
  acceptAll,
  type BudgetRow,
  budgetRequests,
  budgetRows,
  type ChangeOutcome,
  editBudget,
  followTheBill,
  STATUS_SHOWN,
  typedBudget,
} from "../budgets.ts";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import { UndoableProposals } from "../components/Proposal.tsx";
import { Status } from "../components/Status.tsx";
import { browserZone } from "./Accounts.tsx";

// The Budgets page (spec 07, Budgets page): every Category by Category group, with this month's
// Spending, its Budget, and its status, and the yearly Budgets in their own section at the end. A
// Member edits any Budget here, switches a pinned Bills Budget back to "Follow the bill", and
// accepts the whole draft with "Accept all".

const BUTTON = "rounded border border-gray-300 px-3 py-1 disabled:opacity-50";
const ACCEPT = "rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50";

export const BEFORE_FIRST_DRAFT = "Budgets appear when your history has loaded.";

// A row's edit box and the answer to its last change.
export type RowState = { typed?: string; error?: string; busy?: boolean };

export type BudgetActions = {
  type(budget: MonthBudgetView, typed: string): void;
  save(budget: MonthBudgetView, typed: string): void;
  followTheBill(budget: MonthBudgetView): void;
  acceptAll(): void;
};

function BudgetEdit(props: { budget: MonthBudgetView; state: RowState; actions: BudgetActions }) {
  const { budget, state, actions } = props;
  const typed = state.typed ?? typedBudget(budget.amount);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-sm text-blue-700">Edit</summary>
      <form
        className="mt-1 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          actions.save(budget, typed);
        }}
      >
        <label className="block">
          {budget.period === "yearly" ? "Budget per year" : "Budget per month"}
          <input
            className={FIELD}
            inputMode="decimal"
            required
            value={typed}
            onChange={(e) => actions.type(budget, e.target.value)}
          />
        </label>
        <button
          type="button"
          className={BUTTON}
          disabled={state.busy === true}
          onClick={() => actions.save(budget, typed)}
        >
          Save
        </button>
      </form>
    </details>
  );
}

// "Follow the bill" is on while the Bills Budget follows the formula. A Member's edit pins it and
// turns it off; turning it on puts the Budget back on the formula from the next month.
function FollowTheBill(props: {
  budget: MonthBudgetView;
  state: RowState;
  actions: BudgetActions;
}) {
  const { budget, state, actions } = props;
  return (
    <label className="mt-1 inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        role="switch"
        aria-checked={budget.pinned !== true}
        checked={budget.pinned !== true}
        disabled={budget.pinned !== true || state.busy === true}
        onChange={() => actions.followTheBill(budget)}
      />
      Follow the bill
    </label>
  );
}

export function BudgetRowItem(props: { row: BudgetRow; state: RowState; actions: BudgetActions }) {
  const { row, state, actions } = props;
  const { budget } = row;
  return (
    <li className="mt-3" data-category={row.category}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-semibold">{row.category}</span>
        <span>
          {budget === undefined ? (
            <>
              {wholeDollars(row.spending)} <span className="text-gray-500">no Budget</span>
            </>
          ) : (
            <>
              {wholeDollars(row.spending)} of {wholeDollars(budget.amount)}{" "}
              <Status {...STATUS_SHOWN[budget.status]} />
            </>
          )}
        </span>
      </div>
      {budget?.context == null ? null : <p className="text-sm text-gray-600">{budget.context}</p>}
      {budget === undefined ? null : (
        <>
          {budget.pinned === null ? null : (
            <FollowTheBill budget={budget} state={state} actions={actions} />
          )}
          <BudgetEdit budget={budget} state={state} actions={actions} />
        </>
      )}
      <ErrorLine error={state.error} />
    </li>
  );
}

// A yearly Budget shows the year's Spending, the yearly Budget, and how much of the year has
// passed. It is never On pace (spec 05, Yearly Budgets).
export function YearlyBudgetItem(props: {
  budget: MonthBudgetView;
  state: RowState;
  actions: BudgetActions;
}) {
  const { budget, state, actions } = props;
  return (
    <li className="mt-3" data-category={budget.category}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-semibold">{budget.category}</span>
        <span>
          {wholeDollars(budget.spending)} of {wholeDollars(budget.amount)} this year{" "}
          <Status {...STATUS_SHOWN[budget.status]} />
        </span>
      </div>
      {budget.shareOfYear === null ? null : (
        <p className="text-sm text-gray-600">
          {percent(budget.shareOfYear)} of the year has passed
        </p>
      )}
      <BudgetEdit budget={budget} state={state} actions={actions} />
      <ErrorLine error={state.error} />
    </li>
  );
}

export function BudgetsReport(props: {
  view: BudgetsView;
  states: Readonly<Record<string, RowState>>;
  accept: RowState;
  actions: BudgetActions;
}) {
  const { view, states, actions } = props;
  if (!view.drafted) return <p className="mt-4">{BEFORE_FIRST_DRAFT}</p>;
  const { groups, yearly } = budgetRows(view);
  const stateOf = (category: string) => states[category] ?? {};
  return (
    <>
      {view.notice === null ? null : <p className="mt-2 text-sm text-gray-600">{view.notice}</p>}
      {view.fitNote === null ? null : <p className="mt-2">{view.fitNote}</p>}
      <div className="mt-4">
        {view.draftAccepted ? (
          <p className="text-gray-600">The draft is accepted.</p>
        ) : (
          <button
            type="button"
            className={ACCEPT}
            disabled={props.accept.busy === true}
            onClick={() => actions.acceptAll()}
          >
            Accept all
          </button>
        )}
        <ErrorLine error={props.accept.error} />
      </div>
      {groups.map((group) => (
        <section key={group.categoryGroup} className="mt-6">
          <h2 className="text-lg font-semibold">{group.categoryGroup}</h2>
          <ul>
            {group.rows.map((row) => (
              <BudgetRowItem
                key={row.category}
                row={row}
                state={stateOf(row.category)}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      ))}
      {yearly.length === 0 ? null : (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Yearly Budgets</h2>
          <ul>
            {yearly.map((budget) => (
              <YearlyBudgetItem
                key={budget.category}
                budget={budget}
                state={stateOf(budget.category)}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function Budgets() {
  const [view, setView] = useState<BudgetsView | undefined>();
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [accept, setAccept] = useState<RowState>({});
  const [error, setError] = useState<string | undefined>();
  // Counts the page's reads, so the accepted Proposals read again with it.
  const [reads, setReads] = useState(0);

  const setState = (category: string, change: RowState) =>
    setStates((all) => ({ ...all, [category]: { ...all[category], ...change } }));

  // This month is the Household's, as for the edits.
  async function load() {
    try {
      const household = await api.household.$get();
      const facts = household.ok
        ? ((await household.json()) as { facts: HouseholdFactsView | null }).facts
        : null;
      const month = calendarDateIn(new Date(), facts?.timeZone ?? browserZone()).slice(0, 7);
      const res = await budgetRequests.budgets(month);
      if (!res.ok) return setError("That did not work.");
      setView((await res.json()) as BudgetsView);
      setReads((count) => count + 1);
      setError(undefined);
    } catch {
      setError("The server did not answer.");
    }
  }

  // Each change reads the page again: an edit or "Follow the bill" changes the status too.
  async function change(category: string, send: () => Promise<ChangeOutcome>) {
    setState(category, { busy: true, error: undefined });
    const outcome = await send();
    if (outcome.changed) {
      setStates((all) => ({ ...all, [category]: {} }));
      return load();
    }
    setState(category, { busy: false, error: outcome.error });
  }

  const actions: BudgetActions = {
    type: (budget, typed) => setState(budget.category, { typed }),
    save: (budget, typed) => void change(budget.category, () => editBudget(budget.category, typed)),
    followTheBill: (budget) => void change(budget.category, () => followTheBill(budget.category)),
    async acceptAll() {
      setAccept({ busy: true });
      const outcome = await acceptAll();
      setAccept(outcome.changed ? {} : { error: outcome.error });
      if (outcome.changed) await load();
    },
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Budgets</h1>
      <ErrorLine error={error} />
      <UndoableProposals key={reads} kinds={["Budget change"]} onChanged={() => void load()} />
      {view === undefined ? null : (
        <BudgetsReport view={view} states={states} accept={accept} actions={actions} />
      )}
    </main>
  );
}
