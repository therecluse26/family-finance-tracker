import { useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router";
import { calendarDateIn, dateLabel, percent, wholeDollars } from "../../format.ts";
import type { StoredReview } from "../../monthly-review/review-view.ts";
import type {
  HeldBackAlertView,
  MonthlyReviewView,
  ReviewListView,
} from "../../server/monthly-reviews-views.ts";
import { browserZone } from "../browser-zone.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { PictureDrawing } from "../components/Picture.tsx";
import { ProposalCard } from "../components/Proposal.tsx";
import { AiMark, Status } from "../components/Status.tsx";
import { monthName } from "../dashboard.ts";
import { AI_SETTINGS } from "../goals.ts";
import {
  BAR_TOP,
  firstIdeaFor,
  type IdeaRow,
  ideaFacts,
  ideaRows,
  leftOver,
  listLine,
  loadReview,
  loadReviewList,
  NO_REVIEW_WITHOUT_AI,
  planHeading,
  planRows,
  reviewTitle,
  spendingLine,
  spendingShare,
  tickPlanItem,
} from "../monthly-review.ts";

// The Reviews page (spec 07, Reviews page): the past Monthly reviews, newest first, and one review
// in the layout of prototype round 3. Two columns on a wide screen, one on a phone. The AI wrote
// the words; the app drew every number and picture when the review was written, and the review
// never changes.

const BOX = "rounded border border-gray-200 p-4";
const HEADING = "font-semibold";

const todayHere = () => calendarDateIn(new Date(), browserZone());

// --- The list -----------------------------------------------------------------------------------

export function ReviewListReport(props: { list: ReviewListView; today: string }) {
  const { list } = props;
  return (
    <>
      {list.aiProvider ? null : (
        <p className="mt-2" data-slot="no-ai">
          {NO_REVIEW_WITHOUT_AI}{" "}
          <Link className="text-blue-700 underline" to={AI_SETTINGS}>
            Set up AI
          </Link>
        </p>
      )}
      {list.reviews.length === 0 ? (
        list.aiProvider ? (
          <p className="mt-2 text-gray-600" data-slot="no-reviews">
            No Monthly review yet. The first is written on the 1st.
          </p>
        ) : null
      ) : (
        <ul aria-label="Monthly reviews" className="mt-3 flex flex-col gap-2">
          {list.reviews.map((review) => (
            <li key={review.month} data-review={review.month}>
              <Link className="text-blue-700 underline" to={`/reviews/${review.month}`}>
                {listLine(review.month)}
              </Link>{" "}
              <span className="text-sm text-gray-600">
                written {dateLabel(review.writtenOn, props.today)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Reviews() {
  const [list, setList] = useState<ReviewListView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    loadReviewList().then(setList, () => setError("The Reviews list did not load."));
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Reviews</h1>
      <ErrorLine error={error} />
      {list === undefined ? null : <ReviewListReport list={list} today={todayHere()} />}
    </main>
  );
}

// --- 1. Header ----------------------------------------------------------------------------------

// The Spending-against-Budget bar. Its words carry its numbers, so the bar is hidden from screen
// readers. A dark mark shows the Budget; the bar runs to 125% of it so an overage shows.
function SpendingBar(props: { header: StoredReview["header"] }) {
  const { header } = props;
  const over = header.budget !== null && header.spending > header.budget;
  return (
    <figure className="min-w-0" data-slot="spending-bar">
      <div aria-hidden="true" className="relative mt-1 h-2.5 rounded-full bg-gray-100">
        <div
          className={`h-2.5 rounded-full ${over ? "bg-orange-600" : "bg-blue-700"}`}
          style={{ width: `${spendingShare(header) * 100}%` }}
        />
        {header.budget === null ? null : (
          <div
            className="absolute -top-1 h-4 w-0.5 bg-gray-900"
            style={{ left: `${100 / BAR_TOP}%` }}
          />
        )}
      </div>
      <figcaption className="mt-1 text-sm" data-slot="spending-line">
        Spending: {spendingLine(header)}
      </figcaption>
    </figure>
  );
}

function Figure(props: { label: string; value: string; slot: string }) {
  return (
    <div data-slot={props.slot}>
      <p className="text-sm text-gray-600">{props.label}</p>
      <p className="text-xl font-semibold tabular-nums">{props.value}</p>
    </div>
  );
}

function ReviewHeader(props: { view: MonthlyReviewView; today: string }) {
  const { review } = props.view;
  const left = leftOver(review.header);
  return (
    <section aria-labelledby="review-title" className={`${BOX} min-[900px]:col-span-2`}>
      <h1 id="review-title" className="text-sm font-semibold text-gray-600">
        {reviewTitle(props.view.month, review.writtenOn, props.today)}
      </h1>
      <p className="mt-1 text-lg font-semibold" data-slot="headline">
        {review.headline}
      </p>
      <p className="mt-1 text-xs text-gray-600">
        <AiMark /> The AI wrote the words. The app drew every number and picture.
      </p>
      <div className="mt-3 grid grid-cols-1 items-end gap-4 min-[600px]:grid-cols-[2fr_1fr_1fr]">
        <SpendingBar header={review.header} />
        {left === null ? null : <Figure label="Left over" value={left} slot="left-over" />}
        <Figure label="Debt" value={wholeDollars(review.header.debt)} slot="debt" />
      </div>
    </section>
  );
}

// --- 2. Habits ----------------------------------------------------------------------------------

function HabitCard(props: { habit: StoredReview["habits"][number]; tryIdea: string | undefined }) {
  const { habit } = props;
  return (
    <li className={`${BOX} flex min-w-0 flex-col gap-3 wrap-anywhere`} data-slot="habit">
      <div>
        <p className="font-semibold" data-slot="habit-name">
          {habit.name}
        </p>
        <p className="text-sm text-gray-700" data-slot="habit-line">
          {habit.line}
        </p>
      </div>
      <PictureDrawing picture={habit.picture} />
      <div className="mt-auto flex flex-wrap items-baseline justify-between gap-2 text-sm">
        {props.tryIdea === undefined ? (
          <span />
        ) : (
          <span className="text-gray-700" data-slot="habit-try">
            Try: {props.tryIdea}
          </span>
        )}
        <span className="rounded bg-gray-100 px-1.5 font-semibold tabular-nums" data-slot="cost">
          {wholeDollars(habit.costMonth)} a month
        </span>
      </div>
    </li>
  );
}

function Habits(props: { review: StoredReview }) {
  const { habits, ideas } = props.review;
  return (
    <section aria-labelledby="habits" className="min-w-0 min-[900px]:col-span-2">
      <h2 id="habits" className={HEADING}>
        Habits we noticed
      </h2>
      <ul
        className={`mt-2 grid grid-cols-1 gap-4 min-[600px]:grid-cols-2 ${habits.length === 3 ? "min-[1100px]:grid-cols-3" : ""}`}
      >
        {habits.map((habit, index) => (
          <HabitCard
            // biome-ignore lint/suspicious/noArrayIndexKey: a stored review never changes.
            key={index}
            habit={habit}
            tryIdea={firstIdeaFor(ideas, index)}
          />
        ))}
      </ul>
    </section>
  );
}

// --- 3. Ideas -----------------------------------------------------------------------------------

// One idea: its words, its bar, and its saving a month. Tapping it shows why, the Catch, and its
// kind, effort, and saving a year.
function IdeaBar(props: { row: IdeaRow; open: boolean; onToggle: () => void }) {
  const { row } = props;
  const whyId = useId();
  return (
    <li data-slot="idea" data-kind={row.debt ? "debt" : "spending"}>
      <button
        type="button"
        className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 py-1.5 text-left"
        aria-expanded={props.open}
        aria-controls={whyId}
        onClick={props.onToggle}
      >
        <span className="min-w-0">
          <span className="block text-sm wrap-anywhere" data-slot="idea-words">
            {row.idea}
          </span>
          <span
            aria-hidden="true"
            className={`mt-1 block h-2 rounded-full ${row.debt ? "bg-red-600" : "bg-green-600"}`}
            data-slot="idea-bar"
            style={{ width: `${Math.max(row.share * 100, 3)}%` }}
          />
        </span>
        <span className="text-right text-sm font-semibold tabular-nums" data-slot="idea-saves">
          {wholeDollars(row.savesMonth)}
        </span>
      </button>
      <div id={whyId} hidden={!props.open} className="pb-2 text-sm" data-slot="idea-why">
        <p className="text-gray-700">{row.why}</p>
        {row.catch === null ? null : (
          <p data-slot="idea-catch">
            <span className="font-semibold">Catch:</span> {row.catch}
          </p>
        )}
        <p className="text-xs text-gray-600" data-slot="idea-facts">
          {ideaFacts(row)}
        </p>
      </div>
    </li>
  );
}

export function IdeasChart(props: { ideas: StoredReview["ideas"]; open?: number }) {
  const [open, setOpen] = useState<number | undefined>(props.open);
  return (
    <section aria-labelledby="ideas" className={`${BOX} min-w-0`}>
      <h2 id="ideas" className={HEADING}>
        Ideas, by what they save a month
      </h2>
      <figure className="mt-2">
        <ol>
          {ideaRows(props.ideas).map((row) => (
            <IdeaBar
              key={row.index}
              row={row}
              open={open === row.index}
              onToggle={() => setOpen(open === row.index ? undefined : row.index)}
            />
          ))}
        </ol>
        <figcaption className="mt-1 text-xs text-gray-600">
          Each idea's saving a month, largest first. Tap an idea for why. Green is Spending, red is
          debt.
        </figcaption>
      </figure>
    </section>
  );
}

// --- 4. Plan ------------------------------------------------------------------------------------

export function PlanBox(props: {
  month: string;
  review: StoredReview;
  ticked: number[];
  onChanged: () => void;
}) {
  const { rows, total } = planRows(props.review);
  const [busy, setBusy] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function tick(item: number, done: boolean) {
    setBusy(item);
    const failed = await tickPlanItem(props.month, item, done);
    setBusy(undefined);
    setError(failed);
    if (failed === undefined) props.onChanged();
  }

  return (
    <section aria-labelledby="plan" className={BOX}>
      <h2 id="plan" className={HEADING}>
        {planHeading(props.month)}
      </h2>
      <ErrorLine error={error} />
      <ol className="mt-2 flex flex-col gap-2">
        {rows.map((row) => {
          const ticked = props.ticked.includes(row.item);
          return (
            <li key={row.item} className="flex items-start gap-3" data-slot="plan-item">
              <input
                id={`plan-${row.item}`}
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                checked={ticked}
                disabled={busy === row.item}
                onChange={() => void tick(row.item, !ticked)}
              />
              <label htmlFor={`plan-${row.item}`} className="min-w-0 flex-1 wrap-anywhere">
                <span
                  className={`block text-sm font-semibold ${ticked ? "line-through" : ""}`}
                  data-slot="plan-idea"
                >
                  {row.idea}
                </span>
                <span className="block text-xs text-gray-600" data-slot="plan-when">
                  {row.when}
                </span>
              </label>
              <span className="text-sm font-semibold tabular-nums">
                {wholeDollars(row.savesMonth)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex justify-between border-t border-gray-200 pt-2 text-sm">
        <span className="text-gray-600">All three</span>
        <span className="font-semibold tabular-nums" data-slot="plan-total">
          {wholeDollars(total)} a month
        </span>
      </p>
    </section>
  );
}

// --- 5. Goals -----------------------------------------------------------------------------------

function GoalStatus(props: { state: StoredReview["goals"][number]["state"] }) {
  switch (props.state) {
    case "Behind":
      return <Status tone="serious" word="Behind" />;
    case "On track":
      return <Status tone="good" word="On track" />;
    case "Done":
      return <Status tone="good" word="Done" />;
    case null:
      return null;
  }
}

function GoalMeters(props: { goals: StoredReview["goals"] }) {
  return (
    <section aria-labelledby="review-goals" className={BOX}>
      <h2 id="review-goals" className={HEADING}>
        Goals
      </h2>
      {props.goals.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">
          No Goal was active when this review was written.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3">
          {props.goals.map((goal) => (
            <li key={goal.goalId} className="wrap-anywhere" data-slot="review-goal">
              <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">“{goal.words}”</span>
                <span className="flex gap-2" data-slot="goal-status">
                  <GoalStatus state={goal.state} />
                  {goal.percentage === null ? null : <span>{percent(goal.percentage / 100)}</span>}
                </span>
              </p>
              <span aria-hidden="true" className="mt-1 block h-2 rounded bg-gray-100">
                <span
                  className={`block h-2 rounded ${goal.state === "Behind" ? "bg-orange-600" : "bg-green-600"}`}
                  data-slot="goal-meter"
                  style={{ width: `${goal.percentage ?? 0}%` }}
                />
              </span>
              <p className="mt-1 text-xs text-gray-600" data-slot="goal-detail">
                {goal.detail}
              </p>
              {goal.line === null ? null : (
                <p className="mt-1 text-sm" data-slot="goal-line">
                  {goal.line}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- 6. Budget changes and held-back Alerts -----------------------------------------------------

function BudgetChanges(props: { view: MonthlyReviewView; onChanged: () => void }) {
  return (
    <section aria-labelledby="budget-changes" className={`${BOX} min-w-0`}>
      <h2 id="budget-changes" className={HEADING}>
        Budget changes to consider
      </h2>
      {props.view.proposals.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600" data-slot="no-proposals">
          No open Proposals.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {props.view.proposals.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} onChanged={props.onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HeldBackAlerts(props: { month: string; alerts: HeldBackAlertView[]; today: string }) {
  const zone = browserZone();
  return (
    <section aria-labelledby="held-back" className={`${BOX} min-w-0`}>
      <h2 id="held-back" className={HEADING}>
        Alerts you did not get
      </h2>
      {props.alerts.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600" data-slot="none-held-back">
          The weekly cap held back no Alerts in {monthName(props.month)}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-gray-600">
            The weekly cap held these back in {monthName(props.month)}.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {props.alerts.map((alert) => (
              <li key={alert.id} className="text-sm wrap-anywhere" data-slot="held-back-alert">
                <span className="text-gray-600">
                  {dateLabel(calendarDateIn(new Date(alert.createdAt), zone), props.today)}
                </span>{" "}
                {alert.heading === null ? null : (
                  <span className="font-medium">{alert.heading}: </span>
                )}
                {alert.texts.join(" ")}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// --- One review ---------------------------------------------------------------------------------

export function ReviewReport(props: {
  view: MonthlyReviewView;
  today: string;
  onChanged: () => void;
  // The idea whose reason shows when it first draws.
  openIdea?: number;
}) {
  const { view } = props;
  return (
    <div
      className="mt-4 grid grid-cols-1 gap-4 min-[900px]:grid-cols-2 min-[900px]:items-start"
      data-slot="review-columns"
    >
      <ReviewHeader view={view} today={props.today} />
      <Habits review={view.review} />
      <IdeasChart
        ideas={view.review.ideas}
        {...(props.openIdea === undefined ? {} : { open: props.openIdea })}
      />
      <div className="flex min-w-0 flex-col gap-4">
        <PlanBox
          month={view.month}
          review={view.review}
          ticked={view.ticked}
          onChanged={props.onChanged}
        />
        <GoalMeters goals={view.review.goals} />
      </div>
      <BudgetChanges view={view} onChanged={props.onChanged} />
      <HeldBackAlerts month={view.month} alerts={view.heldBack} today={props.today} />
    </div>
  );
}

export function MonthlyReviewPage() {
  const { month = "" } = useParams();
  const [view, setView] = useState<MonthlyReviewView | null | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      setView(await loadReview(month));
      setError(undefined);
    } catch {
      setError("The review did not load.");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load again when the month changes.
  useEffect(() => {
    void load();
  }, [month]);

  return (
    <main>
      <Link className="text-sm text-blue-700 underline" to="/reviews">
        All reviews
      </Link>
      <ErrorLine error={error} />
      {view === null ? (
        <p className="mt-2" data-slot="no-review">
          No Monthly review has this month.
        </p>
      ) : view === undefined ? null : (
        <ReviewReport view={view} today={todayHere()} onChanged={() => void load()} />
      )}
    </main>
  );
}
