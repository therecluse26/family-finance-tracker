import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Bar,
  BarChart,
  type BarShapeProps,
  Line,
  LineChart,
  Rectangle,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { STATUS_ICON, wholeDollars } from "../../format.ts";
import type {
  AiBoxGroupName,
  AiBoxInsightCardView,
  AiBoxNoteView,
  AiBoxReviewLinkView,
  AiBoxView,
} from "../../server/ai-box-views.ts";
import type { HistoryStatusView, NumberTilesView } from "../../server/bank-views.ts";
import type { BudgetsView, UsualMonthView } from "../../server/budgets-views.ts";
import type { ComingUpView } from "../../server/coming-up-views.ts";
import type { FinishSetupItem } from "../../server/setup-views.ts";
import {
  markAlertNoteDone,
  markInsightCardDone,
  NOTHING_NEW,
  pausedLine,
  SET_UP_AI,
  worthActingOnHeading,
} from "../ai-box.ts";
import { BUDGET_LINE_COLOR, FULL_COLOR, MUTED_COLOR, TREND_COLOR } from "../chart-colors.ts";
import { askAboutAlertNote, askAboutInsightCard, askAboutPath, askAboutProposal } from "../chat.ts";
import { buttonClass } from "../components/Button.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { NoticeList } from "../components/NoticeLines.tsx";
import { Page } from "../components/Page.tsx";
import { Picture } from "../components/Picture.tsx";
import { ProposalCard } from "../components/Proposal.tsx";
import { AiMark, Status, TONE_COLOR } from "../components/Status.tsx";
import {
  barShare,
  closeNotice,
  comingUpRow,
  type DashboardData,
  type DashboardMonth,
  dashboardMonth,
  type GroupBar,
  type GroupBudgetRow,
  groupBars,
  groupBudgetRows,
  groupStatus,
  headerLine,
  type LeftToSpend,
  leftText,
  leftToSpend,
  loadDashboard,
  loadHistoryStatus,
  lowestLine,
  meterLine,
  monthName,
  type NumberTile,
  numberTiles,
  paceLine,
  projectedSpending,
  readHistoryAgain,
  retryHistoryJobs,
  rowNote,
  type StatusLines,
  statusLines,
  tileDirection,
  type UsualGroup,
  usualMonthLine,
  type YearlyRow,
  yearlyLine,
} from "../dashboard.ts";
import {
  ADD_GOAL_PATH,
  AI_SETTINGS,
  activeGoals,
  type GoalsAnswer,
  onTrackLine,
  WAITS_FOR_HISTORY,
} from "../goals.ts";
import { markReviewLinkDone, reviewLinkTitle } from "../monthly-review.ts";
import { answerOrder, type PollPlan, type PollState, usePolling } from "../polling.ts";
import { reportsPath } from "../reports.ts";
import { SignedOut } from "../requests.ts";
import { FINISH_SETUP_LINKS } from "../setup-gate.ts";
import { transactionsPath } from "../transactions.ts";
import { BEFORE_FIRST_DRAFT } from "./Budgets.tsx";
import { GoalCard, NeedsAiLink } from "./Goals.tsx";
import { UpdateMode } from "./settings/Connections.tsx";

// The dashboard (spec 07, The dashboard): the header, the status lines, then a box for each part.
// From 900 px wide, the AI box is the left column and stays in view while the right column
// scrolls. Narrower, every box stacks in one column, the AI box first.

// A box: the shared Card's look. The boxes carry the `data-slot` and aria names their tests and
// screen readers use, which Card does not pass on yet, so they take its classes here.
const BOX = "rounded-card border border-line bg-white p-4 min-[900px]:px-[22px] min-[900px]:py-5";
// The small grey name at the top of a box, kept as its heading.
const BOX_LABEL = "text-small font-semibold text-muted";
// A box's big number.
const BIG =
  "mt-1 block text-[28px] leading-tight font-bold tracking-[-.01em] tabular-nums min-[900px]:text-[34px]";
const TEXT_LINK = "text-accent underline hover:text-accent-dark";

// The month and the sync line. On a phone they sit in a white bar across the top of the screen;
// from 900 px they sit on the page. The <h1> is drawn once, before the page has read anything,
// and keeps its place, so the focus the shell puts on it after a menu choice stays there. It says
// "Dashboard" until the Household's month is known.
export function DashboardHeader(props: { month?: DashboardMonth; line?: string }) {
  return (
    <header
      className="-mx-4 -mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line bg-white px-4 py-3.5 min-[900px]:m-0 min-[900px]:gap-x-3 min-[900px]:border-0 min-[900px]:bg-transparent min-[900px]:p-0"
      data-slot="dashboard-header"
    >
      <h1 className="text-[22px] font-bold min-[900px]:text-[28px]">
        {props.month?.name ?? "Dashboard"}
      </h1>
      {props.line === undefined ? null : (
        <p className="text-small text-muted min-[900px]:text-[15px]">{props.line}</p>
      )}
    </header>
  );
}

// --- Status lines ------------------------------------------------------------------------------

// A broken Connection's Repair: update mode while it needs a Member, or "Link again" in Settings →
// Banks once it is Broken (spec 02, Repair).
function Repair(props: { banner: StatusLines["repairs"][number]; onChanged: () => void }) {
  const { connection } = props.banner;
  if (connection === undefined || connection.removed || !connection.actions.repairInApp) {
    return null;
  }
  if (connection.health === "needs a member") {
    return <UpdateMode connection={connection} addAccounts={false} onChanged={props.onChanged} />;
  }
  return (
    <Link
      className="inline-flex h-[38px] items-center rounded-control bg-critical px-4 text-sm font-semibold text-white hover:bg-[#912018] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-critical"
      to="/settings/banks"
    >
      Repair
    </Link>
  );
}

