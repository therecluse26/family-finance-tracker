import { type FormEvent, useState } from "react";
import { CATEGORY_GROUPS } from "../../categories/list.ts";
import { dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  RecurringChargeCandidatesView,
  RecurringChargeCandidateView,
  RecurringChargeEditsView,
  RecurringChargeView,
} from "../../server/recurring-views.ts";
import { api } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import { Pill } from "../components/Pill.tsx";
import { centsOf } from "./settings/UnconnectedAccounts.tsx";

// A Recurring charge's edits (spec 07, Recurring charges page; spec 06, Member edits): its name,
// Category and price band, a price change from a date, and the Transactions in it. The price
// history marks each price change, and each Transaction a Member added.

// One line of the price history, newest first: a Transaction in it, or a price change.
export type PriceLine =
  | {
      kind: "charge";
      date: string;
      transactionId: string;
      amount: number;
      addedByHand: boolean;
    }
  | { kind: "price change"; date: string; id: string; amount: number; byHand: boolean };

// The Transactions and the price changes, newest first. On one day, the price change comes after
// the Transaction it starts with, so it reads above it.
export function priceLines(charge: RecurringChargeView): PriceLine[] {
  const lines: PriceLine[] = [
    ...charge.priceHistory.map(
      (entry): PriceLine => ({
        kind: "charge",
        date: entry.date,
        transactionId: entry.transactionId,
        amount: entry.amount,
        addedByHand: entry.addedByHand,
      }),
    ),
    ...charge.priceChanges.map(
      (change): PriceLine => ({
        kind: "price change",
        date: change.fromDate,
        id: change.id,
        amount: change.amount,
        byHand: change.byHand,
      }),
    ),
  ];
  const order = (line: PriceLine) => (line.kind === "price change" ? 1 : 0);
  return lines.sort((a, b) => b.date.localeCompare(a.date) || order(b) - order(a));
}

export type EditDraft = { name: string; category: string; priceBand: string };

export const draftOf = (charge: RecurringChargeView): EditDraft => ({
  name: charge.name ?? "",
  category: charge.categoryByHand ? (charge.category ?? "") : "",
  priceBand: charge.priceBand === null ? "" : String(charge.priceBand),
});

// What the form changes, or a refusal. An empty field clears a Member's value.
export function editsOf(
  charge: RecurringChargeView,
  draft: EditDraft,
): RecurringChargeEditsView | string {
  const before = draftOf(charge);
  const edits: RecurringChargeEditsView = {};
  const name = draft.name.trim();
  if (name !== before.name) {
    if ([...name].length > 60) return "A name is at most 60 characters.";
    edits.name = name === "" ? null : name;
  }
  if (draft.category !== before.category) {
    edits.category = draft.category === "" ? null : draft.category;
  }
  const band = draft.priceBand.trim().replace(/%$/, "");
  if (band !== before.priceBand) {
    const value = Number(band);
    if (band !== "" && (!/^\d+(\.\d)?$/.test(band) || value > 100)) {
      return "A price band is from 0 to 100%, such as 7.5.";
    }
    edits.priceBand = band === "" ? null : value;
  }
  return edits;
}

// The routes read their JSON bodies themselves, so the client's types do not list `json`.
export const recurringChargeEditRequests = {
  edit: (id: string, json: RecurringChargeEditsView) => {
    const edit = { param: { id }, json };
    return api["recurring-charges"][":id"].$put(edit);
  },
  setPriceChange: (id: string, json: { fromDate: string; amount: number }) => {
    const change = { param: { id }, json };
    return api["recurring-charges"][":id"]["price-changes"].$post(change);
  },
  deletePriceChange: (id: string, changeId: string) =>
    api["recurring-charges"][":id"]["price-changes"][":changeId"].$delete({
      param: { id, changeId },
    }),
  add: (id: string, transactionId: string) => {
    const added = { param: { id }, json: { transactionId } };
    return api["recurring-charges"][":id"].transactions.$post(added);
  },
  remove: (id: string, transactionId: string) =>
    api["recurring-charges"][":id"].transactions[":transactionId"].$delete({
      param: { id, transactionId },
    }),
  // A page of the charges to add: at `amount` in whole cents spent, older than `before`.
  candidates: (id: string, filter: { amount?: number; before?: string } = {}) => {
    const query: Record<string, string> = {};
    if (filter.amount !== undefined) query.amount = String(filter.amount);
    if (filter.before !== undefined) query.before = filter.before;
    const page = { param: { id }, query };
    return api["recurring-charges"][":id"].candidates.$get(page);
  },
};

