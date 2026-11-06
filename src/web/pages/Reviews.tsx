import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router";
import { calendarDateIn, dateLabel, percent, wholeDollars } from "../../format.ts";
import type { StoredReview } from "../../monthly-review/review-view.ts";
import type {
  HeldBackAlertView,
  MonthlyReviewView,
  ReviewListView,
} from "../../server/monthly-reviews-views.ts";
import { browserZone } from "../browser-zone.ts";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { PictureDrawing } from "../components/Picture.tsx";
import { ProposalCard } from "../components/Proposal.tsx";
import { AiMark, Status, StatusText } from "../components/Status.tsx";
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
// in the layout of the Monthly review board. Two columns on a wide screen, one on a phone. The AI
// wrote the words; the app drew every number and picture when the review was written, and the
// review never changes.

// A card, as the shared Card draws it. The sections write it inline so `aria-labelledby` comes
// first on each <section>, where the tests read it.
const CARD = "rounded-card border border-line bg-white p-4 min-[900px]:px-[22px] min-[900px]:py-5";
const HEADING = "text-lg font-bold";
// The smaller heading of the two cards side by side at the foot of the review.
const SMALL_HEADING = "text-base font-bold";
const LINK = "text-accent underline hover:text-accent-dark";

const todayHere = () => calendarDateIn(new Date(), browserZone());

// --- The list -----------------------------------------------------------------------------------

