import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
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
import type { NumberTilesView } from "../../server/bank-views.ts";
import type { BudgetsView, UsualMonthView } from "../../server/budgets-views.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { NoticeList } from "../components/NoticeLines.tsx";
import { Status, TONE_COLOR } from "../components/Status.tsx";
import {
  barShare,
  closeNotice,
  type DashboardData,
  type DashboardMonth,
  dashboardMonth,
  directionOf,
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
  meterLine,
  type NumberTile,
  numberTiles,
  paceLine,
  projectedSpending,
  retryHistoryJobs,
  rowNote,
  type StatusLines,
  statusLines,
  type UsualGroup,
  usualMonthLine,
  type YearlyRow,
  yearlyLine,
} from "../dashboard.ts";
import { transactionsPath } from "../transactions.ts";
import { BEFORE_FIRST_DRAFT } from "./Budgets.tsx";
import { UpdateMode } from "./settings/Connections.tsx";

// The dashboard (spec 07, The dashboard): the header, the status lines, then a box for each part.
// From 900 px wide, the AI box is the left column and stays in view while the right column
// scrolls. Narrower, every box stacks in one column, the AI box first. The AI box, Goals, and
// Coming up come with their own tickets.

const BOX = "rounded border border-gray-200 p-4";

export function DashboardHeader(props: { month: DashboardMonth; line: string }) {
  return (
    <header>
      <h1 className="text-2xl font-semibold">{props.month.name}</h1>
      <p className="text-gray-600">{props.line}</p>
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
    <Link className="underline" to="/settings/banks">
      Repair
    </Link>
  );
}

