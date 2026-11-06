import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  ReviewChoiceView,
  ReviewItemView,
  ReviewTransactionView,
} from "../../server/review-views.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { acceptOf, answerItem, reviewListRequests } from "../review-list.ts";
import type { ShellContext } from "../Shell.tsx";
import { browserZone } from "./Accounts.tsx";

// The Review list page (spec 07, Review list page): the app's uncertain decisions, newest first,
// each with a one-tap answer. Each item already has a result that counts, so nothing waits for it,
// and it sends no push and no email. After each answer the main menu's count is read again.

const BUTTON = buttonClass("outlined");
const ACCEPT = buttonClass("primary");
// The boards' round choice behind "Not this".
const CHOICE =
  "inline-flex h-9 items-center rounded-full border border-field bg-white px-3 text-sm text-ink hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

// The small label over each item: what kind of thing the app could not settle, in the owner
// specs' words (spec 07, Review list page). A kind not named here shows no label.
export const KIND_LABEL: Readonly<Record<string, string>> = {
  "best guess made without AI": "Category guess",
  "Category the AI was unsure of": "Category guess",
  "unclear Transfer pair": "Transfer guess",
  "Transfer pair guess": "Transfer guess",
  "one-sided Transfer": "One-sided Transfer",
  "money from a person": "Money from a person",
  "untracked loan": "Untracked loan",
  "possible Manual loan payment": "Possible loan payment",
  "missed Manual loan payment": "Missed loan payment",
};

// "Oct 9 · Corner Bistro · −$42.50 · Everyday Checking". A Transaction's day is its purchase date
// when it has one. Money in shows "+", since the list shows both (spec 07, Number formats).
export function transactionLine(txn: ReviewTransactionView, today: string): string {
  return [
    dateLabel(txn.authorizedDate ?? txn.postedDate, today),
    txn.merchantName ?? txn.description,
    dollarsAndCents(txn.amount, { signed: true }),
    ...(txn.accountName === null ? [] : [txn.accountName]),
  ].join(" · ");
}

// What the item is about: its Transactions, or its loan.
function Subject(props: { item: ReviewItemView; today: string }) {
  const { item } = props;
  if (item.subject.type === "loan")
    return <p className="mt-1 font-semibold">{item.loanName ?? "A loan"}</p>;
  return (
    <ul className="mt-1">
      {item.transactions.map((txn) => (
        <li key={txn.id} className="font-semibold">
          {keepAmountsWhole(transactionLine(txn, props.today))}
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
  const label = KIND_LABEL[item.kind];
  const open = state.choices !== undefined;
  const choicesId = `choices-${item.id}`;
  return (
    <li
      className={`flex flex-wrap items-center gap-x-5 gap-y-3 rounded-card border bg-white px-4 py-4 min-[900px]:px-5 min-[900px]:py-[18px] ${open ? "border-accent/45" : "border-line"}`}
      data-kind={item.kind}
    >
      <div className="min-w-0 flex-[1_1_320px]">
        {label === undefined ? null : (
          <p className="text-xs font-semibold uppercase tracking-[.05em] text-muted">{label}</p>
        )}
        <Subject item={item} today={props.today} />
        <p className="mt-0.5 text-small text-muted">{item.decided}</p>
      </div>
      <div className="flex flex-wrap gap-2">
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
          aria-expanded={open}
          onClick={() => actions.notThis(item)}
        >
          Not this
        </button>
      </div>
      {state.choices === undefined ? null : (
        <div className="basis-full border-t border-line-soft pt-3">
          <p className="mb-2 text-small font-semibold" id={choicesId}>
            Other choices
          </p>
          <ul className="flex flex-wrap gap-2" aria-labelledby={choicesId}>
            {state.choices.map((choice) => (
              <li key={choice.value}>
                <button
                  type="button"
                  className={CHOICE}
                  disabled={state.busy === true}
                  onClick={() => actions.answer(item, choice.value)}
                >
                  {choice.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.error === undefined ? null : (
        <div className="-mt-3 basis-full">
          <ErrorLine error={state.error} />
        </div>
      )}
    </li>
  );
}

export function ReviewItems(props: {
  items: readonly ReviewItemView[];
  states: Readonly<Record<string, ItemState>>;
  today: string;
  actions: ItemActions;
}) {
  if (props.items.length === 0) {
    return (
      <Card>
        <p className="text-muted">Nothing to check.</p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
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
    <Page>
      <PageHeading title="Review list" />
      <ErrorLine error={error} />
      {items === undefined || items.length === 0 ? null : (
        <p className="-mt-1 text-muted">
          {items.length === 1 ? "1 thing" : `${items.length} things`} the app could not settle
          alone. Nothing here is urgent: each already counts as the app decided.
        </p>
      )}
      {items === undefined ? null : (
        <ReviewItems items={items} states={states} today={today} actions={actions} />
      )}
      {items === undefined || items.length === 0 ? null : (
        <p className="text-center text-small text-muted">
          Every answer counts as hand-set. Accepting a Category guess also makes a Category rule.
        </p>
      )}
    </Page>
  );
}
