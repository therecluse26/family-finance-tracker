import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  BRAND_LOCK_LENGTH,
  DIETARY_NEEDS_LENGTH,
  LIST_ITEM_NOTE_LENGTH,
  LIST_ITEM_UNIT_NAMES,
  LIST_ITEM_WORDS_LENGTH,
  type ListItemInput,
  type ListItemUnitName,
  type ListItemView,
  listItemLine,
  MAX_TRIP_SAVING_CENTS,
  SHOPPING_LIST_RULES,
  type ShoppingListView,
} from "../../deal-finder/shopping-list-view.ts";
import { dollarsAndCents } from "../../format.ts";
import { Button } from "../components/Button.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import {
  addListItem,
  answerOf,
  changeListItem,
  clearTickedItems,
  loadShoppingList,
  removeListItem,
  saveDietaryNeeds,
  saveTripSaving,
} from "../shopping-list.ts";
import { centsOfText } from "./settings/Ai.tsx";
import {
  ADD_PANEL,
  BOX,
  BUTTONS,
  DoneLine,
  Field,
  HINT,
  LABEL,
  Lead,
  ROW,
  SettingCard,
} from "./settings/settings-ui.tsx";

// The Shopping list page, in the main menu's "More" section (spec 15, Shopping list; Pages): the
// Household's one list, which every Member sees and can change, its dietary needs, and the trip
// setting. A ticked List item stays on the list, struck through, until a Member presses "Clear
// ticked items". The list holds at most 100 List items.

// The deal finder's parts this page holds a place for: "Find the best prices" (ticket X48) beside
// the heading, the plan run's panel under the heading at the page's width, and the last Shopping
// plan (ticket X49) under the list. The heading holds only its title and the button.
export type ShoppingListSlots = {
  findBestPrices?: ReactNode;
  planRun?: ReactNode;
  plan?: ReactNode;
};

// One request: the page sends it, shows its error or its done line, and takes the new list from
// its answer.
export type Act = (request: () => Promise<Response>, done?: string) => Promise<boolean>;

type ItemText = {
  words: string;
  quantity: string;
  unit: ListItemUnitName;
  brandLock: string;
  note: string;
};

const NEW_ITEM: ItemText = { words: "", quantity: "1", unit: "each", brandLock: "", note: "" };

const textOf = (item: ListItemView): ItemText => ({
  words: item.words,
  quantity: String(item.quantity),
  unit: item.unit,
  brandLock: item.brandLock ?? "",
  note: item.note ?? "",
});

// The fields as the routes take them, or the rule the quantity breaks. The server checks every
// rule again.
function inputOf(text: ItemText): ListItemInput | { error: string } {
  const quantity = Number(text.quantity.trim());
  if (text.quantity.trim() === "" || !Number.isFinite(quantity) || quantity <= 0) {
    return { error: SHOPPING_LIST_RULES.quantity };
  }
  return {
    words: text.words,
    quantity,
    unit: text.unit,
    brandLock: text.brandLock,
    note: text.note,
  };
}