// The "Finish setup" list: Banks while the Household has no Connection, and each optional extra
// (AI, Alerts, Invite Members) until it is done, with a link to where it is done (spec 12, The
// "Finish setup" list). Every Member sees it.
export function FinishSetupList(props: { steps: readonly FinishSetupItem[] }) {
  if (props.steps.length === 0) return null;
  return (
    <section
      aria-labelledby="finish-setup"
      className="rounded-card border border-line bg-white p-4 min-[900px]:px-6 min-[900px]:py-5"
      data-slot="finish-setup"
    >
      <h2 id="finish-setup" className="font-semibold">
        Finish setup
      </h2>
      <ul className="mt-2.5 flex flex-wrap gap-2.5">
        {props.steps.map((step) => (
          <li key={step}>
            <Link
              className="inline-flex min-h-10 items-center rounded-full border border-field bg-white px-3.5 py-1 text-sm text-ink hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              to={FINISH_SETUP_LINKS[step].path}
            >
              {FINISH_SETUP_LINKS[step].label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StatusLineList(props: {
  lines: StatusLines;
  // The "Finish setup" list: Banks while the Household has no Connection, and the extras not done.
  finishSetup?: ReactNode;
  onClose: (id: string) => void;
  // Retry on the notice of a stopped First run or bank-added-later job.
  onRetry: () => void;
  onChanged: () => void;
  // Whether the page still reads the history loading progress again (HISTORY_POLL).
  live?: PollState;
}) {
  const { repairs, loading, others } = props.lines;
  // The lines take their places in the page's column of boxes, 16 px apart, so the wrapper draws
  // no box of its own. The shared notice list keeps a top margin from before the column had gaps.
  return (
    <div className="contents [&>ul]:mt-0" data-slot="status-lines">
      {repairs.length === 0 ? null : (
        <ul aria-label="Broken Connections" className="flex flex-col gap-3">
          {repairs.map((banner) => (
            <li
              key={banner.notice.id}
              className="flex flex-wrap items-center gap-3 rounded-card border border-[#FECDCA] bg-[#FEF3F2] px-4 py-3.5 min-[900px]:px-5 min-[900px]:py-4"
            >
              <span className="min-w-[min(15rem,100%)] flex-1">
                <span aria-hidden="true" className={TONE_COLOR.critical}>
                  {STATUS_ICON.critical}{" "}
                </span>
                {banner.notice.text}
              </span>
              <span>
                <Repair banner={banner} onChanged={props.onChanged} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {loading.length === 0 ? null : (
        <section
          aria-labelledby="history-loading"
          className="rounded-card border border-line bg-white p-4 min-[900px]:px-6 min-[900px]:py-[22px]"
          data-slot="history-loading"
        >
          <header className="flex flex-wrap items-center gap-2.5">
            <h2 id="history-loading" className="flex-1 text-lg font-semibold">
              Your history is loading
            </h2>
            {props.live === "polling" ? (
              <span className="inline-flex items-center gap-1.5 text-small text-muted">
                <span aria-hidden="true" className="size-2 rounded-full bg-good-bar" />
                Live
              </span>
            ) : null}
          </header>
          <p className="mt-1 text-sm text-muted">
            Numbers on this page grow as each bank sends older Transactions. The app tells you when
            all of it is in.
          </p>
          <ul aria-label="History loading" className="mt-4 flex flex-col gap-3">
            {loading.map((line) => (
              <li
                key={line.connectionId}
                className="flex flex-wrap items-baseline justify-between gap-x-2"
              >
                <span className="font-semibold">{line.bankName}</span>{" "}
                <span className="text-ink-soft tabular-nums">{line.text}</span>
              </li>
            ))}
          </ul>
          {props.live === "gave up" ? (
            <p className="mt-3 text-small text-muted">
              This page stopped checking. Reload it to see newer progress.
            </p>
          ) : null}
        </section>
      )}
      {props.finishSetup ?? null}
      <NoticeList
        notices={others.map(({ id, text, closable, retryHistoryJob }) => ({
          id,
          text,
          closable,
          retry: retryHistoryJob,
        }))}
        onClose={props.onClose}
        onRetry={props.onRetry}
      />
    </div>
  );
}

// --- Left to spend -----------------------------------------------------------------------------

function YearlyBudgetRow(props: { row: YearlyRow }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-2">
      <span>{props.row.category}</span>
      <span className="text-muted tabular-nums">
        {yearlyLine(props.row)}
        {props.row.overBudget ? (
          <>
            {" "}
            <Status tone="critical" word="Over Budget" />
          </>
        ) : null}
      </span>
    </li>
  );
}

export function LeftToSpendBox(props: { left: LeftToSpend; month: DashboardMonth }) {
  const { left, month } = props;
  return (
    <section aria-labelledby="left-to-spend" className={BOX} data-slot="left-to-spend">
      <h2 id="left-to-spend" className={BOX_LABEL}>
        Left to spend in {month.name}
      </h2>
      {left.drafted ? (
        <LeftToSpendNumbers left={left} month={month} />
      ) : (
        <p className="mt-1 text-ink-soft">{BEFORE_FIRST_DRAFT}</p>
      )}
    </section>
  );
}

function LeftToSpendNumbers(props: {
  left: Extract<LeftToSpend, { drafted: true }>;
  month: DashboardMonth;
}) {
  const { left, month } = props;
  const big = leftText(left.left);
  const pace = left.projected === null ? undefined : paceLine(left.budget, left.projected);
  const spent = barShare(left.spending, left.budget);
  const gone = month.day / month.days;
  return (
    <>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-3">
        <span
          className="text-[32px] leading-tight font-bold tracking-[-.01em] tabular-nums min-[900px]:text-[34px]"
          data-slot="left"
        >
          {big.text}
        </span>
        {big.over ? (
          <span className="font-semibold">
            <Status tone="critical" word="Over Budget" />
          </span>
        ) : null}
      </p>
      {pace === undefined ? null : (
        <p
          className={`mt-0.5 text-small font-semibold min-[900px]:text-[15px] ${TONE_COLOR[pace.tone]}`}
          data-slot="pace"
        >
          <span aria-hidden="true">{STATUS_ICON[pace.tone]} </span>
          {pace.text}
        </p>
      )}
      <div
        aria-hidden="true"
        className="relative mt-3.5 h-2.5 rounded-full bg-line min-[900px]:h-3"
        data-slot="month-meter"
      >
        <div
          className={`h-full rounded-full ${big.over ? "bg-critical" : "bg-accent"}`}
          style={{ width: `${spent * 100}%` }}
        />
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-ink"
          data-slot="today"
          style={{ left: `${gone * 100}%` }}
          title="Today"
        />
      </div>
      <p className="mt-2 text-small text-muted tabular-nums" data-slot="meter-line">
        {meterLine(left.spending, left.budget, month)}
      </p>
      {left.yearly.length === 0 ? null : (
        <ul
          aria-label="Yearly Budgets"
          className="mt-3.5 flex flex-col gap-1.5 border-t border-line-soft pt-3 text-sm"
        >
          {left.yearly.map((row) => (
            <YearlyBudgetRow key={row.category} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}

// --- Goals -------------------------------------------------------------------------------------

// The active Goals (spec 07, 3. Goals): "N of M on track", then one equal-height box per Goal in a
// row. In a narrow box, as on a phone, the boxes stack. The heading has "Add a Goal", which opens
// the Goals page's form, or, with no AI provider, says that Goals need one and links to the AI
// settings. Until history has loaded, it says that Goals wait for it.
export function GoalsBox(props: { answer: GoalsAnswer }) {
  const active = activeGoals(props.answer.goals);
  return (
    <section aria-labelledby="goals" className={`${BOX} @container`} data-slot="goals">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1">
        <h2 id="goals" className="text-heading font-bold">
          Goals
          {/* A space, so a screen reader reads "Goals, 2 of 3 on track" as two words. */}
          {active.length === 0 ? null : " "}
          {active.length === 0 ? null : (
            <span className="ml-1.5 text-small font-normal text-muted" data-slot="on-track">
              {onTrackLine(active)}
            </span>
          )}
        </h2>
        {!props.answer.aiProvider ? (
          <NeedsAiLink />
        ) : props.answer.waitsForHistory ? (
          <span className="text-small text-muted" data-slot="goals-wait">
            {WAITS_FOR_HISTORY}
          </span>
        ) : (
          <Link
            className="text-small text-accent hover:text-accent-dark hover:underline"
            data-slot="add-goal"
            to={ADD_GOAL_PATH}
          >
            Add a Goal
          </Link>
        )}
      </div>
      {active.length === 0 ? null : (
        <ul
          aria-label="Active Goals"
          className="mt-3 grid grid-cols-1 gap-3 @min-[480px]:auto-cols-fr @min-[480px]:grid-flow-col"
          data-slot="goal-boxes"
        >
          {active.map((goal) => (
            <li
              key={goal.id}
              className="min-w-0 rounded-[10px] border border-line-soft px-4 py-3.5"
            >
              <GoalCard goal={goal} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Number tiles ------------------------------------------------------------------------------

// A tile's trend line: 12 points, drawn by the app from its own data. The tile's words carry its
// meaning, so the line is hidden from screen readers.
function TrendLine(props: { trend: NumberTile["tile"]["trend"] }) {
  return (
    <div aria-hidden="true" className="mt-1.5 h-7 w-full" data-slot="trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          accessibilityLayer={false}
          data={props.trend}
          margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        >
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            dataKey="amount"
            type="monotone"
            stroke={TREND_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function NumberTileItem(props: { tile: NumberTile }) {
  const { tile } = props;
  const direction = tileDirection(tile);
  return (
    <li
      className="min-w-0 rounded-card border border-line bg-white"
      data-slot="tile"
      data-tile={tile.key}
    >
      <Link
        className="block h-full rounded-card p-3 hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent min-[900px]:px-[18px] min-[900px]:py-4"
        to={tile.to}
      >
        <span className="block text-small font-semibold text-muted">{tile.label}</span>
        <span
          className="mt-0.5 block text-xl font-bold tabular-nums min-[900px]:mt-1 min-[900px]:text-2xl"
          data-slot="tile-amount"
        >
          {wholeDollars(tile.tile.amount)}
        </span>
        {direction === undefined ? null : (
          <span className={`block text-sm ${TONE_COLOR[direction.tone]}`}>{direction.text}</span>
        )}
        <TrendLine trend={tile.tile.trend} />
        {tile.note === undefined ? null : (
          <span className="block text-xs text-muted">{tile.note}</span>
        )}
      </Link>
    </li>
  );
}

// Four tiles in a row, two by two on a phone (spec 07, 4. Number tiles), each in its own box, as in
// prototype variant H. The space they share, not the screen, sets the columns: from 900 px the
// right column can be narrower than a phone. Four in a row need a 760 px box, so each tile keeps
// its label and direction on one line; in the 1,280 px dashboard's right column they sit two by
// two, as on the approved dashboard board.
export function NumberTilesBox(props: { tiles: NumberTilesView }) {
  return (
    <section aria-label="Number tiles" className="@container" data-slot="number-tiles">
      <ul
        aria-label="Number tiles"
        className="grid grid-cols-2 gap-3 @min-[760px]:grid-cols-4"
        data-slot="tiles"
      >
        {numberTiles(props.tiles).map((tile) => (
          <NumberTileItem key={tile.key} tile={tile} />
        ))}
      </ul>
    </section>
  );
}

// --- "A usual month" ---------------------------------------------------------------------------

// The dashed mark at a month's Budget, across its bar. A month with no Budget has none.
function BudgetMark(props: BarShapeProps) {
  const { x, y, width, payload } = props;
  if ((payload as GroupBar | undefined)?.budget == null) return <g />;
  return (
    <line
      x1={x}
      x2={x + width}
      y1={y}
      y2={y}
      stroke={BUDGET_LINE_COLOR}
      strokeWidth={1.5}
      strokeDasharray="3 3"
    />
  );
}

// This month in full color; the 12 complete months muted.
function SpendingBar(props: BarShapeProps) {
  const current = (props.payload as GroupBar | undefined)?.current === true;
  return <Rectangle {...props} fill={current ? FULL_COLOR : MUTED_COLOR} />;
}

// A group's 13 bars, and the dashed line at its Budget. The budget marks sit on their own hidden
// axis, so each one lies across its month's bar.
function GroupChart(props: { bars: GroupBar[] }) {
  return (
    <div aria-hidden="true" className="mt-1.5 h-10 w-full" data-slot="group-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          accessibilityLayer={false}
          data={props.bars}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <XAxis dataKey="label" hide />
          <XAxis dataKey="label" xAxisId="budget" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Bar dataKey="spending" shape={SpendingBar} isAnimationActive={false} />
          <Bar dataKey="budget" xAxisId="budget" shape={BudgetMark} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// A group with no Spending in any of its 13 months and no Budget line has nothing to draw: its
// chart would be an empty frame. It says so instead.
function emptyChartLine(bars: GroupBar[]): string | undefined {
  if (bars.some((bar) => bar.spending !== 0 || bar.budget != null)) return undefined;
  const first = bars[0];
  return first === undefined ? "No Spending yet" : `No Spending since ${first.label}`;
}

// A group: on a phone (under 900 px) in a box under 480 px, a compact row (its name and
// "$spent of $Budget", its status at the right), as on the approved phone dashboard board.
// Everywhere else, a box with its 13-bar chart (spec 07, section 5), so the narrow right column
// from 900 px keeps the charts. The chart stays drawn in a compact row, clipped to no height, so
// its chart library always has a width to measure.
function GroupBox(props: {
  group: UsualGroup;
  view: BudgetsView;
  month: DashboardMonth;
  open: boolean;
  onOpen: () => void;
}) {
  const { group, view, month } = props;
  const box = view.groups.find((each) => each.categoryGroup === group.categoryGroup);
  const status = groupStatus(box);
  const spent = box?.spending ?? 0;
  const budget = box?.monthly ?? 0;
  const bars = groupBars(group, month);
  const empty = emptyChartLine(bars);
  return (
    <li
      className={`min-w-0 border-t border-line-soft min-[900px]:rounded-[10px] min-[900px]:border @min-[480px]:rounded-[10px] @min-[480px]:border ${props.open ? "max-[900px]:@max-[480px]:bg-selected min-[900px]:border-accent @min-[480px]:border-accent" : ""}`}
      data-group={group.categoryGroup}
    >
      <button
        type="button"
        aria-expanded={props.open}
        className="flex w-full items-baseline justify-between gap-x-3 px-1.5 py-2 text-left hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent min-[900px]:block min-[900px]:rounded-t-[10px] min-[900px]:px-3 min-[900px]:pt-3 min-[900px]:pb-0 @min-[480px]:block @min-[480px]:rounded-t-[10px] @min-[480px]:px-3 @min-[480px]:pt-3 @min-[480px]:pb-0"
        onClick={props.onOpen}
      >
        <span className="block min-w-0">
          <span className="block text-sm font-semibold">{group.categoryGroup}</span>
          <span className="mt-0.5 block text-small text-muted tabular-nums" data-slot="group-line">
            {budget > 0
              ? `${wholeDollars(spent)} of ${wholeDollars(budget)}`
              : (box?.yearly ?? 0) > 0
                ? `${wholeDollars(spent)}, no monthly Budget`
                : `${wholeDollars(spent)}, no Budget`}
          </span>
        </span>
        {status === undefined ? null : (
          <span className="block shrink-0 text-right text-small min-[900px]:mt-0.5 min-[900px]:text-left @min-[480px]:mt-0.5 @min-[480px]:text-left">
            <Status {...status} />
          </span>
        )}
      </button>
      {/* The chart opens the group too; the button above is the way in for a keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the button above does the same. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the button above takes the keyboard. */}
      <div
        className="cursor-pointer px-3 pb-3 max-[900px]:@max-[480px]:invisible max-[900px]:@max-[480px]:h-0 max-[900px]:@max-[480px]:overflow-hidden max-[900px]:@max-[480px]:p-0"
        data-slot="group-chart-area"
        onClick={props.onOpen}
      >
        {empty === undefined ? (
          <GroupChart bars={bars} />
        ) : (
          <p className="mt-1.5 flex h-10 items-end text-small text-muted" data-slot="group-empty">
            {empty}
          </p>
        )}
      </div>
    </li>
  );
}

// A thin meter of a Category's Spending against its Budget. Only a flexible Category gets a
// "today" tick.
function RowMeter(props: { row: GroupBudgetRow; month: DashboardMonth }) {
  const { row, month } = props;
  const amount = row.budget?.amount ?? 0;
  const over = row.budget?.status === "Over Budget";
  return (
    <div
      aria-hidden="true"
      className="relative mt-1 h-1.5 rounded-full bg-line"
      data-slot="row-meter"
    >
      <div
        className={`h-1.5 rounded-full ${over ? "bg-critical" : "bg-accent"}`}
        style={{ width: `${barShare(row.spending, amount) * 100}%` }}
      />
      {row.flexible ? (
        <div
          className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-ink"
          data-slot="today"
          style={{ left: `${(month.day / month.days) * 100}%` }}
          title="Today"
        />
      ) : null}
    </div>
  );
}

function GroupBudgetRowItem(props: { row: GroupBudgetRow; month: DashboardMonth }) {
  const { row, month } = props;
  const note = rowNote(row);
  return (
    <li data-category={row.category}>
      <Link
        className="block rounded-control px-1.5 py-1.5 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent"
        to={transactionsPath({ category: row.category, month: month.month })}
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-medium">{row.category}</span>
          <span className="tabular-nums">
            {row.budget === undefined ? (
              <>
                {wholeDollars(row.spending)} <span className="text-muted">no Budget</span>
              </>
            ) : (
              `${wholeDollars(row.spending)} / ${wholeDollars(row.budget.amount)}`
            )}
            {note === undefined ? null : (
              <>
                {" "}
                <Status {...note} />
              </>
            )}
          </span>
        </span>
        {row.budget === undefined ? null : <RowMeter row={row} month={month} />}
        {row.budget?.context == null ? null : (
          <span className="mt-0.5 block text-xs text-muted">{row.budget.context}</span>
        )}
      </Link>
    </li>
  );
}

export function UsualMonthBox(props: {
  usual: UsualMonthView;
  budgets: BudgetsView;
  month: DashboardMonth;
  // The group whose Budgets show when the box first draws.
  initialOpen?: string;
}) {
  const { usual, budgets, month } = props;
  const [open, setOpen] = useState<string | undefined>(props.initialOpen);
  const projected = projectedSpending(budgets.groups);
  const line = projected === null ? undefined : usualMonthLine(month, projected, usual.usual);
  const shown = usual.groups.find((group) => group.categoryGroup === open);
  // Whether any group's chart draws a dashed Budget line (BudgetMark draws one per bar with a Budget).
  const budgetLine = usual.groups.some((group) => group.bars.some((bar) => bar.budget != null));
  return (
    <section aria-labelledby="usual-month" className={`${BOX} @container`} data-slot="usual-month">
      <h2 id="usual-month" className={BOX_LABEL}>
        A usual month
      </h2>
      <p className={BIG} data-slot="usual">
        {usual.usual === null ? "No complete month yet" : wholeDollars(usual.usual)}
      </p>
      {line === undefined ? null : (
        <p className="mt-0.5 text-small">
          <span className={TONE_COLOR[line.tone]} data-slot="usual-line">
            {line.text}
          </span>
        </p>
      )}
      <ul
        aria-label="Category groups"
        className="mt-3 grid grid-cols-1 min-[900px]:mt-3.5 min-[900px]:gap-2.5 @min-[480px]:mt-3.5 @min-[480px]:grid-cols-3 @min-[480px]:gap-2.5"
        data-slot="groups"
      >
        {usual.groups.map((group) => (
          <GroupBox
            key={group.categoryGroup}
            group={group}
            view={budgets}
            month={month}
            open={open === group.categoryGroup}
            onOpen={() => setOpen(group.categoryGroup)}
          />
        ))}
      </ul>
      {/* The charts are hidden from screen readers, and each group's words say what they show, so
          the key to the charts is hidden too. It names the dashed line only once a chart draws one,
          and goes with the charts in a compact row. */}
      {usual.groups.length === 0 ? null : (
        <p className="mt-2.5 text-small text-muted" data-slot="chart-key">
          <span
            aria-hidden="true"
            className="max-[900px]:@max-[480px]:hidden"
            data-slot="chart-key-bars"
          >
            Grey bars: the last 12 months. Blue: {month.name} so far.
            {budgetLine ? " Dashed line: the Budget." : ""}
          </span>{" "}
          Choose a group to see its Budgets.
        </p>
      )}
      {shown === undefined ? null : (
        <section
          aria-label={`${shown.categoryGroup} Budgets`}
          className="mt-3.5 border-t border-line-soft pt-3"
          data-slot="group-budgets"
        >
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="flex-1 text-sm font-semibold">{shown.categoryGroup} Budgets</h3>
            <Link
              className={`text-small ${TEXT_LINK}`}
              data-slot="group-report"
              to={reportsPath("spending", { range: "12m", group: shown.categoryGroup })}
            >
              {`${shown.categoryGroup} over time`}
            </Link>
            <button
              type="button"
              className={`text-small ${TEXT_LINK}`}
              onClick={() => setOpen(undefined)}
            >
              Close
            </button>
          </div>
          <ul
            aria-label={`${shown.categoryGroup} Budgets`}
            className="mt-1.5 flex flex-col gap-0.5"
          >
            {groupBudgetRows(shown, budgets).map((row) => (
              <GroupBudgetRowItem key={row.category} row={row} month={month} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

// --- Coming up -------------------------------------------------------------------------------

// What is due from tomorrow to 14 days from today (spec 07, 6. Coming up). The rows show cents;
// the big number is a total, in whole dollars. Tapping the box opens the Recurring charges page.
// A narrow box shows each row on two lines; a wide one, a table.
const DUE_HEAD = "border-b border-line px-1.5 py-2 font-semibold first:pl-0 last:pr-0";
const DUE_CELL = "border-b border-line-soft px-1.5 py-[9px] tabular-nums first:pl-0 last:pr-0";

// Below 900 px, as on the approved phone dashboard board, the box shows its first rows and a
// button under the box's link that shows the rest in place: the rows hold paydays and payments
// due that the Recurring charges page does not list.
const PHONE_DUE_ROWS = 3;

export function ComingUpBox(props: { view: ComingUpView; month: DashboardMonth }) {
  const { view, month } = props;
  const [all, setAll] = useState(false);
  const listId = useId();
  const tableId = useId();
  const lowest = lowestLine(view, month.today);
  const rows = view.rows.map((each, index) => ({
    key: `${each.kind}-${each.date}-${each.what}`,
    kind: each.kind,
    // A row past the first few, hidden below 900 px until "All N items".
    folded: !all && index >= PHONE_DUE_ROWS ? "max-[899px]:hidden" : "",
    ...comingUpRow(each, month.today),
  }));
  return (
    // The whole box is the link, so the whole box shows the hover.
    <section
      aria-labelledby="coming-up"
      className={`${BOX} @container has-[a:hover]:bg-page`}
      data-slot="coming-up"
    >
      <Link
        className="block rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        to="/recurring-charges"
      >
        <h2 id="coming-up" className={BOX_LABEL}>
          Due in the next 14 days
        </h2>
        <span className={BIG} data-slot="due-total">
          {wholeDollars(view.outgoing)}
        </span>
        {lowest === undefined ? null : (
          <span className="mt-0.5 block text-small text-ink-soft" data-slot="lowest">
            {lowest}
          </span>
        )}
        {/* In a box under 360 px, as at 900 px or on a phone, each row takes two lines: the date
            and what, then the amount and the checking balance after it. From 360 px, a table. */}
        <ul
          id={listId}
          aria-label="Due rows"
          className="mt-2.5 text-sm @min-[360px]:hidden"
          data-slot="due-lines"
        >
          {rows.map((row) => (
            <li
              key={row.key}
              className={`border-t border-line-soft py-[7px] ${row.payday ? "font-semibold" : ""} ${row.folded}`}
              data-row={row.kind}
            >
              <span className="flex gap-2">
                {/* At least 52 px, and wider for a date with its year, as across New Year. */}
                <span
                  className="min-w-[52px] shrink-0 font-normal whitespace-nowrap text-muted"
                  data-slot="due-date"
                >
                  {row.date}
                </span>
                <span className="min-w-0 flex-1 break-words">{row.what}</span>
              </span>
              <span className="flex justify-end gap-3 tabular-nums">
                <span>{row.amount}</span>
                <span className="font-normal text-muted">{row.checkingAfter}</span>
              </span>
            </li>
          ))}
        </ul>
        <table
          id={tableId}
          className="mt-3 hidden w-full text-sm @min-[360px]:table"
          data-slot="due-rows"
        >
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className={DUE_HEAD}>Date</th>
              <th className={DUE_HEAD}>What</th>
              <th className={`${DUE_HEAD} text-right`}>Amount</th>
              <th className={`${DUE_HEAD} text-right`}>Checking after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={`${row.payday ? "font-semibold" : ""} ${row.folded}`.trim() || undefined}
                data-row={row.kind}
              >
                <td className={DUE_CELL}>{row.date}</td>
                <td className={DUE_CELL}>{row.what}</td>
                <td className={`${DUE_CELL} text-right`}>{row.amount}</td>
                <td
                  className={`${DUE_CELL} text-right ${row.checkingAfter === "on card" ? "text-muted" : ""}`}
                >
                  {row.checkingAfter}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Link>
      {rows.length <= PHONE_DUE_ROWS ? null : (
        <button
          type="button"
          aria-controls={`${listId} ${tableId}`}
          aria-expanded={all}
          className={`mt-2 text-small ${TEXT_LINK} min-[900px]:hidden`}
          data-slot="due-all"
          onClick={() => setAll(!all)}
        >
          {all ? "Fewer items" : `All ${rows.length} items`}
        </button>
      )}
    </section>
  );
}

// --- AI box ------------------------------------------------------------------------------------

// The outlined small button; 40 px tall below 900 px, as on the phone board, so a thumb finds it.
const NOTE_BUTTON = `${buttonClass("outlined", "small")} max-[899px]:h-10 max-[899px]:text-sm`;
// One row of the AI box: a line above it, the number column at the left.
const NOTE_ROW = "flex gap-3.5 border-t border-line-soft py-3.5 wrap-anywhere";
// The number column. It grows to fit its number, such as "$12,450.00", which never breaks.
const NOTE_FIGURE = "min-w-20 max-w-32 shrink-0";

// A group's status word and its count, such as "◆ Worth acting on · 2".
function GroupStatus(props: { name: AiBoxGroupName; count: number }) {
  const detail = String(props.count);
  switch (props.name) {
    case "Worth acting on":
      return <Status tone="serious" word="Worth acting on" detail={detail} />;
    case "Heads up":
      return <Status tone="accent" word="Heads up" detail={detail} />;
    case "Good news":
      return <Status tone="good" word="Good news" detail={detail} />;
  }
}

// One note: its number and label, what it is about and its title, "Why?" that opens the reason in
// place, the AI's Next step when there is one, and "Done" and "Ask about this". A done note fades
// and stays until it leaves the box. An Insight card is the AI's words throughout, with the "AI"
// mark; its picture shows under "Why?", and a Good news card's last words say what the news means,
// with no "Next step:" label.
function AiNote(props: {
  note: AiBoxNoteView | AiBoxInsightCardView;
  goodNews: boolean;
  busy: boolean;
  onDone: (done: boolean) => void;
  // "Ask about this": a new Chat thread with the note attached, an Alert note or an Insight card.
  onAsk?: () => void;
  whyOpen?: boolean;
}) {
  const { note } = props;
  const [whyOpen, setWhyOpen] = useState(props.whyOpen ?? false);
  const whyId = useId();
  const card = note.kind === "Insight card" ? note : undefined;
  return (
    <li className={`${NOTE_ROW} ${note.done ? "opacity-50" : ""}`} data-slot="ai-note">
      <div className={NOTE_FIGURE} data-slot="note-figure">
        <p className="text-xl font-bold whitespace-nowrap tabular-nums" data-slot="note-number">
          {note.figure}
        </p>
        <p className="text-xs text-muted">{note.figureLabel}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-small text-muted" data-slot="note-about">
          {note.about}
        </p>
        <p className="mt-0.5 font-semibold" data-slot="note-title">
          {note.title}
          {card === undefined ? null : (
            <>
              {" "}
              <AiMark />
            </>
          )}
        </p>
        <button
          type="button"
          className={`text-small ${TEXT_LINK}`}
          aria-expanded={whyOpen}
          aria-controls={whyId}
          onClick={() => setWhyOpen(!whyOpen)}
        >
          {whyOpen ? "Hide why" : "Why?"}
        </button>
        <div
          id={whyId}
          hidden={!whyOpen}
          className="mt-1 text-small text-ink-soft"
          data-slot="note-why"
        >
          {note.kind === "Alert note" ? (
            note.why.map((line, part) => (
              // Two parts of a merged Alert may read the same, so each line is keyed by its place.
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
              <p key={part}>{line}</p>
            ))
          ) : (
            <>
              <p>
                {note.why} <AiMark />
              </p>
              {/* Drawn when "Why?" opens, so a closed card asks for no picture. */}
              {note.picture === null ? null : (
                <div className="mt-1" data-slot="note-picture">
                  {whyOpen ? <Picture choice={note.picture} month={note.month} /> : null}
                </div>
              )}
            </>
          )}
        </div>
        {note.nextStep === null ? null : (
          <p className="mt-1.5 text-small text-ink-soft" data-slot="next-step">
            {card !== undefined && props.goodNews ? null : (
              <>
                <span className="font-semibold text-ink">Next step:</span>{" "}
              </>
            )}
            {note.nextStep} <AiMark />
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={NOTE_BUTTON}
            aria-pressed={note.done}
            disabled={props.busy}
            onClick={() => props.onDone(!note.done)}
          >
            {note.done ? "Done ✓" : "Done"}
          </button>
          <button
            type="button"
            className={NOTE_BUTTON}
            disabled={props.onAsk === undefined}
            onClick={props.onAsk}
          >
            Ask about this
          </button>
        </div>
      </div>
    </li>
  );
}

// The Monthly review's link (spec 07, 1. AI box): "Your <Month> review is ready", linking to the
// review. Done marks it for every Member, and it leaves the box.
function ReviewLinkNote(props: { note: AiBoxReviewLinkView; busy: boolean; onDone: () => void }) {
  return (
    <li className={NOTE_ROW} data-slot="review-link">
      {/* The month in short, as the other notes show a number; the link says it in full. */}
      <div aria-hidden="true" className={NOTE_FIGURE}>
        <p className="text-xl font-bold">{monthName(props.note.id).slice(0, 3)}</p>
        <p className="text-xs text-muted">review</p>
      </div>
      <div className="min-w-0 flex-1">
        <p>
          <Link className={`font-semibold ${TEXT_LINK}`} to={`/reviews/${props.note.id}`}>
            {reviewLinkTitle(props.note.id)}
          </Link>
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={NOTE_BUTTON}
            disabled={props.busy}
            onClick={props.onDone}
          >
            Done
          </button>
        </div>
      </div>
    </li>
  );
}

// The AI box, "This week" (spec 07, 1. AI box): the heading counts the notes worth acting on that
// are not Done; then each group that has notes, in order, with its count. Nothing hides behind
// "Show all". With no AI provider, one more note links to the AI settings.
export function AiBox(props: {
  view: AiBoxView;
  today: string;
  onChanged: () => void;
  // The note whose reason shows when it first draws.
  whyOpen?: string;
}) {
  const { view } = props;
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const paused = pausedLine(view.paused, props.today);

  async function done(note: AiBoxNoteView | AiBoxInsightCardView, mark: boolean) {
    setBusy(note.id);
    const failed =
      note.kind === "Insight card"
        ? await markInsightCardDone(note.id, mark)
        : await markAlertNoteDone(note.id, mark);
    setBusy(undefined);
    setError(failed);
    if (failed === undefined) props.onChanged();
  }

  async function reviewLinkDone(month: string) {
    setBusy(month);
    const failed = await markReviewLinkDone(month, true);
    setBusy(undefined);
    setError(failed);
    if (failed === undefined) props.onChanged();
  }

  return (
    <section
      aria-label="This week"
      className="rounded-card border border-line bg-white p-4 min-[900px]:p-5"
      data-slot="ai-box"
    >
      <p className={BOX_LABEL}>This week</p>
      <h2 className="mt-1 text-lg font-bold min-[900px]:text-xl" data-slot="ai-heading">
        {worthActingOnHeading(view.worthActingOn)}
      </h2>
      {paused === undefined ? null : (
        <p className="mt-1 text-small text-muted" data-slot="ai-paused">
          {paused}
        </p>
      )}
      <ErrorLine error={error} />
      {view.groups.length === 0 ? (
        <p className="mt-3 text-muted" data-slot="nothing-new">
          {NOTHING_NEW}
        </p>
      ) : (
        view.groups.map((group) => (
          <section key={group.name} className="mt-4" data-slot="ai-group">
            <h3 className="text-small font-bold">
              <GroupStatus name={group.name} count={group.notes.length} />
            </h3>
            {/* A Proposal draws its own faint box; the margin parts it from the lines of the notes
                around it. */}
            <ul
              aria-label={group.name}
              className="mt-2 flex flex-col [&>[data-slot=proposal]]:my-2"
            >
              {group.notes.map((note) =>
                note.kind === "Proposal" ? (
                  <ProposalCard
                    key={note.id}
                    proposal={note.proposal}
                    onChanged={props.onChanged}
                    onAsk={() => navigate(askAboutPath, { state: askAboutProposal(note.proposal) })}
                  />
                ) : note.kind === "Review link" ? (
                  <ReviewLinkNote
                    key={note.id}
                    note={note}
                    busy={busy === note.id}
                    onDone={() => void reviewLinkDone(note.id)}
                  />
                ) : (
                  <AiNote
                    key={note.id}
                    note={note}
                    goodNews={group.name === "Good news"}
                    busy={busy === note.id}
                    onDone={(mark) => void done(note, mark)}
                    onAsk={() =>
                      navigate(askAboutPath, {
                        state:
                          note.kind === "Alert note"
                            ? askAboutAlertNote(note)
                            : askAboutInsightCard(note),
                      })
                    }
                    {...(props.whyOpen === note.id ? { whyOpen: true } : {})}
                  />
                ),
              )}
            </ul>
          </section>
        ))
      )}
      {view.setUpAi ? (
        <p className="mt-3 border-t border-line-soft pt-3.5" data-slot="set-up-ai">
          <Link className={TEXT_LINK} to={AI_SETTINGS}>
            {SET_UP_AI}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

// --- Layout ------------------------------------------------------------------------------------

// The two columns: the AI box, then the right column. One column below 900 px, the AI box first.
export function DashboardColumns(props: {
  ai: ReactNode;
  leftToSpend: ReactNode;
  goals: ReactNode;
  numberTiles: ReactNode;
  usualMonth: ReactNode;
  comingUp: ReactNode;
}) {
  return (
    <div
      className="grid gap-4 min-[900px]:grid-cols-[minmax(16rem,22rem)_1fr] min-[900px]:items-start"
      data-slot="columns"
    >
      <div
        className="min-[900px]:sticky min-[900px]:top-4 min-[900px]:max-h-[calc(100vh-2rem)] min-[900px]:overflow-y-auto"
        data-slot="ai-column"
      >
        {props.ai}
      </div>
      <div className="flex min-w-0 flex-col gap-4" data-slot="right-column">
        {props.leftToSpend}
        {props.goals}
        {props.numberTiles}
        {props.usualMonth}
        {props.comingUp}
      </div>
    </div>
  );
}

// What the dashboard shows in place of its boxes while app.db holds no Connection, removed or not:
// with no bank, no history ever loads, so empty boxes would only promise numbers that never come.
export const NO_CONNECTION_YET = "Link a bank to see your money here";

export function NoConnectionYet() {
  return (
    <section className={BOX} data-slot="no-connection">
      <p className="font-semibold">
        <Link className={TEXT_LINK} to="/settings/banks">
          {NO_CONNECTION_YET}
        </Link>
      </p>
      <p className="mt-1 text-sm text-muted">
        The dashboard fills in once a bank is linked and its history has loaded.
      </p>
    </section>
  );
}

// What the page shows: the header first, drawn once whether or not the page has read yet, then an
// error, then the status lines and the boxes once it has.
export function DashboardView(
  props: Omit<Parameters<typeof DashboardReport>[0], "data"> & {
    data: DashboardData | undefined;
    error?: string | undefined;
  },
) {
  const { data, error, ...report } = props;
  return (
    <Page width="wide">
      <DashboardHeader
        {...(data === undefined
          ? {}
          : {
              month: data.month,
              line: headerLine(data.month, data.connections, data.timeZone),
            })}
      />
      <ErrorLine error={error} />
      {data === undefined ? null : <DashboardReport data={data} {...report} />}
    </Page>
  );
}

// The status lines and the boxes, under the header.
export function DashboardReport(props: {
  data: DashboardData;
  onClose: (id: string) => void;
  onRetry: () => void;
  onChanged: () => void;
  // The Category group whose Budgets "A usual month" shows when it first draws.
  openGroup?: string;
  // The AI box note whose reason shows when it first draws.
  whyOpen?: string;
  // Whether the page still reads the history loading progress again.
  live?: PollState;
}) {
  const { data } = props;
  return (
    <>
      <StatusLineList
        lines={statusLines(data.notices, data.connections, data.history)}
        finishSetup={<FinishSetupList steps={data.setup.finishSetup} />}
        onClose={props.onClose}
        onRetry={props.onRetry}
        onChanged={props.onChanged}
        {...(props.live === undefined ? {} : { live: props.live })}
      />
      {data.connections.length === 0 ? (
        <NoConnectionYet />
      ) : (
        <DashboardColumns
          ai={
            <AiBox
              view={data.aiBox}
              today={data.month.today}
              onChanged={props.onChanged}
              {...(props.whyOpen === undefined ? {} : { whyOpen: props.whyOpen })}
            />
          }
          leftToSpend={<LeftToSpendBox left={leftToSpend(data.budgets)} month={data.month} />}
          goals={<GoalsBox answer={data.goals} />}
          numberTiles={<NumberTilesBox tiles={data.numberTiles} />}
          usualMonth={
            <UsualMonthBox
              key={data.month.month}
              usual={data.usualMonth}
              budgets={data.budgets}
              month={data.month}
              {...(props.openGroup === undefined ? {} : { initialOpen: props.openGroup })}
            />
          }
          comingUp={<ComingUpBox view={data.comingUp} month={data.month} />}
        />
      )}
    </>
  );
}

// How often the page checks whether the Household's date changed, to switch month on the 1st.
const DATE_CHECK_MS = 60_000;

// While a history load runs, the dashboard reads GET /api/history-status again every 5 seconds, for
// at most 10 minutes. Each read is that one request; the whole page is read again only when a load
// ends.
export const HISTORY_POLL: PollPlan = { everyMs: 5_000, maxReads: 120 };

export function Dashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | undefined>();
  // The history progress read since the page was last read whole.
  const [history, setHistory] = useState<HistoryStatusView | undefined>();
  const [error, setError] = useState<string | undefined>();
  // A poll's whole read and a Member action's can overlap: an older answer never replaces a newer.
  const [order] = useState(answerOrder);

  // Reads the whole page. Answers whether it read; an ended session goes to sign-in.
  async function load(): Promise<boolean> {
    const newest = order.begin();
    try {
      const read = await loadDashboard();
      if (!newest()) return true;
      setData(read);
      setHistory(undefined);
      setError(undefined);
      return true;
    } catch (failure) {
      if (failure instanceof SignedOut) void navigate("/sign-in", { replace: true });
      else setError("The dashboard did not load.");
      return false;
    }
  }

  const shownHistory = history ?? data?.history;
  const live = usePolling(
    (shownHistory?.loading.length ?? 0) > 0,
    () =>
      readHistoryAgain(shownHistory, {
        history: loadHistoryStatus,
        whole: load,
        show: setHistory,
        signedOut: () => navigate("/sign-in", { replace: true }),
      }),
    HISTORY_POLL,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  // A new day reads the page again: on the 1st it shows the new month.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the check restarts with each read.
  useEffect(() => {
    if (data === undefined) return;
    const timer = setInterval(() => {
      if (dashboardMonth(new Date(), data.timeZone).today !== data.month.today) void load();
    }, DATE_CHECK_MS);
    return () => clearInterval(timer);
  }, [data]);

  function close(id: string) {
    closeNotice(id)
      .then(load)
      .catch(() => {});
  }

  // Retry starts the stopped job again; its notice ends, so the page reads again.
  async function retry() {
    try {
      const res = await retryHistoryJobs();
      if (!res.ok) return setError("Retry did not start.");
      await load();
    } catch {
      setError("The server did not answer.");
    }
  }

  return (
    <DashboardView
      data={
        data === undefined || shownHistory === undefined ? data : { ...data, history: shownHistory }
      }
      error={error}
      live={live}
      onClose={close}
      onRetry={() => void retry()}
      onChanged={() => void load()}
    />
  );
}
