import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { STATUS_ICON } from "../../format.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { NoticeList } from "../components/NoticeLines.tsx";
import { Status, TONE_COLOR } from "../components/Status.tsx";
import {
  barShare,
  closeNotice,
  type DashboardData,
  type DashboardMonth,
  dashboardMonth,
  headerLine,
  type LeftToSpend,
  leftText,
  leftToSpend,
  loadDashboard,
  meterLine,
  paceLine,
  retryHistoryJobs,
  type StatusLines,
  statusLines,
  type YearlyRow,
  yearlyLine,
} from "../dashboard.ts";
import { BEFORE_FIRST_DRAFT } from "./Budgets.tsx";
import { UpdateMode } from "./settings/Connections.tsx";

// The dashboard (spec 07, The dashboard): the header, the status lines, then a box for each part.
// From 900 px wide, the AI box is the left column and stays in view while the right column
// scrolls. Narrower, every box stacks in one column, the AI box first. This ticket builds the
// header, the status lines, and Left to spend; the other boxes come with their own tickets.

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
export function DashboardColumns(props: { ai: ReactNode; leftToSpend: ReactNode }) {
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
        <Slot title="Number tiles" slot="number-tiles" />
        <Slot title="A usual month" slot="usual-month" />
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
