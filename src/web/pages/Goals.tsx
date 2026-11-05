import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { calendarDateIn, dateLabel, percent } from "../../format.ts";
import type { AccountView } from "../../server/bank-views.ts";
import type { GoalView } from "../../server/goals-views.ts";
import type { HouseholdFactsView } from "../../server/household-views.ts";
import { api } from "../api.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { UndoableProposals } from "../components/Proposal.tsx";
import { AiMark, Estimated, Status } from "../components/Status.tsx";
import {
  AI_SETTINGS,
  authorOf,
  GOAL_WORDS_LENGTH,
  type GoalProblem,
  type GoalsAnswer,
  goalStatus,
  loadGoals,
  markGoal,
  mayWriteGoals,
  NEEDS_AI,
  readingParts,
  saveGoal,
  WAITS_FOR_HISTORY,
} from "../goals.ts";
import { browserZone } from "./Accounts.tsx";

// The Goals page (spec 07, Goals page): "Add a Goal", then the active Goals, each with its author,
// words, date, progress, and the AI's reading, with "Edit the words", "Mark done" and "Mark
// dropped". The done list and the dropped list sit in collapsed sections at the end. Adding a Goal
// and editing its words need an AI provider, and wait until history has loaded. A save past the AI
// cost cap asks "Send anyway?" first; a failed reading shows its error with "Try again", and
// nothing retries by itself.

const SMALL_BUTTON = "rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50";

// "With no AI provider" line: Goals need one, with a link to the AI settings.
export function NeedsAiLink() {
  return (
    <Link className="text-sm text-blue-700 underline" data-slot="needs-ai" to={AI_SETTINGS}>
      {NEEDS_AI}
    </Link>
  );
}

// A Goal's author, words, status and percentage, progress bar, and detail line, as on the
// dashboard (spec 07, 3. Goals). A reading with no target shows no progress.
export function GoalCard(props: { goal: GoalView }) {
  const { goal } = props;
  const { progress } = goal;
  const status = progress === null ? undefined : goalStatus(progress);
  return (
    <>
      <span className="block text-sm text-gray-600" data-slot="goal-author">
        {authorOf(goal)}
      </span>
      <span className="block font-medium wrap-anywhere" data-slot="goal-words">
        “{goal.words}”
      </span>
      {progress === null ? null : (
        <>
          <span className="mt-1 flex flex-wrap items-baseline gap-2" data-slot="goal-status">
            {status === undefined ? null : <Status {...status} />}
            {progress.percentage === null ? null : (
              <span>{percent(progress.percentage / 100)}</span>
            )}
            {progress.estimated ? <Estimated /> : null}
          </span>
          <span aria-hidden="true" className="mt-1 block h-2 rounded bg-gray-100">
            <span
              className={`block h-2 rounded ${status?.tone === "serious" ? "bg-orange-600" : "bg-green-600"}`}
              data-slot="goal-bar"
              style={{ width: `${progress.percentage ?? 0}%` }}
            />
          </span>
          <span className="mt-1 block text-sm text-gray-600" data-slot="goal-detail">
            {progress.detail}
          </span>
        </>
      )}
    </>
  );
}

// The open "Add a Goal" or "Edit the words" form: the Goal ID it edits, or null for a new Goal, the
// words typed so far, and what went wrong with the last save. `sentAnyway` is true once the
// Member said yes to "Send anyway?", so "Try again" sends the same yes.
export type GoalForm = {
  goalId: string | null;
  draft: string;
  busy: boolean;
  problem?: GoalProblem;
  sentAnyway?: boolean;
};

// What the page does with the form.
export type GoalFormActions = {
  form: GoalForm | undefined;
  onOpen: (goalId: string | null, words: string) => void;
  onDraft: (draft: string) => void;
  onSave: (sendAnyway: boolean) => void;
  onCancel: () => void;
};

