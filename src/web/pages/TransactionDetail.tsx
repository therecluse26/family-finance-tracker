import { useEffect, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import { CATEGORY_GROUPS } from "../../categories/list.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../format.ts";
import type { AccountView } from "../../server/bank-views.ts";
import type { CategoryRuleView } from "../../server/category-views.ts";
import type {
  OtherLinkView,
  ShownPartView,
  TransactionDetailView,
  TransactionRowView,
  TransferLinkView,
} from "../../server/money-movement-views.ts";
import { api } from "../api.ts";
import { FIELD } from "../components/Fields.tsx";
import { readOpenCount } from "../review-list.ts";
import type { ShellContext } from "../Shell.tsx";
import {
  type CandidateSearch,
  candidateFilters,
  chosenByLabel,
  HAND_SET_TYPES,
  type HandSetType,
  isSplit,
  partLabel,
  partsToShow,
  type TransactionFilters,
  transactionPath,
  transactionRequests,
  transactionsPath,
} from "../transactions.ts";
import { daysBefore } from "./Account.tsx";
import { browserZone } from "./Accounts.tsx";
import { centsOf } from "./settings/UnconnectedAccounts.tsx";
import { accountLabels, merchantOf, readPage, rowLine } from "./Transactions.tsx";

// One Transaction's detail view (spec 07, Transactions page): its parts, how each Category was
// chosen (spec 04, Provenance), and the evidence for each link with Undo (spec 03, Evidence). Every
// optional correction is here: the Category, with "only this Transaction"; a split by amount; Undo;
// a hand link as a Refund or Reimbursement; and a hand-set type.

const LINK = "text-blue-700 underline";
const BUTTON = "mt-2 mr-2 rounded border border-gray-300 px-3 py-1";
const SAVE = "mt-2 mr-2 rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50";

// A Refund or Reimbursement links to Spending from up to 120 days before it (spec 03, Refunds).
const LINK_WINDOW_DAYS = 120;

// The edits a Member is making, before pressing a button. Split amounts are typed in dollars.
export type DetailForm = {
  category: string;
  onlyThisTransaction: boolean;
  type: HandSetType;
  split: { amount: string; category: string }[];
  linkKind: "Refund" | "Reimbursement";
  spendingTransactionId: string;
  // How the Member narrows the Spending to link to.
  candidates: CandidateSearch;
};

export type DetailActions = {
  setForm(form: DetailForm): void;
  saveCategory(): void;
  saveType(): void;
  saveSplit(): void;
  removeSplit(): void;
  undoLink(linkId: string): void;
  linkByHand(): void;
  // Read the first page of the Spending the search finds, or the next page of it.
  findCandidates(): void;
  showMoreCandidates(): void;
};

// The Spending a Member may link money in to, as far as the Member has paged: the filters it was
// read with, its rows, and the ID to read the next page after, or null on the last page.
export type CandidatePage = {
  filters: TransactionFilters;
  rows: TransactionRowView[];
  next: string | null;
};

// What the last edit did: a notice on success, or why it did not work.
export type EditOutcome = { notice?: string; error?: string };

const dollarsOf = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

// The form as the Transaction stands: its Category and type, its split or a split to start from,
// and no hand link yet. The Spending search starts at the 120 days before the money posted.
export function formOf(detail: TransactionDetailView): DetailForm {
  const parts = partsToShow(detail.decision?.parts ?? []);
  const spending = parts.filter((part) => part.type === "Spending" && part.amount !== 0);
  const first = parts[0];
  const type = HAND_SET_TYPES.find((each) => each === first?.type) ?? "Spending";
  const split =
    spending.length > 1
      ? spending.map((part) => ({ amount: dollarsOf(part.amount), category: part.category ?? "" }))
      : [
          { amount: dollarsOf(detail.transaction.amount), category: first?.category ?? "" },
          { amount: "", category: "" },
        ];
  return {
    category: parts.find((part) => part.category !== null)?.category ?? "",
    onlyThisTransaction: false,
    type,
    split,
    linkKind: "Refund",
    spendingTransactionId: "",
    candidates: {
      merchant: "",
      from: daysBefore(detail.transaction.postedDate, LINK_WINDOW_DAYS),
      to: detail.transaction.postedDate,
    },
  };
}

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// The words after a Category change: the Category rule it made, or that it changed one Transaction.
function categoryNotice(answer: { category: string; rule: CategoryRuleView | null }): string {
  if (answer.rule === null) return `Only this Transaction is now ${answer.category}.`;
  return `A Category rule now gives ${answer.rule.merchantName}'s Transactions ${answer.rule.category}, except those set by hand.`;
}

// Each button's request. `done` gets what the edit did; the page then reads the Transaction again.
export function detailActions(
  detail: TransactionDetailView,
  form: DetailForm,
  setForm: (form: DetailForm) => void,
  done: (outcome: EditOutcome) => void,
  candidates: { page: CandidatePage; setPage(page: CandidatePage): void } = {
    page: { filters: {}, rows: [], next: null },
    setPage: () => {},
  },
): DetailActions {
  const id = detail.transaction.id;
  async function send(run: () => Promise<Response>, notice: (res: Response) => Promise<string>) {
    try {
      const res = await run();
      if (!res.ok) return done({ error: await refusal(res) });
      done({ notice: await notice(res) });
    } catch {
      done({ error: "The server did not answer." });
    }
  }
  const said = (words: string) => async () => words;
  return {
    setForm,
    saveCategory() {
      if (form.category === "") return done({ error: "Pick a Category." });
      void send(
        () => transactionRequests.setCategory(id, form.category, form.onlyThisTransaction),
        async (res) => categoryNotice(await res.json()),
      );
    },
    saveType() {
      void send(() => transactionRequests.setType(id, form.type), said(`It is now ${form.type}.`));
    },
    saveSplit() {
      const parts = form.split.map((part) => ({
        amount: centsOf(part.amount) ?? 0,
        category: part.category,
      }));
      if (parts.some((part) => part.amount <= 0 || part.category === "")) {
        return done({ error: "Give each part an amount in dollars and cents, and a Category." });
      }
      void send(() => transactionRequests.split(id, { parts }), said("Split."));
    },
    removeSplit() {
      void send(() => transactionRequests.removeSplit(id), said("The split is removed."));
    },
    undoLink(linkId) {
      void send(
        () => transactionRequests.undoLink(linkId),
        said("Undone. The app will not make that link again."),
      );
    },
    linkByHand() {
      if (form.spendingTransactionId === "") {
        return done({ error: "Pick the Spending it pays back." });
      }
      void send(
        () =>
          transactionRequests.link({
            kind: form.linkKind,
            transactionId: id,
            spendingTransactionId: form.spendingTransactionId,
          }),
        said(`Linked as a ${form.linkKind}.`),
      );
    },
    // A new search starts again at its first page, with no Spending picked.
    async findCandidates() {
      const filters = candidateFilters(form.candidates, detail.transaction.postedDate);
      const read = await readPage(filters);
      if (typeof read === "string") return done({ error: read });
      setForm({ ...form, spendingTransactionId: "" });
      candidates.setPage({ filters, rows: read.transactions, next: read.next });
    },
    // The next page keeps the filters its first page was read with.
    async showMoreCandidates() {
      const { page } = candidates;
      if (page.next === null) return;
      const read = await readPage(page.filters, page.next);
      if (typeof read === "string") return done({ error: read });
      candidates.setPage({ ...page, rows: [...page.rows, ...read.transactions], next: read.next });
    },
  };
}

const MADE_BY = { app: "the app", AI: "the AI", Member: "a Member" } as const;

// The evidence a link stores (spec 03, Evidence): its tier, each strong signal that matched, the
// AI's answer when the app asked it, and who made it.
function Evidence(props: { link: TransferLinkView | OtherLinkView }) {
  const { link } = props;
  return (
    <ul className="mt-1 text-sm text-gray-700">
      <li>Tier: {link.tier}</li>
      <li>
        {link.signals.length === 0
          ? "No strong signal matched."
          : `Signals that matched: ${link.signals.join(", ")}.`}
      </li>
      <li>
        {link.aiAnswer === null
          ? "The AI was not asked."
          : `The AI said ${link.aiAnswer}, with ${link.aiConfidence ?? "no"} confidence.`}
      </li>
      <li>Made by {MADE_BY[link.madeBy]}.</li>
      {"uncertain" in link && link.uncertain ? (
        <li>The app picked it from two equally good sets of pairs.</li>
      ) : null}
    </ul>
  );
}

// One link: what it is, the Transaction it matched, its evidence, and Undo.
function LinkEvidence(props: {
  title: string;
  matched: TransactionRowView | undefined;
  link: TransferLinkView | OtherLinkView;
  accounts: ReadonlyMap<string, string>;
  today: string;
  actions: DetailActions;
}) {
  const { matched } = props;
  return (
    <li className="mt-3 rounded border border-gray-200 p-3" data-link={props.link.id}>
      <p className="font-semibold">{props.title}</p>
      {matched === undefined ? null : (
        <p>
          <Link className={LINK} to={transactionPath(matched.id)}>
            {rowLine(matched, props.accounts, props.today)}
          </Link>
        </p>
      )}
      <Evidence link={props.link} />
      <button
        type="button"
        className={BUTTON}
        onClick={() => props.actions.undoLink(props.link.id)}
      >
        Undo
      </button>
    </li>
  );
}

// This Transaction is a Refund or Reimbursement's money in, or the Spending it reduces.
function linkTitle(link: OtherLinkView, moneyIn: boolean, accounts: ReadonlyMap<string, string>) {
  if (link.kind === "loan") {
    const loan = link.loanAccountId === null ? undefined : accounts.get(link.loanAccountId);
    return `Linked to the loan ${loan ?? ""}`.trim();
  }
  return moneyIn ? `${link.kind} for:` : `Reduced by this ${link.kind}:`;
}

function CategoryOptions() {
  return (
    <>
      <option value="">Pick a Category</option>
      {CATEGORY_GROUPS.map((group) => (
        <optgroup key={group.name} label={group.name}>
          {group.categories.map((category) => (
            <option key={category.name} value={category.name}>
              {category.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

// A part's line: its words, its amount, and how its Category was chosen. A split part the bank
// shrank to $0 says so.
function PartLine(props: { part: ShownPartView }) {
  const { part } = props;
  const chosenBy = chosenByLabel(part);
  return (
    <li className="mt-1">
      {partLabel(part)} · {dollarsAndCents(part.amount)}
      {chosenBy === undefined ? null : (
        <span className="text-gray-600"> · Category chosen by: {chosenBy}</span>
      )}
      {part.amount === 0 && !part.linked ? (
        <span className="text-gray-600">
          {" "}
          · The bank lowered the amount, so this part has nothing left.
        </span>
      ) : null}
    </li>
  );
}

export function TransactionDetailBody(props: {
  detail: TransactionDetailView;
  accounts: readonly AccountView[];
  // Spending a Member may link this money in to, as a Refund or Reimbursement, as far as the
  // Member has paged, and whether a next page is left.
  candidates: readonly TransactionRowView[];
  moreCandidates: boolean;
  form: DetailForm;
  outcome: EditOutcome;
  today: string;
  actions: DetailActions;
}) {
  const { detail, form, actions, today } = props;
  const txn = detail.transaction;
  const labels = accountLabels(props.accounts);
  const parts = partsToShow(detail.decision?.parts ?? []);
  const matched = new Map(detail.matched.map((row) => [row.id, row]));
  const set = (patch: Partial<DetailForm>) => actions.setForm({ ...form, ...patch });
  const splitable = txn.amount < 0 && parts.length > 0 && parts.every((p) => p.type === "Spending");
  const moneyIn = txn.amount > 0;
  // Each Refund or Reimbursement links to at most one Spending (spec 03, Link shapes).
  const linkedIn = moneyIn && detail.otherLinks.some((link) => link.kind !== "loan");
  const setSplitPart = (index: number, patch: Partial<DetailForm["split"][number]>) =>
    set({ split: form.split.map((part, at) => (at === index ? { ...part, ...patch } : part)) });

  return (
    <>
      <h1 className="text-2xl font-semibold">{merchantOf(txn)}</h1>
      <p className="mt-1">
        {dateLabel(txn.authorizedDate ?? txn.postedDate, today)} · {dollarsAndCents(txn.amount)} ·{" "}
        {labels.get(txn.accountId) ?? "An Account"}
        {txn.pending ? <span className="ml-2 text-sm text-gray-500">pending</span> : null}
      </p>
      <p className="mt-1 text-sm text-gray-600">The bank's line: {txn.description}</p>
      {txn.merchant === null ? null : (
        <p className="mt-1 text-sm">
          <Link className={LINK} to={transactionsPath({ merchant: txn.merchant })}>
            Every {txn.merchant} Transaction
          </Link>
        </p>
      )}

      <h2 className="mt-6 text-lg font-semibold">Type and Category</h2>
      {detail.decision === null ? (
        <p className="mt-1">The app has not decided this Transaction yet.</p>
      ) : (
        <ul>
          {parts.map((part, index) => (
            // Parts have no ID of their own; their order is fixed.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <PartLine key={index} part={part} />
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-lg font-semibold">Links</h2>
      {detail.transferLink === null && detail.otherLinks.length === 0 ? (
        <p className="mt-1">No links.</p>
      ) : (
        <ul>
          {detail.transferLink === null ? null : (
            <LinkEvidence
              title="Transfer with:"
              matched={matched.get(detail.transferLink.otherTransactionId)}
              link={detail.transferLink}
              accounts={labels}
              today={today}
              actions={actions}
            />
          )}
          {detail.otherLinks.map((link) => (
            <LinkEvidence
              key={link.id}
              title={linkTitle(link, moneyIn, labels)}
              matched={
                link.otherTransactionId === null ? undefined : matched.get(link.otherTransactionId)
              }
              link={link}
              accounts={labels}
              today={today}
              actions={actions}
            />
          ))}
        </ul>
      )}

      {props.outcome.notice === undefined ? null : (
        <p className="mt-4 text-green-800" role="status">
          {props.outcome.notice}
        </p>
      )}
      {props.outcome.error === undefined ? null : (
        <p className="mt-4 text-red-700" role="alert">
          {props.outcome.error}
        </p>
      )}

      <h2 className="mt-6 text-lg font-semibold">Change the Category</h2>
      <select
        name="category"
        className={FIELD}
        value={form.category}
        onChange={(e) => set({ category: e.target.value })}
      >
        <CategoryOptions />
      </select>
      <label className="mt-2 block">
        <input
          type="checkbox"
          name="onlyThisTransaction"
          checked={form.onlyThisTransaction}
          onChange={(e) => set({ onlyThisTransaction: e.target.checked })}
        />{" "}
        Only this Transaction. Without it, a Category rule gives the Merchant's other Transactions
        this Category too.
      </label>
      <button type="button" className={SAVE} onClick={actions.saveCategory}>
        Save the Category
      </button>

      <h2 className="mt-6 text-lg font-semibold">Set the type</h2>
      <select
        name="type"
        className={FIELD}
        value={form.type}
        onChange={(e) => set({ type: e.target.value as HandSetType })}
      >
        {HAND_SET_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </select>
      <button type="button" className={SAVE} onClick={actions.saveType}>
        Set the type
      </button>

      {splitable ? (
        <>
          <h2 className="mt-6 text-lg font-semibold">Split by amount</h2>
          <p className="text-sm text-gray-600">
            The parts must add up to {dollarsAndCents(-txn.amount)}.
          </p>
          {form.split.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a split's parts are kept in order.
            <div key={index} className="mt-2 flex gap-2">
              <input
                name={`split-amount-${index}`}
                className={FIELD}
                inputMode="decimal"
                value={part.amount}
                onChange={(e) => setSplitPart(index, { amount: e.target.value })}
              />
              <select
                name={`split-category-${index}`}
                className={FIELD}
                value={part.category}
                onChange={(e) => setSplitPart(index, { category: e.target.value })}
              >
                <CategoryOptions />
              </select>
            </div>
          ))}
          <button
            type="button"
            className={BUTTON}
            onClick={() => set({ split: [...form.split, { amount: "", category: "" }] })}
          >
            Add a part
          </button>
          {form.split.length > 2 ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() => set({ split: form.split.slice(0, -1) })}
            >
              Remove the last part
            </button>
          ) : null}
          <button type="button" className={SAVE} onClick={actions.saveSplit}>
            Save the split
          </button>
          {isSplit(parts) ? (
            <button type="button" className={BUTTON} onClick={actions.removeSplit}>
              Remove the split
            </button>
          ) : null}
        </>
      ) : null}

      {moneyIn && !linkedIn ? (
        <>
          <h2 className="mt-6 text-lg font-semibold">Link as a Refund or Reimbursement</h2>
          <select
            name="linkKind"
            className={FIELD}
            value={form.linkKind}
            onChange={(e) => set({ linkKind: e.target.value as DetailForm["linkKind"] })}
          >
            <option value="Refund">Refund from a Merchant</option>
            <option value="Reimbursement">Reimbursement from a person</option>
          </select>
          <p className="mt-2">
            Find the Spending it pays back. It posted on or before{" "}
            {dateLabel(txn.postedDate, today)}.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              Merchant
              <input
                name="candidateMerchant"
                type="text"
                className={FIELD}
                value={form.candidates.merchant}
                onChange={(e) =>
                  set({ candidates: { ...form.candidates, merchant: e.target.value } })
                }
              />
            </label>
            <label className="block">
              From
              <input
                name="candidateFrom"
                type="date"
                className={FIELD}
                value={form.candidates.from}
                max={txn.postedDate}
                onChange={(e) => set({ candidates: { ...form.candidates, from: e.target.value } })}
              />
            </label>
            <label className="block">
              To
              <input
                name="candidateTo"
                type="date"
                className={FIELD}
                value={form.candidates.to}
                max={txn.postedDate}
                onChange={(e) => set({ candidates: { ...form.candidates, to: e.target.value } })}
              />
            </label>
          </div>
          <button type="button" className={BUTTON} onClick={actions.findCandidates}>
            Find Spending
          </button>
          <select
            name="spendingTransactionId"
            className={FIELD}
            value={form.spendingTransactionId}
            onChange={(e) => set({ spendingTransactionId: e.target.value })}
          >
            <option value="">Pick the Spending it pays back</option>
            {props.candidates.map((spent) => (
              <option key={spent.id} value={spent.id}>
                {rowLine(spent, labels, today)}
              </option>
            ))}
          </select>
          {props.moreCandidates ? (
            <button type="button" className={BUTTON} onClick={actions.showMoreCandidates}>
              Show more Spending
            </button>
          ) : null}
          <button type="button" className={SAVE} onClick={actions.linkByHand}>
            Link
          </button>
        </>
      ) : null}
    </>
  );
}

// Reads the Transaction, the Accounts, and for money in, the Spending it may link to.
async function loadDetail(id: string) {
  const [detailRes, accountsRes] = await Promise.all([
    transactionRequests.detail(id),
    api.accounts.$get(),
  ]);
  if (detailRes.status === 404) return null;
  if (!detailRes.ok || !accountsRes.ok) throw new Error("refused");
  const detail = (await detailRes.json()) as TransactionDetailView;
  const { accounts } = (await accountsRes.json()) as { accounts: AccountView[] };
  const filters = candidateFilters(formOf(detail).candidates, detail.transaction.postedDate);
  let candidates: CandidatePage = { filters, rows: [], next: null };
  if (detail.transaction.amount > 0) {
    const read = await readPage(filters);
    if (typeof read !== "string")
      candidates = { ...candidates, rows: read.transactions, next: read.next };
  }
  return { detail, accounts, candidates };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;

export function TransactionDetail() {
  const { id = "" } = useParams();
  const shell = useOutletContext<ShellContext | undefined>();
  const [loaded, setLoaded] = useState<Loaded | null | undefined>();
  const [form, setForm] = useState<DetailForm | undefined>();
  const [candidates, setCandidates] = useState<CandidatePage>({
    filters: {},
    rows: [],
    next: null,
  });
  const [outcome, setOutcome] = useState<EditOutcome>({});
  const today = calendarDateIn(new Date(), browserZone());

  async function load() {
    try {
      const found = await loadDetail(id);
      setLoaded(found);
      if (found !== null) {
        setForm(formOf(found.detail));
        setCandidates(found.candidates);
      }
    } catch {
      setOutcome({ error: "The server did not answer." });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load again when the ID changes.
  useEffect(() => {
    setOutcome({});
    void load();
  }, [id]);

  // After an edit, the Transaction and the main menu's Review list count are read again: an edit
  // may settle a Review list item.
  async function done(edit: EditOutcome) {
    setOutcome(edit);
    if (edit.error !== undefined) return;
    await load();
    const open = await readOpenCount();
    if (open !== undefined) shell?.setReviewListOpenCount(open);
  }

  return (
    <main>
      <p>
        <Link className={LINK} to={transactionsPath()}>
          Transactions
        </Link>
      </p>
      {loaded === null ? <p className="mt-3">No Transaction has this ID.</p> : null}
      {loaded === undefined && outcome.error !== undefined ? (
        <p className="mt-3 text-red-700" role="alert">
          {outcome.error}
        </p>
      ) : null}
      {loaded && form ? (
        <TransactionDetailBody
          detail={loaded.detail}
          accounts={loaded.accounts}
          candidates={candidates.rows}
          moreCandidates={candidates.next !== null}
          form={form}
          outcome={outcome}
          today={today}
          actions={detailActions(loaded.detail, form, setForm, (edit) => void done(edit), {
            page: candidates,
            setPage: setCandidates,
          })}
        />
      ) : null}
    </main>
  );
}
