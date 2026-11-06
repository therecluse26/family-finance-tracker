import { type FormEvent, useEffect, useState } from "react";
import type {
  ProposalEditView,
  ProposalKindView,
  ProposalView,
} from "../../server/proposals-views.ts";
import { typedBudget } from "../budgets.ts";
import { centsOf } from "../pages/settings/UnconnectedAccounts.tsx";
import {
  acceptProposal,
  loadUndoable,
  saveAndAccept,
  skipProposal,
  undoProposal,
} from "../proposals.ts";
import { Button } from "./Button.tsx";
import { ErrorLine, FIELD } from "./Fields.tsx";
import { AiMark } from "./Status.tsx";

// A Proposal's card (spec 07, 1. AI box; spec 08, Proposals): the change, such as "Restaurants
// Budget: $600 → $480", the AI's reason, and "Accept", "Edit", "Skip", and "Ask about this". It has
// no Done button. "Edit" lets the Member change the amount or the words, then "Save and accept".

export const ENTER_AMOUNT = "Enter each amount in dollars and cents.";
export const ENTER_WORDS = "Enter the Goal in your own words.";

// What Edit shows at first: each amount as a Member types it, or the new Goal's words.
export type EditFields = { amounts: Record<string, string>; words: string };

export function editFields(proposal: ProposalView): EditFields {
  const amounts: Record<string, string> = {};
  for (const budget of proposal.budgets) amounts[budget.category] = typedBudget(budget.to);
  if (proposal.goal !== null) amounts.goal = typedBudget(proposal.goal.goalAmount);
  return { amounts, words: proposal.words ?? "" };
}

// The Member's Edit as the server takes it, or the words to show when a field will not do.
export function editOf(proposal: ProposalView, fields: EditFields): ProposalEditView | string {
  if (proposal.kind === "new Goal") {
    const words = fields.words.trim();
    return words === "" ? ENTER_WORDS : { words };
  }
  const cents = (typed: string | undefined) => {
    const amount = centsOf(typed ?? "");
    return amount === undefined || amount < 0 ? undefined : amount;
  };
  if (proposal.kind === "Goal amount") {
    const goalAmount = cents(fields.amounts.goal);
    return goalAmount === undefined ? ENTER_AMOUNT : { goalAmount };
  }
  const budgets: Record<string, number> = {};
  for (const { category } of proposal.budgets) {
    const amount = cents(fields.amounts[category]);
    if (amount === undefined) return ENTER_AMOUNT;
    budgets[category] = amount;
  }
  return { budgets };
}

// "Save and accept" from the Edit fields.
function saveFields(proposal: ProposalView, fields: EditFields): Promise<string | undefined> {
  const edit = editOf(proposal, fields);
  if (typeof edit === "string") return Promise.resolve(edit);
  return saveAndAccept(proposal.id, edit);
}