async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : "That did not work.";
  } catch {
    return "That did not work.";
  }
}

export function RecurringChargeEdit(props: {
  charge: RecurringChargeView;
  today: string;
  onChange(charge: RecurringChargeView): void;
}) {
  const { charge, today } = props;
  const [draft, setDraft] = useState<EditDraft>(() => draftOf(charge));
  const [price, setPrice] = useState({ amount: "", fromDate: "" });
  const [candidates, setCandidates] = useState<RecurringChargeCandidateView[] | undefined>();
  // The last charge of the newest page, and whether older ones follow.
  const [older, setOlder] = useState<{ before: string | undefined; more: boolean }>({
    before: undefined,
    more: false,
  });
  const [amountFilter, setAmountFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // One marked ended takes a name and a Category, and no other edit (spec 07).
  const editable = charge.status !== "ended";
  const lines = priceLines(charge);

  // Sends one edit, and shows the Recurring charge it answers with.
  async function send(request: () => Promise<Response>): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const res = await request();
      if (!res.ok) {
        setError(await refusal(res));
        return false;
      }
      const { charge: after } = (await res.json()) as { charge: RecurringChargeView };
      props.onChange(after);
      setDraft(draftOf(after));
      return true;
    } catch {
      setError("The server did not answer.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const edits = editsOf(charge, draft);
    if (typeof edits === "string") return setError(edits);
    if (Object.keys(edits).length === 0) return;
    await send(() => recurringChargeEditRequests.edit(charge.id, edits));
  }

  async function setPriceChange(event: FormEvent) {
    event.preventDefault();
    const amount = centsOf(price.amount);
    if (amount === undefined || amount <= 0 || price.fromDate === "") {
      return setError("Enter a new amount and the date it starts.");
    }
    const sent = await send(() =>
      recurringChargeEditRequests.setPriceChange(charge.id, { amount, fromDate: price.fromDate }),
    );
    if (sent) setPrice({ amount: "", fromDate: "" });
  }

  // The newest page, or with `before`, the next older one after the list.
  async function showCandidates(before?: string) {
    setError(undefined);
    const typed = amountFilter.trim();
    const amount = typed === "" ? undefined : centsOf(typed);
    if (typed !== "" && (amount === undefined || amount <= 0)) {
      return setError("Enter an amount such as 25.00.");
    }
    try {
      const res = await recurringChargeEditRequests.candidates(charge.id, {
        ...(amount === undefined ? {} : { amount }),
        ...(before === undefined ? {} : { before }),
      });
      if (!res.ok) return setError(await refusal(res));
      const page = (await res.json()) as RecurringChargeCandidatesView;
      setCandidates((shown) =>
        before === undefined ? page.candidates : [...(shown ?? []), ...page.candidates],
      );
      setOlder({ before: page.candidates.at(-1)?.transactionId ?? before, more: page.more });
    } catch {
      setError("The server did not answer.");
    }
  }

  function findAtAmount(event: FormEvent) {
    event.preventDefault();
    void showCandidates();
  }

  async function add(transactionId: string) {
    if (await send(() => recurringChargeEditRequests.add(charge.id, transactionId))) {
      setCandidates((all) => all?.filter((each) => each.transactionId !== transactionId));
    }
  }

  return (
    <div className="grid gap-4">
      <form className="grid gap-x-4 gap-y-2 sm:grid-cols-3" onSubmit={save}>
        <label className="block text-small">
          Name
          <input
            className={FIELD}
            value={draft.name}
            maxLength={120}
            placeholder={charge.merchantName}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="block text-small">
          Category
          <select
            className={FIELD}
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            <option value="">Each Transaction's own</option>
            {CATEGORY_GROUPS.map((group) => (
              <optgroup key={group.name} label={group.name}>
                {group.categories.map((category) => (
                  <option key={category.name} value={category.name}>
                    {category.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {editable ? (
          <label className="block text-small">
            Price band (%)
            <input
              className={FIELD}
              inputMode="decimal"
              value={draft.priceBand}
              placeholder={String(charge.defaultPriceBand)}
              onChange={(e) => setDraft({ ...draft, priceBand: e.target.value })}
            />
          </label>
        ) : null}
        <div className="sm:col-span-3">
          <Button type="submit" variant="outlined" size="small" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
      {editable ? (
        <form className="grid gap-x-4 gap-y-2 sm:grid-cols-3" onSubmit={setPriceChange}>
          <label className="block text-small">
            New amount
            <input
              className={FIELD}
              inputMode="decimal"
              value={price.amount}
              placeholder={dollarsAndCents(charge.latestAmount)}
              onChange={(e) => setPrice({ ...price, amount: e.target.value })}
            />
          </label>
          <label className="block text-small">
            From
            <input
              className={FIELD}
              type="date"
              value={price.fromDate}
              onChange={(e) => setPrice({ ...price, fromDate: e.target.value })}
            />
          </label>
          <div className="self-end">
            <Button type="submit" variant="outlined" size="small" disabled={busy}>
              Set price change
            </Button>
          </div>
        </form>
      ) : null}
      <div>
        <p className="mb-1.5 text-small font-semibold">Price history</p>
        <ul className="grid gap-1 text-small tabular-nums" aria-label="Price history">
          {lines.map((line) =>
            line.kind === "price change" ? (
              <li key={`change-${line.id}`} className="flex flex-wrap items-center gap-2">
                <Pill>price change</Pill>
                <span>
                  {dollarsAndCents(-line.amount)} from {dateLabel(line.date, today)}
                  {line.byHand ? " (set by a Member)" : ""}
                </span>
                {editable && line.byHand ? (
                  <Button
                    type="button"
                    variant="outlined"
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void send(() =>
                        recurringChargeEditRequests.deletePriceChange(charge.id, line.id),
                      )
                    }
                  >
                    Delete
                  </Button>
                ) : null}
              </li>
            ) : (
              <li key={line.transactionId} className="flex flex-wrap items-center gap-2">
                <span>
                  {dateLabel(line.date, today)} ·{" "}
                  <span className="whitespace-nowrap">{dollarsAndCents(-line.amount)}</span>
                </span>
                {line.addedByHand ? <Pill>added</Pill> : null}
                {editable && charge.priceHistory.length > 1 ? (
                  <Button
                    type="button"
                    variant="outlined"
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void send(() =>
                        recurringChargeEditRequests.remove(charge.id, line.transactionId),
                      )
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ),
          )}
        </ul>
      </div>
      {editable ? (
        candidates === undefined ? (
          <div>
            <Button
              type="button"
              variant="outlined"
              size="small"
              onClick={() => void showCandidates()}
            >
              Add a charge
            </Button>
          </div>
        ) : (
          <div>
            <p className="mb-1.5 text-small font-semibold">Add a charge</p>
            <form className="mb-2 flex flex-wrap items-end gap-2" onSubmit={findAtAmount}>
              <label className="block text-small">
                Amount
                <input
                  className={FIELD}
                  inputMode="decimal"
                  value={amountFilter}
                  placeholder="Any"
                  onChange={(e) => setAmountFilter(e.target.value)}
                />
              </label>
              <Button type="submit" variant="outlined" size="small" disabled={busy}>
                Find
              </Button>
            </form>
            {candidates.length === 0 ? (
              <p className="text-small text-muted">No other posted charges from this Merchant.</p>
            ) : (
              <ul className="grid gap-1 text-small tabular-nums" aria-label="Charges to add">
                {candidates.map((candidate) => (
                  <li key={candidate.transactionId} className="flex flex-wrap items-center gap-2">
                    <span>
                      {dateLabel(candidate.date, today)} ·{" "}
                      <span className="whitespace-nowrap">
                        {dollarsAndCents(-candidate.amount)}
                      </span>
                    </span>
                    {candidate.removedByHand ? <Pill>removed</Pill> : null}
                    <Button
                      type="button"
                      variant="outlined"
                      size="small"
                      disabled={busy}
                      onClick={() => void add(candidate.transactionId)}
                    >
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {older.more ? (
              <Button
                type="button"
                variant="outlined"
                size="small"
                className="mt-2"
                disabled={busy}
                onClick={() => void showCandidates(older.before)}
              >
                Show older
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}
