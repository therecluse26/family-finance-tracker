import { useEffect, useState } from "react";
import { Link } from "react-router";
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
  type GoalsAnswer,
  goalStatus,
  loadGoals,
  markGoal,
  NEEDS_AI,
  readingParts,
} from "../goals.ts";
import { browserZone } from "./Accounts.tsx";

// The Goals page (spec 07, Goals page): the active Goals first, each with its author, words, date,
// progress, and the AI's reading, with "Mark done" and "Mark dropped". The done list and the
// dropped list sit in collapsed sections at the end. Add and Edit the words come with their own
// ticket.

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
      <span className="block font-medium" data-slot="goal-words">
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

function ActiveGoal(props: {
  goal: GoalView;
  accountNames: ReadonlyMap<string, string>;
  today: string;
  busy: boolean;
  onMark: (status: "done" | "dropped") => void;
}) {
  const { goal, today } = props;
  const reading = readingParts(goal.reading, props.accountNames, today);
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
      {goal.status === "active" ? (
        <span className="mt-2 flex gap-2">
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
      <span className="block">“{goal.words}”</span>
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
}) {
  const { answer, today } = props;
  const listed = (list: GoalView["list"]) => answer.goals.filter((goal) => goal.list === list);
  const active = listed("active");
  const done = listed("done");
  const dropped = listed("dropped");
  return (
    <>
      {answer.aiProvider ? null : (
        <p className="mt-2">
          <NeedsAiLink />
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
  const [loaded, setLoaded] = useState<Loaded | undefined>();
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
        />
      )}
    </main>
  );
}
