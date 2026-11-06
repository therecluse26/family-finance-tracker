import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { calendarDateIn, dateLabel, percent } from "../../format.ts";
import type { AccountView } from "../../server/bank-views.ts";
import type { GoalProgressView, GoalView } from "../../server/goals-views.ts";
import type { HouseholdFactsView } from "../../server/household-views.ts";
import { api } from "../api.ts";
import { browserZone } from "../browser-zone.ts";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine, FIELD } from "../components/Fields.tsx";
import { Meter } from "../components/Meter.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
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

// The Goals page (spec 07, Goals page): "Add a Goal", then the active Goals, each with its author,
// words, date, progress, and the AI's reading, with "Edit the words", "Mark done" and "Mark
// dropped". The done list and the dropped list sit in collapsed sections at the end. Adding a Goal
// and editing its words need an AI provider, and wait until history has loaded. A save past the AI
// cost cap asks "Send anyway?" first; a failed reading shows its error with "Try again", and
// nothing retries by itself.

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
      data-slot="goal-form"
      onSubmit={(event) => {
        event.preventDefault();
        actions.onSave(false);
      }}
    >
      <label className="block text-sm font-semibold" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        id={id}
        className={FIELD}
        maxLength={GOAL_WORDS_LENGTH}
        rows={2}
        placeholder="Such as: Spend 20% less on restaurants"
        value={form.draft}
        disabled={form.busy}
        onChange={(event) => actions.onDraft(event.target.value)}
      />
      {problem === undefined ? null : (
        <p className="mt-2 text-sm text-critical" data-slot="goal-problem" role="alert">
          {problem.error}
        </p>
      )}
      <span className="mt-3 flex flex-wrap gap-2">
        {problem?.sendAnyway === true ? (
          <Button type="button" disabled={form.busy} onClick={() => actions.onSave(true)}>
            Send anyway
          </Button>
        ) : problem?.tryAgain === true ? (
          <Button
            type="button"
            disabled={form.busy}
            onClick={() => actions.onSave(form.sentAnyway === true)}
          >
            Try again
          </Button>
        ) : (
          <Button type="submit" disabled={form.busy}>
            Save
          </Button>
        )}
        <Button type="button" variant="outlined" disabled={form.busy} onClick={actions.onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

// What sits beside the page heading: "Add a Goal" while a Member may write Goals, or why not.
// With no AI provider it says Goals need one and links to the AI settings; before history has
// loaded it says Goals wait for it. While the "Add a Goal" form is open, the form takes its place.
export function GoalsHeadingControl(props: { answer: GoalsAnswer; writing?: GoalFormActions }) {
  const { answer } = props;
  if (!answer.aiProvider) return <NeedsAiLink />;
  if (answer.waitsForHistory) {
    return (
      <p className="text-small text-muted" data-slot="goals-wait">
        {WAITS_FOR_HISTORY}
      </p>
    );
  }
  const writing = props.writing;
  if (writing === undefined || writing.form?.goalId === null) return null;
  return (
    <Button type="button" data-slot="add-goal" onClick={() => writing.onOpen(null, "")}>
      <svg aria-hidden="true" className="size-3.5" viewBox="0 0 14 14">
        <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Add a Goal
    </Button>
  );
}

// "◆ Behind · 38%", "✓ On track · 52%", or the percentage alone with no status, then "estimated"
// when the Goal's money sits in an Unconnected account.
function GoalProgressLine(props: { progress: GoalProgressView }) {
  const { progress } = props;
  const status = goalStatus(progress);
  const shown = progress.percentage === null ? undefined : percent(progress.percentage / 100);
  return (
    <span
      className="flex flex-wrap items-center gap-2 font-semibold tabular-nums"
      data-slot="goal-status"
    >
      {status === undefined ? (
        shown === undefined ? null : (
          <span>{shown}</span>
        )
      ) : (
        <Status {...status} {...(shown === undefined ? {} : { detail: shown })} />
      )}
      {progress.estimated ? <Estimated /> : null}
    </span>
  );
}

// One fact of the AI's reading, such as "Target" over "Restaurants".
function ReadingFact(props: { label: string; ai?: boolean; children: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">
        {props.label}
        {props.ai === true ? (
          <>
            {" "}
            <AiMark />
          </>
        ) : null}
      </dt>
      <dd className="mt-0.5 tabular-nums">{props.children}</dd>
    </div>
  );
}

// An active Goal's card (spec 07, Goals page): its words as the heading, its status and
// percentage, its author and date, its progress bar and detail line, the AI's reading, and its
// actions. A reading with no target shows no progress.
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
  const { progress } = goal;
  const reading = readingParts(goal.reading, props.accountNames, today);
  const form = writing?.form?.goalId === goal.id ? writing.form : undefined;
  const behind = progress === null ? false : goalStatus(progress)?.tone === "serious";
  return (
    <li data-goal={goal.id}>
      <Card as="article">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 className="min-w-0 flex-[1_1_300px] text-lg font-bold">
            <span className="wrap-anywhere" data-slot="goal-words">
              “{goal.words}”
            </span>
          </h2>
          {progress === null ? null : <GoalProgressLine progress={progress} />}
        </div>
        <p className="mt-1 text-small text-muted">
          <span data-slot="goal-author">{authorOf(goal)}</span> ·{" "}
          <span data-slot="goal-date">set {dateLabel(goal.date, today)}</span>
        </p>
        {progress === null ? null : (
          <>
            <Meter
              share={(progress.percentage ?? 0) / 100}
              tone={behind ? "serious" : "good"}
              className="mt-3"
            />
            <p className="mt-1.5 text-small text-muted" data-slot="goal-detail">
              {progress.detail}
            </p>
          </>
        )}
        <dl className="mt-3.5 flex flex-wrap gap-x-7 gap-y-2.5" data-slot="goal-reading">
          <ReadingFact label="Target" ai>
            {reading.target}
          </ReadingFact>
          <ReadingFact label="Change">{reading.change}</ReadingFact>
          <ReadingFact label="Deadline">{reading.deadline}</ReadingFact>
        </dl>
        {writing !== undefined && form !== undefined ? (
          <div className="mt-3.5 border-t border-line-soft pt-3.5">
            <GoalWordsForm label="Edit the words" actions={writing} form={form} />
          </div>
        ) : null}
        {goal.status === "active" ? (
          <span className="mt-3.5 flex flex-wrap gap-2">
            {writing === undefined || form !== undefined ? null : (
              <Button
                type="button"
                variant="outlined"
                disabled={props.busy}
                onClick={() => writing.onOpen(goal.id, goal.words)}
              >
                Edit the words
              </Button>
            )}
            <Button
              type="button"
              variant="outlined"
              disabled={props.busy}
              onClick={() => props.onMark("done")}
            >
              Mark done
            </Button>
            <Button
              type="button"
              variant="outlined"
              disabled={props.busy}
              onClick={() => props.onMark("dropped")}
            >
              Mark dropped
            </Button>
          </span>
        ) : null}
      </Card>
    </li>
  );
}