// The words, quantity, unit, brand lock and note of a new or edited List item.
function ItemForm(props: {
  label: string;
  initial: ItemText;
  busy: boolean;
  onSave: (input: ListItemInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [error, setError] = useState<string | undefined>();
  const set = (field: keyof ItemText) => (value: string) => setText({ ...text, [field]: value });

  async function save(event: FormEvent) {
    event.preventDefault();
    const input = inputOf(text);
    if ("error" in input) return setError(input.error);
    setError(undefined);
    if ((await props.onSave(input)) && props.onCancel === undefined) setText(NEW_ITEM);
  }

  return (
    <form className={ADD_PANEL} onSubmit={save} aria-label={props.label}>
      <Field
        label="What to buy"
        value={text.words}
        onChange={set("words")}
        placeholder="ground beef"
        required
      />
      <div className="flex flex-wrap gap-x-3">
        <Field
          label="Quantity"
          value={text.quantity}
          onChange={set("quantity")}
          inputMode="decimal"
          className="max-w-28"
          required
        />
        <label className={LABEL}>
          Unit
          <select
            className={`${BOX} max-w-32`}
            value={text.unit}
            onChange={(event) => set("unit")(event.target.value)}
          >
            {LIST_ITEM_UNIT_NAMES.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Field
        label="Only this brand (optional)"
        value={text.brandLock}
        onChange={set("brandLock")}
        placeholder="Jif"
      />
      <Field label="Note (optional)" value={text.note} onChange={set("note")} />
      <p className={HINT}>
        Up to {LIST_ITEM_WORDS_LENGTH} characters for what to buy, {BRAND_LOCK_LENGTH} for the
        brand, and {LIST_ITEM_NOTE_LENGTH} for the note.
      </p>
      <ErrorLine error={error} />
      <div className={BUTTONS}>
        <Button type="submit" disabled={props.busy}>
          {props.onCancel === undefined ? "Add" : "Save"}
        </Button>
        {props.onCancel === undefined ? null : (
          <Button type="button" variant="outlined" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ListItemRow(props: { item: ListItemView; busy: boolean; act: Act }) {
  const { item } = props;
  const [editing, setEditing] = useState(false);
  const line = listItemLine(item);

  if (editing) {
    return (
      <li className="border-t border-line-soft py-1 first:border-t-0">
        <ItemForm
          label={`Edit ${item.words}`}
          initial={textOf(item)}
          busy={props.busy}
          onSave={async (input) => {
            const saved = await props.act(() => changeListItem(item.id, input), "Saved.");
            if (saved) setEditing(false);
            return saved;
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li className={ROW} data-slot="list-item">
      <label className="flex min-w-0 flex-1 items-center gap-2.5">
        <input
          type="checkbox"
          className="size-4 shrink-0"
          checked={item.ticked}
          disabled={props.busy}
          onChange={() => void props.act(() => changeListItem(item.id, { ticked: !item.ticked }))}
        />
        <span className={`wrap-anywhere ${item.ticked ? "text-muted line-through" : ""}`}>
          {line}
        </span>
      </label>
      <Button type="button" variant="outlined" size="small" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button
        type="button"
        variant="outlined"
        size="small"
        disabled={props.busy}
        aria-label={`Remove ${item.words}`}
        onClick={() => void props.act(() => removeListItem(item.id), "Removed.")}
      >
        Remove
      </Button>
    </li>
  );
}

function ListCard(props: { view: ShoppingListView; busy: boolean; act: Act }) {
  const { view } = props;
  const full = view.items.length >= view.maxItems;
  const ticked = view.items.filter((item) => item.ticked).length;
  return (
    <SettingCard
      id="list-items"
      title="List items"
      status={
        <span className="text-muted">
          {view.items.length} of {view.maxItems}
        </span>
      }
    >
      {view.items.length === 0 ? (
        <Lead>The list is empty. Add what you need below, or ask in Chat.</Lead>
      ) : (
        <ul className="mt-2" aria-label="List items">
          {view.items.map((item) => (
            <ListItemRow key={item.id} item={item} busy={props.busy} act={props.act} />
          ))}
        </ul>
      )}
      {ticked === 0 ? null : (
        <div className={BUTTONS}>
          <Button
            type="button"
            variant="outlined"
            disabled={props.busy}
            onClick={() => void props.act(clearTickedItems, "Ticked items cleared.")}
          >
            Clear ticked items
          </Button>
        </div>
      )}
      {full ? (
        <p className={HINT}>{SHOPPING_LIST_RULES.full} Remove one to add another.</p>
      ) : (
        <ItemForm
          label="Add a List item"
          initial={NEW_ITEM}
          busy={props.busy}
          onSave={(input) => props.act(() => addListItem(input), "Added.")}
        />
      )}
    </SettingCard>
  );
}

function DietaryNeedsCard(props: { view: ShoppingListView; busy: boolean; act: Act }) {
  const [needs, setNeeds] = useState(props.view.dietaryNeeds);
  return (
    <SettingCard id="dietary-needs" title="Dietary needs">
      <Lead>Every match checks them. Write them in plain words.</Lead>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.act(() => saveDietaryNeeds(needs), "Dietary needs saved.");
        }}
      >
        <Field
          label="Dietary needs"
          value={needs}
          onChange={setNeeds}
          placeholder="no peanuts, gluten-free"
        />
        <p className={HINT}>Up to {DIETARY_NEEDS_LENGTH} characters. Empty means none.</p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={props.busy}>
            Save
          </Button>
        </div>
      </form>
    </SettingCard>
  );
}

function TripSettingCard(props: { view: ShoppingListView; busy: boolean; act: Act }) {
  const [amount, setAmount] = useState((props.view.tripSaving / 100).toFixed(2));
  const [error, setError] = useState<string | undefined>();
  return (
    <SettingCard id="trip-setting" title="Trip setting">
      <Lead>
        An extra trip must save at least {dollarsAndCents(props.view.tripSaving)}. $0 means the
        lowest total. A large amount means the fewest trips.
      </Lead>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const cents = centsOfText(amount);
          if (cents === undefined || cents > MAX_TRIP_SAVING_CENTS) {
            return setError(SHOPPING_LIST_RULES.tripSaving);
          }
          setError(undefined);
          void props.act(() => saveTripSaving(cents), "Trip setting saved.");
        }}
      >
        <Field
          label="An extra trip must save at least ($)"
          value={amount}
          onChange={setAmount}
          inputMode="decimal"
          className="max-w-36"
          required
        />
        <ErrorLine error={error} />
        <div className={BUTTONS}>
          <Button type="submit" disabled={props.busy}>
            Save
          </Button>
        </div>
      </form>
    </SettingCard>
  );
}

export function ShoppingList(props: ShoppingListSlots = {}) {
  const [view, setView] = useState<ShoppingListView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const act: Act = async (request, doneWords) => {
    setError(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const answer = await answerOf(await request());
      if ("error" in answer) {
        setError(answer.error);
        return false;
      }
      setView(answer.view);
      setDone(doneWords);
      return true;
    } catch {
      setError("The server did not answer.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadShoppingList()
      .then(async (res) =>
        res.ok ? setView((await res.json()).shoppingList) : setError("The page did not load."),
      )
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <Page>
      <PageHeading title="Shopping list">
        {props.findBestPrices === undefined ? null : (
          <div data-slot="find-best-prices">{props.findBestPrices}</div>
        )}
      </PageHeading>
      {props.planRun === undefined ? null : <div data-slot="plan-run">{props.planRun}</div>}
      <ErrorLine error={error} />
      <DoneLine done={done} />
      {view === undefined ? null : (
        <ShoppingListCards view={view} busy={busy} act={act} plan={props.plan} />
      )}
    </Page>
  );
}

// The list, the plan's place, the dietary needs and the trip setting, once the list has loaded.
export function ShoppingListCards(props: {
  view: ShoppingListView;
  busy: boolean;
  act: Act;
  plan?: ReactNode;
}) {
  const { view, busy, act } = props;
  return (
    <>
      <ListCard view={view} busy={busy} act={act} />
      {props.plan === undefined ? null : <div data-slot="shopping-plan">{props.plan}</div>}
      <DietaryNeedsCard view={view} busy={busy} act={act} />
      <TripSettingCard view={view} busy={busy} act={act} />
    </>
  );
}
