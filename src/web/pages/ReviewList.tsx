import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  ReviewChoiceView,
  ReviewItemView,
  ReviewTransactionView,
} from "../../server/review-views.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { acceptOf, answerItem, reviewListRequests } from "../review-list.ts";
import type { ShellContext } from "../Shell.tsx";
import { browserZone } from "./Accounts.tsx";

// The Review list page (spec 07, Review list page): the app's uncertain decisions, newest first,
// each with a one-tap answer. Each item already has a result that counts, so nothing waits for it,
// and it sends no push and no email. After each answer the main menu's count is read again.

const BUTTON = "rounded border border-gray-300 px-3 py-1";
const ACCEPT = "rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50";

// "Oct 9 · Corner Bistro · −$42.50 · Everyday Checking". A Transaction's day is its purchase date
// when it has one.
export function transactionLine(txn: ReviewTransactionView, today: string): string {
  return [
    dateLabel(txn.authorizedDate ?? txn.postedDate, today),
    txn.merchantName ?? txn.description,
    dollarsAndCents(txn.amount),
    ...(txn.accountName === null ? [] : [txn.accountName]),
  ].join(" · ");
}

// What the item is about: its Transactions, or its loan.
function Subject(props: { item: ReviewItemView; today: string }) {
  const { item } = props;
  if (item.subject.type === "loan")
    return <p className="font-semibold">{item.loanName ?? "A loan"}</p>;
  return (
    <ul>
      {item.transactions.map((txn) => (
        <li key={txn.id} className="font-semibold">
          {transactionLine(txn, props.today)}
        </li>
      ))}
    </ul>
  );
}

export type ItemState = {
  // The choices behind "Not this", once a Member opened them.
  choices?: ReviewChoiceView[];
  error?: string;
  busy?: boolean;
};

export type ItemActions = {
  answer(item: ReviewItemView, value: string): void;
  notThis(item: ReviewItemView): void;
};

export function ReviewListItem(props: {
  item: ReviewItemView;
  state: ItemState;
  today: string;
  actions: ItemActions;
}) {
  const { item, state, actions } = props;
  const accept = acceptOf(item);
  return (
    <li className="mt-4 rounded border border-gray-200 p-3" data-kind={item.kind}>
      <Subject item={item} today={props.today} />
      <p className="mt-1 text-gray-700">{item.decided}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {accept.does === "open" ? (
          <Link className={ACCEPT} to={accept.path}>
            {accept.label}
          </Link>
        ) : (
          <button
            type="button"
            className={ACCEPT}
            disabled={state.busy === true}
            onClick={() => actions.answer(item, accept.value)}
          >
            {accept.label}
          </button>
        )}
        <button
          type="button"
          className={BUTTON}
          disabled={state.busy === true}
          aria-expanded={state.choices !== undefined}
          onClick={() => actions.notThis(item)}
        >
          Not this
        </button>
      </div>
      {state.choices === undefined ? null : (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Other choices">
          {state.choices.map((choice) => (
            <li key={choice.value}>
              <button
                type="button"
                className={BUTTON}
                disabled={state.busy === true}
                onClick={() => actions.answer(item, choice.value)}
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={state.error} />
    </li>
  );
}

export function ReviewItems(props: {
  items: readonly ReviewItemView[];
  states: Readonly<Record<string, ItemState>>;
  today: string;
  actions: ItemActions;
}) {
  if (props.items.length === 0) return <p className="mt-4">Nothing to check.</p>;
  return (
    <ul>
      {props.items.map((item) => (
        <ReviewListItem
          key={item.id}
          item={item}
          state={props.states[item.id] ?? {}}
          today={props.today}
          actions={props.actions}
        />
      ))}
    </ul>
  );
}

export function ReviewList() {
  const shell = useOutletContext<ShellContext | undefined>();
  const [items, setItems] = useState<ReviewItemView[] | undefined>();
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [error, setError] = useState<string | undefined>();
  const today = calendarDateIn(new Date(), browserZone());

  const setState = (id: string, state: ItemState) => setStates((all) => ({ ...all, [id]: state }));

  async function load() {
    try {
      const res = await reviewListRequests.open();
      if (!res.ok) return setError("That did not work.");
      const { items: open } = (await res.json()) as { items: ReviewItemView[] };
      setItems(open);
      setError(undefined);
      shell?.setReviewListOpenCount(open.length);
    } catch {
      setError("The server did not answer.");
    }
  }

  const actions: ItemActions = {
    async answer(item, value) {
      const before = states[item.id] ?? {};
      setState(item.id, { ...before, busy: true, error: undefined });
      const outcome = await answerItem(item.id, value);
      if (outcome.answered) {
        if (outcome.openCount !== undefined) shell?.setReviewListOpenCount(outcome.openCount);
        setItems((all) => all?.filter((each) => each.id !== item.id));
        // An answer may settle other items too, such as the other side of a pair.
        return load();
      }
      setState(item.id, { ...before, busy: false, error: outcome.error });
      if (!outcome.stillOpen) await load();
    },
    async notThis(item) {
      const before = states[item.id] ?? {};
      if (before.choices !== undefined) return setState(item.id, { ...before, choices: undefined });
      try {
        const res = await reviewListRequests.choices(item.id);
        if (res.ok) {
          const { choices } = (await res.json()) as { choices: ReviewChoiceView[] };
          return setState(item.id, { ...before, choices, error: undefined });
        }
        setState(item.id, { ...before, error: "This item is no longer on the Review list." });
        await load();
      } catch {
        setState(item.id, { ...before, error: "The server did not answer." });
      }
    },
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Review list</h1>
      <ErrorLine error={error} />
      {items === undefined ? null : (
        <ReviewItems items={items} states={states} today={today} actions={actions} />
      )}
    </main>
  );
}
