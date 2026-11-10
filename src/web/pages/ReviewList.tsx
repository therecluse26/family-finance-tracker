import { type KeyboardEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";
import type { Category } from "../../categories/list.ts";
import { categoryChoiceValue, readCategoryChoice } from "../../categorization/category-choice.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  ReviewChoiceView,
  ReviewItemView,
  ReviewLineItemView,
  ReviewTransactionView,
} from "../../server/review-views.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import {
  acceptOf,
  answerItem,
  changeOneCategory,
  changeOneType,
  reviewListRequests,
} from "../review-list.ts";
import type { ShellContext } from "../Shell.tsx";
import { HAND_SET_TYPES } from "../transactions.ts";
import { browserZone } from "./Accounts.tsx";
import { AMAZON_SHIPMENT, AmazonShipmentItem } from "./AmazonShipmentItem.tsx";
import { CategoryOptions } from "./TransactionDetail.tsx";

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
  "Line item Category": "Amazon item Category",
  "Amazon shipment": "Amazon shipment",
};

// The Line item Category kind (spec 14, Review list items): one card per product.
const LINE_ITEM_KIND = "Line item Category";

// One Line item on its card: "Oct 10 · 2 × Paper towels · $13.50".
export function lineItemLine(item: ReviewLineItemView, today: string): string {
  return [
    dateLabel(item.orderDate, today),
    `${item.quantity === 1 ? "" : `${item.quantity} × `}${item.name}`,
    dollarsAndCents(item.total),
  ].join(" · ");
}

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

// The kinds whose items are cards, one per key, with what "Change" on a row sets: the Category
// kinds, one per Merchant (spec 04, Review list items), and the Money movement kinds, one per key
// (spec 03, Review list items). A money from a person row also opens its Transaction, where a
// Member links it as a Reimbursement.
export type RowChange = { sets: "category" } | { sets: "type"; opens: boolean };
const CARD_KINDS: ReadonlyMap<string, RowChange> = new Map<string, RowChange>([
  ["best guess made without AI", { sets: "category" }],
  ["Category the AI was unsure of", { sets: "category" }],
  ["one-sided Transfer", { sets: "type", opens: false }],
  ["money from a person", { sets: "type", opens: true }],
]);

export function rowChangeOf(kind: string): RowChange | undefined {
  return CARD_KINDS.get(kind);
}

// A card of several Transactions: "Marathon · 14 Transactions", or the card's own name, such as
// "Taylor Brooks · Zelle · 3 Transactions". Undefined for any other item,
// which shows each Transaction's line.
export function cardTitle(item: ReviewItemView): string | undefined {
  const [first] = item.transactions;
  if (!CARD_KINDS.has(item.kind) || first === undefined || item.transactions.length < 2) {
    return undefined;
  }
  return `${item.cardName ?? first.merchantName ?? first.description} · ${item.transactions.length} Transactions`;
}

// One row of a card: "Oct 9 · −$42.50 · Everyday Checking · Gas". A Money movement card's row
// has no Category.
export function cardRowLine(
  txn: ReviewTransactionView,
  today: string,
  withCategory = true,
): string {
  return [
    dateLabel(txn.authorizedDate ?? txn.postedDate, today),
    dollarsAndCents(txn.amount, { signed: true }),
    ...(txn.accountName === null ? [] : [txn.accountName]),
    ...(withCategory
      ? [txn.categories.length === 0 ? "No Category yet" : txn.categories.join(", ")]
      : []),
  ].join(" · ");
}

// What the item is about: its Transactions, or its loan.
function Subject(props: { item: ReviewItemView; today: string }) {
  const { item } = props;
  if (item.subject.type === "loan")
    return <p className="mt-1 font-semibold">{item.loanName ?? "A loan"}</p>;
  if (item.subject.type === "line items") {
    const [first] = item.lineItems;
    return (
      <>
        {first === undefined || item.lineItems.length < 2 ? null : (
          <p className="mt-1 font-semibold break-words">
            {first.name} · {item.lineItems.length} items
          </p>
        )}
        <ul className="mt-1">
          {item.lineItems.map((lineItem) => (
            <li
              key={lineItem.id}
              className={`break-words ${item.lineItems.length < 2 ? "font-semibold" : "text-sm"}`}
            >
              {keepAmountsWhole(lineItemLine(lineItem, props.today))}
            </li>
          ))}
        </ul>
      </>
    );
  }
  const title = cardTitle(item);
  if (title !== undefined) return <p className="mt-1 font-semibold">{title}</p>;
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
  // Sets one Transaction's Category alone, as "only this Transaction" does, or its type by hand,
  // by the card's kind. Resolves with the server's words when it did not work.
  changeOne(
    item: ReviewItemView,
    transactionId: string,
    value: string,
  ): Promise<string | undefined>;
};

