import { type KeyboardEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";
import type { Category } from "../../categories/list.ts";
import { categoryChoiceValue, readCategoryChoice } from "../../categorization/category-choice.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  ReviewChoiceView,
  ReviewItemView,
  ReviewTransactionView,
} from "../../server/review-views.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
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

// A Category item's choices as one Category list, and whether "only this Transaction" is offered.
// Undefined when a choice is not a Category answer, so other kinds keep their round choices.
export function categoryPickerOf(
  choices: readonly ReviewChoiceView[],
): { categories: Category[]; onlyThisOffered: boolean } | undefined {
  const categories: Category[] = [];
  let onlyThisOffered = false;
  for (const choice of choices) {
    const answer = readCategoryChoice(choice.value);
    if (answer === undefined) return undefined;
    if (answer.onlyThisTransaction) onlyThisOffered = true;
    else if (!categories.includes(answer.category)) categories.push(answer.category);
  }
  return categories.length === 0 ? undefined : { categories, onlyThisOffered };
}

// The Categories whose names hold what a Member typed, in list order. Case does not count.
export function matchingCategories(categories: readonly Category[], typed: string): Category[] {
  const words = typed.trim().toLocaleLowerCase();
  return categories.filter((name) => name.toLocaleLowerCase().includes(words));
}

// "Not this" on a Category item: a search box over the Categories, and "Only this Transaction".
// Picking a Category answers the item. Without "Only this Transaction", the answer also makes a
// Category rule for the Merchant (spec 04, Review list items).
function CategoryPicker(props: {
  itemId: string;
  categories: readonly Category[];
  onlyThisOffered: boolean;
  busy: boolean;
  pick(value: string): void;
}) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [onlyThis, setOnlyThis] = useState(false);
  const shown = matchingCategories(props.categories, typed);
  const at = Math.min(active, shown.length - 1);
  const inputId = `category-${props.itemId}`;
  const listId = `categories-${props.itemId}`;
  const helpId = `only-this-${props.itemId}`;
  const optionId = (index: number) => `${listId}-${index}`;

  const pick = (name: Category) => {
    setOpen(false);
    props.pick(categoryChoiceValue(name, props.onlyThisOffered && onlyThis));
  };
  const move = (by: number) => {
    setOpen(true);
    setActive(Math.max(0, Math.min(shown.length - 1, at + by)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const name = shown[at];
      if (open && name !== undefined) pick(name);
      else setOpen(true);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="basis-full border-t border-line-soft pt-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="relative w-full sm:max-w-sm">
          <label htmlFor={inputId} className="text-small font-semibold">
            Another Category
          </label>
          <input
            id={inputId}
            type="text"
            role="combobox"
            className={FIELD}
            placeholder="Search Categories"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && at >= 0 ? optionId(at) : undefined}
            disabled={props.busy}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          <div
            id={listId}
            role="listbox"
            aria-label="Categories"
            hidden={!open}
            className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-control border border-field bg-white py-1 shadow-lg"
          >
            {shown.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted">No Category has that name.</p>
            ) : (
              shown.map((name, index) => (
                <div
                  key={name}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === at}
                  className={`cursor-pointer px-3 py-2 text-sm text-ink ${index === at ? "bg-page" : ""}`}
                  // A press would blur the box and close the list before the click lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") pick(name);
                  }}
                >
                  {name}
                </div>
              ))
            )}
          </div>
        </div>
        {props.onlyThisOffered ? (
          <label className="flex items-center gap-2 text-sm sm:mt-5">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              aria-describedby={helpId}
              disabled={props.busy}
              checked={onlyThis}
              onChange={(event) => setOnlyThis(event.target.checked)}
            />
            Only this Transaction
          </label>
        ) : null}
      </div>
      {props.onlyThisOffered ? (
        <p id={helpId} className="mt-1 text-small text-muted">
          Without it, a Category rule gives the Merchant's other Transactions this Category too.
        </p>
      ) : null}
    </div>
  );
}

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
  const picker = state.choices === undefined ? undefined : categoryPickerOf(state.choices);
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
      {picker === undefined ? null : (
        <CategoryPicker
          key={item.id}
          itemId={item.id}
          categories={picker.categories}
          onlyThisOffered={picker.onlyThisOffered}
          busy={state.busy === true}
          pick={(value) => actions.answer(item, value)}
        />
      )}
      {state.choices === undefined || picker !== undefined ? null : (
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