// A Goal in the Member's own words, with "Save", or after a problem, "Send anyway" past the AI
// cost cap, or "Try again" after a failed reading.
export function GoalWordsForm(props: { label: string; actions: GoalFormActions; form: GoalForm }) {
  const { form, actions } = props;
  const { problem } = form;
  const id = `goal-words-${form.goalId ?? "new"}`;
  return (
    <form
      className="mt-2"
      data-slot="goal-form"
      onSubmit={(event) => {
        event.preventDefault();
        actions.onSave(false);
      }}
    >
      <label className="block text-sm font-medium" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        id={id}
        className="mt-1 block w-full rounded border border-gray-300 p-2"
        maxLength={GOAL_WORDS_LENGTH}
        rows={2}
        placeholder="Such as: Spend 20% less on restaurants"
        value={form.draft}
        disabled={form.busy}
        onChange={(event) => actions.onDraft(event.target.value)}
      />
      {problem === undefined ? null : (
        <p className="mt-1 text-sm text-red-700" data-slot="goal-problem" role="alert">
          {problem.error}
        </p>
      )}
      <span className="mt-2 flex gap-2">
        {problem?.sendAnyway === true ? (
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={form.busy}
            onClick={() => actions.onSave(true)}
          >
            Send anyway
          </button>
        ) : problem?.tryAgain === true ? (
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={form.busy}
            onClick={() => actions.onSave(form.sentAnyway === true)}
          >
            Try again
          </button>
        ) : (
          <button type="submit" className={SMALL_BUTTON} disabled={form.busy}>
            Save
          </button>
        )}
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={form.busy}
          onClick={actions.onCancel}
        >
          Cancel
        </button>
      </span>
    </form>
  );
}

function ActiveGoal(props: {
  goal: GoalView;
  accountNames: ReadonlyMap<string, string>;
  today: string;
  busy: boolean;
  onMark: (status: "done" | "dropped") => void;
  // "Edit the words", while a Member may write Goals.
  writing: GoalFormActions | undefined;
}) {
  const { goal, today, writing } = props;
  const reading = readingParts(goal.reading, props.accountNames, today);
  const form = writing?.form?.goalId === goal.id ? writing.form : undefined;
  return (
    <li className="mt-3 rounded border border-gray-200 p-3" data-goal={goal.id}>
      <GoalCard goal={goal} />
      <span className="mt-1 block text-sm text-gray-600" data-slot="goal-date">
        {dateLabel(goal.date, today)}
      </span>
      <span className="mt-2 block text-sm" data-slot="goal-reading">
        <AiMark /> Target: {reading.target} · Change: {reading.change} · Deadline:{" "}
        {reading.deadline}
      </span>
      {writing !== undefined && form !== undefined ? (
        <GoalWordsForm label="Edit the words" actions={writing} form={form} />
      ) : null}
      {goal.status === "active" ? (
        <span className="mt-2 flex gap-2">
          {writing === undefined || form !== undefined ? null : (
            <button
              type="button"
              className={SMALL_BUTTON}
              disabled={props.busy}
              onClick={() => writing.onOpen(goal.id, goal.words)}
            >
              Edit the words
            </button>
          )}
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={props.busy}
            onClick={() => props.onMark("done")}
          >
            Mark done
          </button>
          <button
            type="button"
            className={SMALL_BUTTON}
            disabled={props.busy}
            onClick={() => props.onMark("dropped")}
          >
            Mark dropped
          </button>
        </span>
      ) : null}
    </li>
  );
}

// A Goal in the done or dropped list: its author, words, and the day it ended.
function EndedGoal(props: { goal: GoalView; today: string }) {
  const { goal, today } = props;
  const word = goal.status === "done" ? "Done" : "Dropped";
  return (
    <li className="mt-2" data-goal={goal.id}>
      <span className="block text-sm text-gray-600">{authorOf(goal)}</span>
      <span className="block wrap-anywhere" data-slot="goal-words">
        “{goal.words}”
      </span>
      <span className="block text-sm text-gray-600">
        {goal.endedOn === null ? word : `${word} on ${dateLabel(goal.endedOn, today)}`}
      </span>
    </li>
  );
}