// A Goal in the done or dropped list: its author, words, and the day it ended.
function EndedGoal(props: { goal: GoalView; today: string }) {
  const { goal, today } = props;
  const word = goal.status === "done" ? "Done" : "Dropped";
  return (
    <li className="border-t border-line-soft py-2.5 first:border-t-0" data-goal={goal.id}>
      <span className="block text-small text-muted">{authorOf(goal)}</span>
      <span className="block wrap-anywhere" data-slot="goal-words">
        “{goal.words}”
      </span>
      <span className="block text-small text-muted">
        {goal.endedOn === null ? word : `${word} on ${dateLabel(goal.endedOn, today)}`}
      </span>
    </li>
  );
}

// A collapsed list at the end, such as "Done (2)".
function EndedList(props: {
  slot: string;
  title: string;
  label: string;
  goals: GoalView[];
  today: string;
}) {
  return (
    <details
      className="group border-t border-line-soft py-4 first:border-t-0"
      data-slot={props.slot}
    >
      <summary className="cursor-pointer font-semibold">
        {props.title} ({props.goals.length})
      </summary>
      <ul aria-label={props.label} className="mt-2">
        {props.goals.map((goal) => (
          <EndedGoal key={goal.id} goal={goal} today={props.today} />
        ))}
      </ul>
    </details>
  );
}

// The Goals under the heading: the open "Add a Goal" form, the active Goals, then the done list and
// the dropped list. `GoalsHeadingControl` holds "Add a Goal" itself.
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
      {writing === undefined || adding === undefined ? null : (
        <Card>
          <GoalWordsForm label="Add a Goal" actions={writing} form={adding} />
        </Card>
      )}
      {active.length === 0 ? (
        <Card>
          <p className="text-muted">No active Goal.</p>
        </Card>
      ) : (
        <ul aria-label="Active Goals" className="flex flex-col gap-4">
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
      {done.length === 0 && dropped.length === 0 ? null : (
        <Card padding="list">
          {done.length === 0 ? null : (
            <EndedList
              slot="done-list"
              title="Done"
              label="Done Goals"
              goals={done}
              today={today}
            />
          )}
          {dropped.length === 0 ? null : (
            <EndedList
              slot="dropped-list"
              title="Dropped"
              label="Dropped Goals"
              goals={dropped}
              today={today}
            />
          )}
        </Card>
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

  // The heading stays one element while the page loads, so the focus a menu choice puts on it
  // stays there. "Add a Goal" joins it once the Goals have loaded.
  return (
    <Page>
      <PageHeading title="Goals">
        {loaded === undefined ? null : (
          <GoalsHeadingControl answer={loaded.answer} writing={writing} />
        )}
      </PageHeading>
      <p className="text-muted">
        Write a Goal in your own words. The AI reads it into a target, a change and a deadline.
      </p>
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
    </Page>
  );
}