export function StatusLineList(props: {
  lines: StatusLines;
  // The "Finish setup" list of skipped wizard steps, which comes with its own ticket.
  finishSetup?: ReactNode;
  onClose: (id: string) => void;
  // Retry on the notice of a stopped First run or bank-added-later job.
  onRetry: () => void;
  onChanged: () => void;
}) {
  const { repairs, loading, others } = props.lines;
  return (
    <div data-slot="status-lines">
      {repairs.length === 0 ? null : (
        <ul aria-label="Broken Connections" className="mt-4 flex flex-col gap-2">
          {repairs.map((banner) => (
            <li
              key={banner.notice.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded border border-red-200 bg-red-50 px-3 py-2"
            >
              <span>
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
        <ul aria-label="History loading" className="mt-4 flex flex-col gap-2">
          {loading.map((line) => (
            <li key={line.connectionId} className="rounded border border-gray-200 px-3 py-2">
              {line.text}
            </li>
          ))}
        </ul>
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
    <li className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="font-medium">{props.row.category}</span>
      <span>
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
      <h2 id="left-to-spend" className="font-semibold">
        Left to spend in {month.name}
      </h2>
      {left.drafted ? (
        <LeftToSpendNumbers left={left} month={month} />
      ) : (
        <p>{BEFORE_FIRST_DRAFT}</p>
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
      <p className="mt-1 flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-semibold" data-slot="left">
          {big.text}
        </span>
        {big.over ? <Status tone="critical" word="Over Budget" /> : null}
      </p>
      {pace === undefined ? null : (
        <p className={TONE_COLOR[pace.tone]} data-slot="pace">
          <span aria-hidden="true">{STATUS_ICON[pace.tone]} </span>
          {pace.text}
        </p>
      )}
      <div
        aria-hidden="true"
        className="relative mt-3 h-3 rounded bg-gray-100"
        data-slot="month-meter"
      >
        <div
          className={`h-3 rounded ${big.over ? "bg-red-600" : "bg-blue-600"}`}
          style={{ width: `${spent * 100}%` }}
        />
        <div
          className="absolute -top-1 h-5 w-0.5 bg-gray-900"
          data-slot="today"
          style={{ left: `${gone * 100}%` }}
          title="Today"
        />
      </div>
      <p className="mt-1 text-sm text-gray-600" data-slot="meter-line">
        {meterLine(left.spending, left.budget, month)}
      </p>
      {left.yearly.length === 0 ? null : (
        <ul aria-label="Yearly Budgets" className="mt-3 flex flex-col gap-1">
          {left.yearly.map((row) => (
            <YearlyBudgetRow key={row.category} row={row} />
          ))}
        </ul>
      )}
    </>
  );
}

// --- Number tiles ------------------------------------------------------------------------------

const FULL_COLOR = "#1d4ed8";
const MUTED_COLOR = "#cbd5e1";

// A tile's trend line: 12 points, drawn by the app from its own data. The tile's words carry its
// meaning, so the line is hidden from screen readers.
function TrendLine(props: { trend: NumberTile["tile"]["trend"] }) {
  return (
    <div aria-hidden="true" className="mt-2 h-8 w-full" data-slot="trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={props.trend} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            dataKey="amount"
            type="monotone"
            stroke={FULL_COLOR}
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
  const direction = directionOf(tile.tile.amount, tile.tile.usual, tile.moreIs);
  return (
    <li className="min-w-0" data-tile={tile.key}>
      <Link className="block rounded p-2 hover:bg-gray-50" to={tile.to}>
        <span className="block text-sm text-gray-600">{tile.label}</span>
        <span className="block text-xl font-semibold" data-slot="tile-amount">
          {wholeDollars(tile.tile.amount)}
        </span>
        {direction === undefined ? null : (
          <span className={`block text-sm ${TONE_COLOR[direction.tone]}`}>{direction.text}</span>
        )}
        <TrendLine trend={tile.tile.trend} />
        {tile.note === undefined ? null : (
          <span className="block text-xs text-gray-500">{tile.note}</span>
        )}
      </Link>
    </li>
  );
}

// Four tiles in a row, two by two on a phone (spec 07, 4. Number tiles). The box, not the screen,
// sets the columns: from 900 px the right column can be narrower than a phone.
export function NumberTilesBox(props: { tiles: NumberTilesView }) {
  return (
    <section aria-label="Number tiles" className={`${BOX} @container`} data-slot="number-tiles">
      <ul
        aria-label="Number tiles"
        className="grid grid-cols-2 gap-2 @min-[480px]:grid-cols-4"
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
      stroke="#111827"
      strokeWidth={1.5}
      strokeDasharray="3 2"
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
    <div aria-hidden="true" className="mt-2 h-16 w-full" data-slot="group-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={props.bars} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
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
  return (
    <li className="min-w-0 rounded border border-gray-100" data-group={group.categoryGroup}>
      <button
        type="button"
        aria-expanded={props.open}
        className="block w-full rounded p-2 text-left hover:bg-gray-50"
        onClick={props.onOpen}
      >
        <span className="block font-medium">{group.categoryGroup}</span>
        <span className="block text-sm" data-slot="group-line">
          {budget === 0
            ? `${wholeDollars(spent)}, no Budget`
            : `${wholeDollars(spent)} of ${wholeDollars(budget)}`}
        </span>
        {status === undefined ? null : (
          <span className="block text-sm">
            <Status {...status} />
          </span>
        )}
      </button>
      {/* The chart opens the group too; the button above is the way in for a keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the button above does the same. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the button above takes the keyboard. */}
      <div className="cursor-pointer px-2" onClick={props.onOpen}>
        <GroupChart bars={groupBars(group, month)} />
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
      className="relative mt-1 h-1.5 rounded bg-gray-100"
      data-slot="row-meter"
    >
      <div
        className={`h-1.5 rounded ${over ? "bg-red-600" : "bg-blue-600"}`}
        style={{ width: `${barShare(row.spending, amount) * 100}%` }}
      />
      {row.flexible ? (
        <div
          className="absolute -top-0.5 h-2.5 w-0.5 bg-gray-900"
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
        className="block rounded px-1 py-1 hover:bg-gray-50"
        to={transactionsPath({ category: row.category, month: month.month })}
      >
        <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-medium">{row.category}</span>
          <span>
            {row.budget === undefined ? (
              <>
                {wholeDollars(row.spending)} <span className="text-gray-500">no Budget</span>
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
          <span className="block text-xs text-gray-600">{row.budget.context}</span>
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
  return (
    <section aria-labelledby="usual-month" className={`${BOX} @container`} data-slot="usual-month">
      <h2 id="usual-month" className="font-semibold">
        A usual month
      </h2>
      <p className="mt-1 text-3xl font-semibold" data-slot="usual">
        {usual.usual === null ? "No complete month yet" : wholeDollars(usual.usual)}
      </p>
      {line === undefined ? null : (
        <p className={TONE_COLOR[line.tone]} data-slot="usual-line">
          {line.text}
        </p>
      )}
      <ul
        aria-label="Category groups"
        className="mt-3 grid grid-cols-1 gap-2 @min-[300px]:grid-cols-2 @min-[480px]:grid-cols-3"
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
      {shown === undefined ? null : (
        <section
          aria-label={`${shown.categoryGroup} Budgets`}
          className="mt-3"
          data-slot="group-budgets"
        >
          <div className="flex items-baseline justify-between">
            <h3 className="font-semibold">{shown.categoryGroup} Budgets</h3>
            <button
              type="button"
              className="text-sm text-blue-700 underline"
              onClick={() => setOpen(undefined)}
            >
              Close
            </button>
          </div>
          <ul aria-label={`${shown.categoryGroup} Budgets`} className="mt-1 flex flex-col gap-1">
            {groupBudgetRows(shown, budgets).map((row) => (
              <GroupBudgetRowItem key={row.category} row={row} month={month} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

// --- Layout ------------------------------------------------------------------------------------

// A box that its own ticket fills.
function Slot(props: { title: string; slot: string }) {
  return (
    <section aria-label={props.title} className={BOX} data-slot={props.slot}>
      <h2 className="font-semibold">{props.title}</h2>
      <p className="text-sm text-gray-500">Not built yet.</p>
    </section>
  );
}

// The two columns: the AI box, then the right column. One column below 900 px, the AI box first.
export function DashboardColumns(props: {
  ai: ReactNode;
  leftToSpend: ReactNode;
  numberTiles: ReactNode;
  usualMonth: ReactNode;
}) {
  return (
    <div
      className="mt-4 grid gap-4 min-[900px]:grid-cols-[minmax(16rem,22rem)_1fr] min-[900px]:items-start"
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
        <Slot title="Goals" slot="goals" />
        {props.numberTiles}
        {props.usualMonth}
        <Slot title="Coming up" slot="coming-up" />
      </div>
    </div>
  );
}

export function DashboardReport(props: {
  data: DashboardData;
  onClose: (id: string) => void;
  onRetry: () => void;
  onChanged: () => void;
  // The Category group whose Budgets "A usual month" shows when it first draws.
  openGroup?: string;
}) {
  const { data } = props;
  return (
    <>
      <DashboardHeader
        month={data.month}
        line={headerLine(data.month, data.connections, data.timeZone)}
      />
      <StatusLineList
        lines={statusLines(data.notices, data.connections, data.history, data.month.today)}
        onClose={props.onClose}
        onRetry={props.onRetry}
        onChanged={props.onChanged}
      />
      <DashboardColumns
        ai={<Slot title="This week" slot="ai-box" />}
        leftToSpend={<LeftToSpendBox left={leftToSpend(data.budgets)} month={data.month} />}
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
      />
    </>
  );
}

// How often the page checks whether the Household's date changed, to switch month on the 1st.
const DATE_CHECK_MS = 60_000;

export function Dashboard() {
  const [data, setData] = useState<DashboardData | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      setData(await loadDashboard());
      setError(undefined);
    } catch {
      setError("The dashboard did not load.");
    }
  }

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
    <main>
      <ErrorLine error={error} />
      {data === undefined ? (
        <h1 className="text-2xl font-semibold">Dashboard</h1>
      ) : (
        <DashboardReport
          data={data}
          onClose={close}
          onRetry={() => void retry()}
          onChanged={() => void load()}
        />
      )}
    </main>
  );
}