export function GoalsReport(props: {
  answer: GoalsAnswer;
  accountNames: ReadonlyMap<string, string>;
  today: string;
  busy?: string;
  onMark: (id: string, status: "done" | "dropped") => void;
  // "Add a Goal" and "Edit the words". Without it, the page offers neither.
  writing?: GoalFormActions;
}) {
  const { answer, today } = props;
  const writing = mayWriteGoals(answer) ? props.writing : undefined;
  const adding = writing?.form?.goalId === null ? writing.form : undefined;
  const listed = (list: GoalView["list"]) => answer.goals.filter((goal) => goal.list === list);
  const active = listed("active");
  const done = listed("done");
  const dropped = listed("dropped");
  return (
    <>
      {!answer.aiProvider ? (
        <p className="mt-2">
          <NeedsAiLink />
        </p>
      ) : answer.waitsForHistory ? (
        <p className="mt-2 text-sm text-gray-600" data-slot="goals-wait">
          {WAITS_FOR_HISTORY}
        </p>
      ) : writing === undefined ? null : adding !== undefined ? (
        <GoalWordsForm label="Add a Goal" actions={writing} form={adding} />
      ) : (
        <p className="mt-2">
          <button
            type="button"
            className={SMALL_BUTTON}
            data-slot="add-goal"
            onClick={() => writing.onOpen(null, "")}
          >
            Add a Goal
          </button>
        </p>
      )}
      {active.length === 0 ? (
        <p className="mt-4 text-gray-600">No active Goal.</p>
      ) : (
        <ul aria-label="Active Goals">
          {active.map((goal) => (
            <ActiveGoal
              key={goal.id}
              goal={goal}
              accountNames={props.accountNames}
              today={today}
              busy={props.busy === goal.id}
              onMark={(status) => props.onMark(goal.id, status)}
              writing={writing}
            />
          ))}
        </ul>
      )}
      {done.length === 0 ? null : (
        <details className="mt-6" data-slot="done-list">
          <summary className="text-lg font-semibold">Done ({done.length})</summary>
          <ul aria-label="Done Goals">
            {done.map((goal) => (
              <EndedGoal key={goal.id} goal={goal} today={today} />
            ))}
          </ul>
        </details>
      )}
      {dropped.length === 0 ? null : (
        <details className="mt-6" data-slot="dropped-list">
          <summary className="text-lg font-semibold">Dropped ({dropped.length})</summary>
          <ul aria-label="Dropped Goals">
            {dropped.map((goal) => (
              <EndedGoal key={goal.id} goal={goal} today={today} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

type Loaded = { answer: GoalsAnswer; accountNames: Map<string, string>; today: string };

export function Goals() {
  const [params] = useSearchParams();
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  // The dashboard's "Add a Goal" opens the page with the form open.
  const [form, setForm] = useState<GoalForm | undefined>(
    params.has("add") ? { goalId: null, draft: "", busy: false } : undefined,
  );
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Counts the page's reads, so the accepted Proposals read again with it.
  const [reads, setReads] = useState(0);

  // Dates are the Household's, as on the dashboard.
  async function load() {
    try {
      const [answer, accounts, household] = await Promise.all([
        loadGoals(),
        api.accounts.$get(),
        api.household.$get(),
      ]);
      const listed = accounts.ok
        ? ((await accounts.json()) as { accounts: AccountView[] }).accounts
        : [];
      const facts = household.ok
        ? ((await household.json()) as { facts: HouseholdFactsView | null }).facts
        : null;
      setLoaded({
        answer,
        accountNames: new Map(listed.map((account) => [account.id, account.name])),
        today: calendarDateIn(new Date(), facts?.timeZone ?? browserZone()),
      });
      setReads((count) => count + 1);
      setError(undefined);
    } catch {
      setError("The Goals did not load.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  async function mark(id: string, status: "done" | "dropped") {
    setBusy(id);
    const failed = await markGoal(id, status);
    setBusy(undefined);
    if (failed !== undefined) return setError(failed);
    await load();
  }

  // One save: one reading. A problem keeps the form open with its words.
  async function save(sendAnyway: boolean) {
    if (form === undefined || form.busy) return;
    const sending = { ...form, busy: true, sentAnyway: sendAnyway || form.sentAnyway === true };
    setForm(sending);
    const problem = await saveGoal(sending.goalId, sending.draft, sendAnyway);
    if (problem !== undefined) return setForm({ ...sending, busy: false, problem });
    setForm(undefined);
    await load();
  }

  const writing: GoalFormActions = {
    form,
    onOpen: (goalId, words) => setForm({ goalId, draft: words, busy: false }),
    onDraft: (draft) => setForm((open) => (open === undefined ? open : { ...open, draft })),
    onSave: (sendAnyway) => void save(sendAnyway),
    onCancel: () => setForm(undefined),
  };

  return (
    <main>
      <h1 className="text-2xl font-semibold">Goals</h1>
      <ErrorLine error={error} />
      <UndoableProposals
        key={reads}
        kinds={["Goal amount", "new Goal"]}
        onChanged={() => void load()}
      />
      {loaded === undefined ? null : (
        <GoalsReport
          answer={loaded.answer}
          accountNames={loaded.accountNames}
          today={loaded.today}
          {...(busy === undefined ? {} : { busy })}
          onMark={(id, status) => void mark(id, status)}
          writing={writing}
        />
      )}
    </main>
  );
}