// The folded list under a card: each Transaction, with "Change" to set its Category or its type
// alone. A changed row leaves the card. While the card's answer is saving, no row changes, and the
// other way round.
function CardRows(props: {
  item: ReviewItemView;
  today: string;
  actions: ItemActions;
  busy: boolean;
  change: RowChange;
}) {
  const { item, change } = props;
  const what = change.sets === "category" ? "Category" : "type";
  const [changing, setChanging] = useState<string | undefined>();
  const [category, setCategory] = useState("");
  const [saving, setBusy] = useState(false);
  const busy = saving || props.busy;
  const [error, setError] = useState<string | undefined>();
  const start = (id: string | undefined) => {
    setChanging(id);
    setCategory("");
    setError(undefined);
  };
  const save = async (id: string) => {
    if (category === "") return setError(`Pick a ${what}.`);
    setBusy(true);
    const refused = await props.actions.changeOne(item, id, category);
    setBusy(false);
    if (refused === undefined) start(undefined);
    else setError(refused);
  };
  return (
    <details className="basis-full border-t border-line-soft pt-2">
      <summary className="cursor-pointer py-1 text-small font-semibold">
        Show the {item.transactions.length} Transactions
      </summary>
      <ul className="mt-1">
        {item.transactions.map((txn) => {
          const line = cardRowLine(txn, props.today, change.sets === "category");
          const selectId = `change-${item.id}-${txn.id}`;
          return (
            <li
              key={txn.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-soft py-2 text-sm first:border-t-0"
            >
              <span className="min-w-0">{keepAmountsWhole(line)}</span>
              {changing === txn.id ? (
                <form
                  className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(txn.id);
                  }}
                >
                  <label htmlFor={selectId} className="sr-only">
                    {`${change.sets === "category" ? "Category" : "Type"} for ${line}, only this Transaction`}
                  </label>
                  <select
                    id={selectId}
                    className="block h-8 w-full rounded-control border border-field bg-white px-2 text-small text-ink sm:w-52"
                    value={category}
                    disabled={busy}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    {change.sets === "category" ? (
                      <CategoryOptions />
                    ) : (
                      <>
                        <option value="">Pick a type</option>
                        {HAND_SET_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <button type="submit" className={buttonClass("primary", "small")} disabled={busy}>
                    Save
                  </button>
                  <button
                    type="button"
                    className={buttonClass("outlined", "small")}
                    disabled={busy}
                    onClick={() => start(undefined)}
                  >
                    Cancel
                  </button>
                  {error === undefined ? null : (
                    <div className="basis-full">
                      <ErrorLine error={error} />
                    </div>
                  )}
                </form>
              ) : (
                <span className="flex gap-2">
                  {change.sets === "type" && change.opens ? (
                    <Link
                      className={buttonClass("outlined", "small")}
                      to={`/transactions/${encodeURIComponent(txn.id)}`}
                      aria-label={`Open ${line}`}
                    >
                      Open
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    className={buttonClass("outlined", "small")}
                    aria-label={`Change the ${what} of ${line}`}
                    disabled={busy}
                    onClick={() => start(txn.id)}
                  >
                    Change
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-small text-muted">
        {change.sets === "category"
          ? "Change sets only that Transaction, with no Category rule."
          : change.opens
            ? "Change sets only that Transaction's type. Open one to link it as a Reimbursement."
            : "Change sets only that Transaction's type, and nothing is remembered for it."}
      </p>
    </details>
  );
}

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

// The answer a picked Category sends. The box counts only when the server offered "only this
// Transaction" for the item.
export function pickedCategoryValue(
  category: Category,
  box: { offered: boolean; checked: boolean },
): string {
  return categoryChoiceValue(category, box.offered && box.checked);
}

// "Not this" on a Category item: a search box over the Categories, and "Only this Transaction".
// Picking a Category answers the item. Without "Only this Transaction", the answer also makes a
// Category rule for the Merchant (spec 04, Review list items).
function CategoryPicker(props: {
  itemId: string;
  categories: readonly Category[];
  onlyThisOffered: boolean;
  // A Line item card says "item" and Item rule in place of Transaction and Category rule.
  lineItems?: boolean;
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
    props.pick(pickedCategoryValue(name, { offered: props.onlyThisOffered, checked: onlyThis }));
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
            {props.lineItems === true ? "Only this item" : "Only this Transaction"}
          </label>
        ) : null}
      </div>
      {props.onlyThisOffered ? (
        <p id={helpId} className="mt-1 text-small text-muted">
          {props.lineItems === true
            ? "Without it, an Item rule gives this product's other items this Category too."
            : "Without it, a Category rule gives the Merchant's other Transactions this Category too."}
        </p>
      ) : null}
    </div>
  );
}

// The items' states with one item busy, or no longer busy, keeping its choices and error.
export function withBusy(
  states: Readonly<Record<string, ItemState>>,
  id: string,
  busy: boolean,
): Record<string, ItemState> {
  return { ...states, [id]: { ...states[id], busy } };
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
  const change = rowChangeOf(item.kind);
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
      {cardTitle(item) === undefined || change === undefined ? null : (
        <CardRows
          item={item}
          today={props.today}
          actions={actions}
          busy={state.busy === true}
          change={change}
        />
      )}
      {picker === undefined ? null : (
        <CategoryPicker
          key={item.id}
          itemId={item.id}
          categories={picker.categories}
          onlyThisOffered={picker.onlyThisOffered}
          lineItems={item.kind === LINE_ITEM_KIND}
          busy={state.busy === true}
          pick={(value) => actions.answer(item, value)}
        />
      )}
      {state.choices === undefined || picker !== undefined ? null : (
        <div className="basis-full border-t border-line-soft pt-3">
          <p className="mb-2 text-small font-semibold" id={choicesId}>
            Other choices
          </p>
          {state.choices.length === 0 ? (
            <p className="text-small text-muted">
              No other answer covers the whole card. Change a row to set it alone.
            </p>
          ) : null}
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

// The items as the page shows them: items that share a group, such as Transfer pair guesses
// between the same two Accounts, show together where the first of them is, and every other item
// alone. For display only: each item in a group keeps its own answer.
export function displayGroups(items: readonly ReviewItemView[]): ReviewItemView[][] {
  const groups: ReviewItemView[][] = [];
  const byKey = new Map<string, ReviewItemView[]>();
  for (const item of items) {
    if (item.group === null) {
      groups.push([item]);
      continue;
    }
    const group = byKey.get(item.group);
    if (group !== undefined) {
      group.push(item);
      continue;
    }
    const added = [item];
    byKey.set(item.group, added);
    groups.push(added);
  }
  return groups;
}

// How many things the page shows: a group counts once, as the main menu's count does.
export function shownCount(items: readonly ReviewItemView[]): number {
  return displayGroups(items).length;
}

// "Everyday Checking and Savings · 3 Transfer guesses", over a group of Transfer pair guesses.
export function groupTitle(group: readonly ReviewItemView[]): string {
  const names = [
    ...new Set(group[0]?.transactions.map((txn) => txn.accountName ?? "A removed Account")),
  ];
  return `${names.join(" and ")} · ${group.length} Transfer guesses`;
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
  const shown = (item: ReviewItemView) =>
    item.kind === AMAZON_SHIPMENT ? (
      <AmazonShipmentItem
        key={item.id}
        item={item}
        state={props.states[item.id] ?? {}}
        today={props.today}
        actions={props.actions}
      />
    ) : (
      <ReviewListItem
        key={item.id}
        item={item}
        state={props.states[item.id] ?? {}}
        today={props.today}
        actions={props.actions}
      />
    );
  return (
    <ul className="flex flex-col gap-3">
      {displayGroups(props.items).map((group) => {
        const [first] = group;
        if (first === undefined) return null;
        if (group.length === 1) return shown(first);
        const titleId = `group-${first.id}`;
        return (
          <li
            key={`group ${first.id}`}
            className="rounded-card border border-line bg-page px-3 py-3 min-[900px]:px-4"
          >
            <p className="text-xs font-semibold uppercase tracking-[.05em] text-muted">
              {KIND_LABEL[first.kind] ?? "Group"}
            </p>
            <p id={titleId} className="mt-1 font-semibold">
              {groupTitle(group)}
            </p>
            <ul className="mt-3 flex flex-col gap-3" aria-labelledby={titleId}>
              {group.map(shown)}
            </ul>
          </li>
        );
      })}
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
      shell?.setReviewListOpenCount(shownCount(open));
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
    async changeOne(item, transactionId, value) {
      // The card's own answer waits while a row saves, so the two never cross.
      setStates((all) => withBusy(all, item.id, true));
      const refused =
        rowChangeOf(item.kind)?.sets === "type"
          ? await changeOneType(transactionId, value)
          : await changeOneCategory(transactionId, value);
      setStates((all) => withBusy(all, item.id, false));
      if (refused !== undefined) return refused;
      // The row leaves the card at once; the list read again shows what the server holds.
      setItems((all) =>
        all?.flatMap((each) => {
          if (each.id !== item.id) return [each];
          const left = each.transactions.filter((txn) => txn.id !== transactionId);
          return left.length === 0 ? [] : [{ ...each, transactions: left }];
        }),
      );
      // Reading the list again sets the main menu's count.
      await load();
      return undefined;
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
          {shownCount(items) === 1 ? "1 thing" : `${shownCount(items)} things`} the app could not
          settle alone. Nothing here is urgent: each already counts as the app decided.
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