export function ReviewListReport(props: { list: ReviewListView; today: string }) {
  const { list } = props;
  return (
    <>
      {list.aiProvider ? null : (
        <Card as="div">
          <p data-slot="no-ai">
            {NO_REVIEW_WITHOUT_AI}{" "}
            <Link className={`font-semibold ${LINK}`} to={AI_SETTINGS}>
              Set up AI
            </Link>
          </p>
        </Card>
      )}
      {list.reviews.length === 0 ? (
        list.aiProvider ? (
          <Card as="div">
            <p className="text-muted" data-slot="no-reviews">
              No Monthly review yet. The first is written on the 1st.
            </p>
          </Card>
        ) : null
      ) : (
        <Card as="div" padding="list">
          <ul aria-label="Monthly reviews" className="divide-y divide-line-soft">
            {list.reviews.map((review) => (
              <li key={review.month} data-review={review.month}>
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 py-[11px]">
                  <Link
                    className="font-semibold text-ink hover:text-accent hover:underline"
                    to={`/reviews/${review.month}`}
                  >
                    {listLine(review.month)}
                  </Link>{" "}
                  <span className="text-small text-muted">
                    written {dateLabel(review.writtenOn, props.today)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
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
    <Page>
      <PageHeading title="Reviews" />
      <ErrorLine error={error} />
      {list === undefined ? null : <ReviewListReport list={list} today={todayHere()} />}
    </Page>
  );
}

// --- 1. Header ----------------------------------------------------------------------------------

const isOver = (header: StoredReview["header"]) =>
  header.budget !== null && header.spending > header.budget;

// The Spending-against-Budget bar. Its words carry its numbers, so the bar is hidden from screen
// readers. A dark mark shows the Budget; the bar runs to 125% of it so an overage shows.
function SpendingBar(props: { header: StoredReview["header"] }) {
  const { header } = props;
  return (
    <figure className="min-w-0 flex-[2_1_320px]" data-slot="spending-bar">
      <figcaption className="text-small" data-slot="spending-line">
        Spending: {spendingLine(header)}
      </figcaption>
      <div aria-hidden="true" className="relative mt-2 h-3 rounded-full bg-line">
        <div
          className={`h-3 rounded-full ${isOver(header) ? "bg-critical" : "bg-accent"}`}
          style={{ width: `${spendingShare(header) * 100}%` }}
        />
        {header.budget === null ? null : (
          <div className="absolute -top-1 h-5 w-0.5 bg-ink" style={{ left: `${100 / BAR_TOP}%` }} />
        )}
      </div>
    </figure>
  );
}

function Figure(props: { label: string; value: ReactNode; slot: string }) {
  return (
    <div className="min-w-0 flex-[1_1_120px]" data-slot={props.slot}>
      <p className="text-small font-semibold text-muted">{props.label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{props.value}</p>
    </div>
  );
}

function ReviewHeader(props: { view: MonthlyReviewView; today: string }) {
  const { review } = props.view;
  const left = leftOver(review.header);
  return (
    <section
      aria-labelledby="review-title"
      className={`${CARD} min-w-0 wrap-anywhere min-[900px]:col-span-2`}
    >
      <h1 id="review-title" className="text-small font-semibold text-muted">
        {reviewTitle(props.view.month, review.writtenOn, props.today)}
      </h1>
      <p
        className="mt-1.5 text-[22px] leading-[1.3] font-bold min-[900px]:text-title"
        data-slot="headline"
      >
        {review.headline} <AiMark />
      </p>
      <p className="mt-1.5 text-xs text-muted">
        The AI wrote the words. The app drew every number and picture.
      </p>
      <div className="mt-[18px] flex flex-wrap items-end gap-x-6 gap-y-4">
        <SpendingBar header={review.header} />
        {left === null ? null : (
          <Figure
            label="Left over"
            value={isOver(review.header) ? <StatusText tone="critical">{left}</StatusText> : left}
            slot="left-over"
          />
        )}
        <Figure label="Debt" value={wholeDollars(review.header.debt)} slot="debt" />
      </div>
    </section>
  );
}

// --- 2. Habits ----------------------------------------------------------------------------------

function HabitCard(props: { habit: StoredReview["habits"][number]; tryIdea: string | undefined }) {
  const { habit } = props;
  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-line-soft px-4 py-3.5 wrap-anywhere"
      data-slot="habit"
    >
      <div>
        <div className="flex items-baseline justify-between gap-2.5">
          <p className="min-w-0 font-semibold" data-slot="habit-name">
            {habit.name}
          </p>
          <p className="shrink-0 font-semibold tabular-nums" data-slot="cost">
            {wholeDollars(habit.costMonth)} a month
          </p>
        </div>
        <p className="mt-1 text-small text-ink-soft" data-slot="habit-line">
          {habit.line} <AiMark />
        </p>
      </div>
      <PictureDrawing picture={habit.picture} />
      {props.tryIdea === undefined ? null : (
        <p className="text-small" data-slot="habit-try">
          <b>Try:</b> {props.tryIdea}
        </p>
      )}
    </li>
  );
}

function Habits(props: { review: StoredReview }) {
  const { habits, ideas } = props.review;
  return (
    <section aria-labelledby="habits" className={`${CARD} min-w-0`}>
      <h2 id="habits" className={HEADING}>
        Habits we noticed
      </h2>
      <ul className="mt-3.5 flex flex-col gap-3">
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
    <li
      className="rounded-control has-aria-expanded:bg-page"
      data-slot="idea"
      data-kind={row.debt ? "debt" : "spending"}
    >
      <button
        type="button"
        className="grid w-full grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-2.5 gap-y-1.5 rounded-control px-1.5 py-1.5 text-left text-sm hover:bg-page focus-visible:outline-2 focus-visible:outline-accent aria-expanded:font-semibold sm:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_4rem]"
        aria-expanded={props.open}
        aria-controls={whyId}
        onClick={props.onToggle}
      >
        <span className="min-w-0 wrap-anywhere" data-slot="idea-words">
          {row.idea}
        </span>
        <span
          aria-hidden="true"
          className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1"
        >
          <span
            className={`block h-3.5 rounded-[3px] ${row.debt ? "bg-critical" : "bg-good-bar"}`}
            data-slot="idea-bar"
            style={{ width: `${Math.max(row.share * 100, 3)}%` }}
          />
        </span>
        <span
          className="col-start-2 row-start-1 text-right font-normal tabular-nums sm:col-start-3"
          data-slot="idea-saves"
        >
          {wholeDollars(row.savesMonth)}
        </span>
      </button>
      <div
        id={whyId}
        hidden={!props.open}
        className="mx-1.5 border-t border-line-soft pt-2 pb-2.5 text-sm text-ink-soft"
        data-slot="idea-why"
      >
        <p>
          <b>Why:</b> {row.why} <AiMark />
        </p>
        {row.catch === null ? null : (
          <p className="mt-1" data-slot="idea-catch">
            <b>Catch:</b> {row.catch}
          </p>
        )}
        <p className="mt-1 text-small text-muted" data-slot="idea-facts">
          {ideaFacts(row)}
        </p>
      </div>
    </li>
  );
}

export function IdeasChart(props: { ideas: StoredReview["ideas"]; open?: number }) {
  const [open, setOpen] = useState<number | undefined>(props.open);
  return (
    <section aria-labelledby="ideas" className={`${CARD} min-w-0`}>
      <h2 id="ideas" className={HEADING}>
        Ideas, by what they save a month
      </h2>
      <figure className="mt-3">
        <ol className="flex flex-col gap-0.5">
          {ideaRows(props.ideas).map((row) => (
            <IdeaBar
              key={row.index}
              row={row}
              open={open === row.index}
              onToggle={() => setOpen(open === row.index ? undefined : row.index)}
            />
          ))}
        </ol>
        <figcaption className="mt-2.5 border-t border-line-soft pt-2.5 text-small text-muted">
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
    <section aria-labelledby="plan" className={`${CARD} min-w-0`}>
      <h2 id="plan" className={HEADING}>
        {planHeading(props.month)}
      </h2>
      <ErrorLine error={error} />
      <ol className="mt-3 flex flex-col gap-2.5">
        {rows.map((row) => {
          const ticked = props.ticked.includes(row.item);
          return (
            <li key={row.item} className="flex items-start gap-2.5" data-slot="plan-item">
              <input
                id={`plan-${row.item}`}
                type="checkbox"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-accent"
                checked={ticked}
                disabled={busy === row.item}
                onChange={() => void tick(row.item, !ticked)}
              />
              <label htmlFor={`plan-${row.item}`} className="min-w-0 flex-1 wrap-anywhere">
                <span className={`block ${ticked ? "line-through" : ""}`} data-slot="plan-idea">
                  {row.idea}
                </span>
                <span className="block text-small text-muted" data-slot="plan-when">
                  {row.when}
                </span>
              </label>
              <span className="text-muted tabular-nums">{wholeDollars(row.savesMonth)}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 flex justify-between gap-3 border-t border-line-soft pt-2.5 font-bold">
        <span>All three</span>
        <span className="tabular-nums" data-slot="plan-total">
          {wholeDollars(total)} a month
        </span>
      </p>
    </section>
  );
}

// --- 5. Goals -----------------------------------------------------------------------------------

// "◆ Behind · 62%": the Goal's status with its percentage, or the percentage alone.
function GoalStatus(props: {
  state: StoredReview["goals"][number]["state"];
  percentage: number | null;
}) {
  const detail = props.percentage === null ? {} : { detail: percent(props.percentage / 100) };
  switch (props.state) {
    case "Behind":
      return <Status tone="serious" word="Behind" {...detail} />;
    case "On track":
      return <Status tone="good" word="On track" {...detail} />;
    case "Done":
      return <Status tone="good" word="Done" {...detail} />;
    case null:
      return detail.detail === undefined ? null : <span>{detail.detail}</span>;
  }
}

const GOAL_FILL = { Behind: "bg-serious", "On track": "bg-good-bar", Done: "bg-good-bar" };

function GoalMeters(props: { goals: StoredReview["goals"] }) {
  return (
    <section aria-labelledby="review-goals" className={`${CARD} min-w-0`}>
      <h2 id="review-goals" className={HEADING}>
        Goals
      </h2>
      {props.goals.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No Goal was active when this review was written.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3.5">
          {props.goals.map((goal) => (
            <li key={goal.goalId} className="wrap-anywhere" data-slot="review-goal">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                <span>“{goal.words}”</span>
                <span data-slot="goal-status">
                  <GoalStatus state={goal.state} percentage={goal.percentage} />
                </span>
              </p>
              <span aria-hidden="true" className="mt-1.5 block h-2 rounded-full bg-line">
                <span
                  className={`block h-2 rounded-full ${goal.state === null ? "bg-accent" : GOAL_FILL[goal.state]}`}
                  data-slot="goal-meter"
                  style={{ width: `${goal.percentage ?? 0}%` }}
                />
              </span>
              <p className="mt-1.5 text-small text-muted" data-slot="goal-detail">
                {goal.detail}
              </p>
              {goal.line === null ? null : (
                <p className="mt-1 text-small text-ink-soft" data-slot="goal-line">
                  {goal.line} <AiMark />
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
    <section aria-labelledby="budget-changes" className={`${CARD} min-w-0 flex-[1_1_220px]`}>
      <h2 id="budget-changes" className={SMALL_HEADING}>
        Budget changes to consider
      </h2>
      {props.view.proposals.length === 0 ? (
        <p className="mt-2.5 text-sm text-muted" data-slot="no-proposals">
          No open Proposals.
        </p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2">
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
    <section aria-labelledby="held-back" className={`${CARD} min-w-0 flex-[1_1_220px]`}>
      <h2 id="held-back" className={SMALL_HEADING}>
        Alerts you did not get
      </h2>
      {props.alerts.length === 0 ? (
        <p className="mt-2.5 text-sm text-muted" data-slot="none-held-back">
          The weekly cap held back no Alerts in {monthName(props.month)}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-small text-muted">
            The weekly cap held these back in {monthName(props.month)}.
          </p>
          <ul className="mt-2.5 flex list-disc flex-col gap-1 pl-[18px] text-sm leading-relaxed">
            {props.alerts.map((alert) => (
              <li key={alert.id} className="wrap-anywhere" data-slot="held-back-alert">
                <span className="text-muted">
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
      className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2 min-[900px]:items-start"
      data-slot="review-columns"
    >
      <ReviewHeader view={view} today={props.today} />
      <div className="flex min-w-0 flex-col gap-4" data-slot="review-column">
        <Habits review={view.review} />
        <PlanBox
          month={view.month}
          review={view.review}
          ticked={view.ticked}
          onChanged={props.onChanged}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4" data-slot="review-column">
        <IdeasChart
          ideas={view.review.ideas}
          {...(props.openIdea === undefined ? {} : { open: props.openIdea })}
        />
        <GoalMeters goals={view.review.goals} />
        <div className="flex flex-wrap gap-4">
          <BudgetChanges view={view} onChanged={props.onChanged} />
          <HeldBackAlerts month={view.month} alerts={view.heldBack} today={props.today} />
        </div>
      </div>
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
    <Page width="wide">
      <Link className="self-start text-small text-accent hover:text-accent-dark" to="/reviews">
        <span aria-hidden="true">← </span>All reviews
      </Link>
      <ErrorLine error={error} />
      {view === null ? (
        <Card as="div">
          <p data-slot="no-review">No Monthly review has this month.</p>
        </Card>
      ) : view === undefined ? null : (
        <ReviewReport view={view} today={todayHere()} onChanged={() => void load()} />
      )}
    </Page>
  );
}