function EditForm(props: {
  proposal: ProposalView;
  busy: boolean;
  onSave: (fields: EditFields) => void;
  onCancel: () => void;
}) {
  const { proposal } = props;
  const [fields, setFields] = useState(() => editFields(proposal));
  const amount = (key: string) => (value: string) =>
    setFields({ ...fields, amounts: { ...fields.amounts, [key]: value } });

  function submit(event: FormEvent) {
    event.preventDefault();
    props.onSave(fields);
  }

  return (
    <form className="mt-2" onSubmit={submit} data-slot="proposal-edit">
      {proposal.budgets.map((budget) => (
        <label key={budget.category} className="mt-2 block text-small text-ink-soft">
          {budget.category} Budget{budget.period === "yearly" ? " a year" : ""}, in dollars
          <input
            className={FIELD}
            inputMode="decimal"
            value={fields.amounts[budget.category] ?? ""}
            onChange={(e) => amount(budget.category)(e.target.value)}
          />
        </label>
      ))}
      {proposal.goal === null ? null : (
        <label className="mt-2 block text-small text-ink-soft">
          Goal amount, in dollars
          <input
            className={FIELD}
            inputMode="decimal"
            value={fields.amounts.goal ?? ""}
            onChange={(e) => amount("goal")(e.target.value)}
          />
        </label>
      )}
      {proposal.kind === "new Goal" ? (
        <label className="mt-2 block text-small text-ink-soft">
          The Goal, in your own words
          <input
            className={FIELD}
            value={fields.words}
            onChange={(e) => setFields({ ...fields, words: e.target.value })}
          />
        </label>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button type="submit" size="small" disabled={props.busy}>
          Save and accept
        </Button>
        <Button type="button" variant="outlined" size="small" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ProposalCard(props: {
  proposal: ProposalView;
  onChanged: () => void;
  editing?: boolean;
  // "Ask about this": a new Chat thread with the Proposal attached. Without it, the button waits.
  onAsk?: () => void;
  // Where the card sits, such as its width inside a Chat thread.
  className?: string;
}) {
  const { proposal } = props;
  const [editing, setEditing] = useState(props.editing ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function act(send: () => Promise<string | undefined>) {
    setBusy(true);
    const failed = await send();
    setBusy(false);
    setError(failed);
    if (failed === undefined) props.onChanged();
  }

  return (
    <li
      className={`min-w-0 rounded-[10px] border border-line bg-[#FBFBFC] px-3.5 py-3 wrap-anywhere ${props.className ?? ""}`}
      data-slot="proposal"
    >
      <p className="text-small text-muted">Proposal</p>
      {proposal.changes.map((change) => (
        <p key={change} className="mt-0.5 font-semibold" data-slot="proposal-change">
          {change}
        </p>
      ))}
      <p className="mt-1 text-small text-ink-soft" data-slot="proposal-reason">
        {proposal.reason} <AiMark />
      </p>
      <ErrorLine error={error} />
      {editing ? (
        <EditForm
          proposal={proposal}
          busy={busy}
          onSave={(fields) => void act(() => saveFields(proposal, fields))}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="small"
            disabled={busy}
            onClick={() => void act(() => acceptProposal(proposal.id))}
          >
            Accept
          </Button>
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={busy}
            onClick={() => void act(() => skipProposal(proposal.id))}
          >
            Skip
          </Button>
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={props.onAsk === undefined}
            onClick={props.onAsk}
          >
            Ask about this
          </Button>
        </div>
      )}
    </li>
  );
}

// The accepted Proposals of these kinds whose Undo is still offered (spec 08, Lifecycle): Undo puts
// back what the Proposal replaced, until a later change touches the same Budget or Goal.
export function UndoableProposals(props: {
  kinds: readonly ProposalKindView[];
  onChanged: () => void;
  // The list to show at first, for a page drawn without the server.
  initial?: ProposalView[];
}) {
  const [proposals, setProposals] = useState<ProposalView[] | undefined>(props.initial);
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      setProposals(await loadUndoable());
    } catch {
      setProposals([]);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the list opens.
  useEffect(() => {
    if (props.initial === undefined) void load();
  }, []);

  async function undo(id: string) {
    setBusy(id);
    const failed = await undoProposal(id);
    setBusy(undefined);
    setError(failed);
    await load();
    if (failed === undefined) props.onChanged();
  }

  const shown = (proposals ?? []).filter((proposal) => props.kinds.includes(proposal.kind));
  if (shown.length === 0 && error === undefined) return null;
  return (
    <section aria-label="Accepted Proposals" className="mt-4" data-slot="undoable-proposals">
      <h2 className="font-semibold">Accepted Proposals</h2>
      <ErrorLine error={error} />
      <ul className="mt-2 flex flex-col gap-2">
        {shown.map((proposal) => (
          <li
            key={proposal.id}
            className="flex flex-wrap items-baseline gap-2"
            data-slot="undoable"
          >
            <span>{proposal.changes.join("; ")}</span>
            <Button
              type="button"
              variant="outlined"
              size="small"
              disabled={busy === proposal.id}
              onClick={() => void undo(proposal.id)}
            >
              Undo
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
