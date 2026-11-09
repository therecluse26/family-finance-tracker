import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { dollarsAndCents, monthLabel, percent, wholeDollars } from "../../../format.ts";
import type { BalancesReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import { BUDGET_LINE_COLOR, FULL_COLOR, GROUP_COLORS, INK_COLOR } from "../../chart-colors.ts";
import { BalanceChart, chartRows } from "../../components/BalanceChart.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { drillDownHref } from "./drill-down.ts";
import {
  CHART_BOX,
  ChartKey,
  GRID,
  monthWords,
  reportTooltip,
  type TooltipContent,
  X_AXIS,
  Y_AXIS,
} from "./ReportChart.tsx";
import { type Headline, type LinePart, ReportFrame } from "./ReportFrame.tsx";
import { ReportTable } from "./ReportTable.tsx";
import { CELL_LINK, FILTER_LABEL, FILTER_SELECT } from "./report-view.ts";

// Balances and debt (spec 07, Reports): Cash on hand and Debt at each month-end of the range, each
// credit card's credit use, and each loan's pay-down, or one Account's balance line. A stretch
// estimated next to known month-ends is dashed, and a caption names it; a line estimated from end
// to end stays solid, and the caption says it is estimated. A tap on a point opens that month's
// Transactions. No net worth (spec 13).

const LINE_COLORS = Object.values(GROUP_COLORS);

// A month, YYYY-MM, as the tables write it: "Oct 2025".
const monthText = (month: string) => monthLabel(`${month}-01`);

// The Reports page with `account` set, or with no Account for "All Accounts", keeping the range
// and every other filter.
export function accountHref(params: URLSearchParams, account: string): string {
  const query = new URLSearchParams(params);
  if (account === "") query.delete("account");
  else query.set("account", account);
  const search = query.toString();
  return `/reports${search === "" ? "" : `?${search}`}#balances`;
}

// One line on a month chart: a value at each month of the range, or null for none.
type Series = {
  // Unique in its chart.
  id: string;
  name: string;
  color: string;
  points: readonly { month: string; value: number | null; estimated: boolean }[];
  // The Transactions behind a point.
  href?: (month: string) => string;
  bold?: boolean;
};

// Whether every point of a series with a value is estimated: then the whole line is an estimate,
// and dashing it all would say nothing.
const allEstimated = (series: Series) => {
  const valued = series.points.filter((point) => point.value !== null);
  return valued.length > 0 && valued.every((point) => point.estimated);
};

// The words under a chart for its estimates.
export function estimateNote(series: readonly Series[]): string | undefined {
  const whole = series.some(allEstimated);
  const dashed = series.some(
    (each) => !allEstimated(each) && each.points.some((point) => point.estimated),
  );
  const words = [
    whole ? "Estimated from your Transactions." : "",
    dashed ? "Dashed: estimated month-ends." : "",
  ].filter((part) => part !== "");
  return words.length === 0 ? undefined : words.join(" ");
}

// A month's hover label: each line's value, marked when it is an estimate next to known ones.
function linesTooltip(
  series: readonly Series[],
  month: string,
  last: string | undefined,
  format: (value: number) => string,
): TooltipContent | null {
  const rows = series.flatMap((each) => {
    const point = each.points.find((candidate) => candidate.month === month);
    if (point === undefined || point.value === null) return [];
    const marked = point.estimated && !allEstimated(each);
    return [
      {
        name: marked ? `${each.name} (estimated)` : each.name,
        amount: format(point.value),
        color: each.color,
      },
    ];
  });
  if (rows.length === 0) return null;
  return { title: `${monthWords(month)}${month === last ? ", today" : ""}`, rows };
}

// Each series is two lines in one color, as in BalanceChart: known month-ends solid and estimated
// ones dashed. A series estimated from end to end is drawn solid. The key under it names each
// series, and a caption says what is estimated.
function MonthLinesChart(props: {
  series: readonly Series[];
  format: (value: number) => string;
  tick: (value: number) => string;
}) {
  const navigate = useNavigate();
  const months = props.series[0]?.points.map((point) => point.month) ?? [];
  const split = props.series.map((series) => {
    const whole = allEstimated(series);
    return chartRows(
      series.points.map((point) => ({
        date: point.month,
        currentBalance: point.value,
        availableBalance: null,
        estimated: whole ? false : point.estimated,
      })),
    );
  });
  const rows = months.map((month, index) => {
    const row: Record<string, string | number | null> = { month };
    split.forEach((each, at) => {
      row[`s${at}`] = each[index]?.known ?? null;
      row[`e${at}`] = each[index]?.estimated ?? null;
    });
    return row;
  });
  const note = estimateNote(props.series);
  return (
    <figure>
      <div className={CHART_BOX}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid {...GRID} />
            <XAxis {...X_AXIS} />
            <YAxis {...Y_AXIS} tickFormatter={(value: number) => props.tick(value)} />
            {reportTooltip(
              ({ month }) => linesTooltip(props.series, month, months.at(-1), props.format),
              { cursor: "line" },
            )}
            {props.series.flatMap((series, at) =>
              (["s", "e"] as const).map((kind) => (
                <Line
                  key={`${kind}-${series.id}`}
                  dataKey={`${kind}${at}`}
                  name={`${kind}${at}`}
                  type="linear"
                  stroke={series.color}
                  strokeWidth={series.bold ? 2.5 : 2}
                  strokeDasharray={kind === "e" ? "4 4" : undefined}
                  dot={false}
                  activeDot={{
                    r: 4,
                    cursor: series.href === undefined ? undefined : "pointer",
                    onClick: (_event: unknown, dot: unknown) => {
                      const month = (dot as { payload?: { month?: unknown } }).payload?.month;
                      if (series.href !== undefined && typeof month === "string") {
                        void navigate(series.href(month));
                      }
                    },
                  }}
                  isAnimationActive={false}
                />
              )),
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <ChartKey
          items={props.series.map((series) => ({
            name: series.name,
            color: series.color,
            mark: "line" as const,
          }))}
        />
        {note === undefined ? null : (
          <p className="mt-1 text-small text-muted" data-slot="estimate-note">
            {note}
          </p>
        )}
      </figcaption>
    </figure>
  );
}

function Part(props: { title: string; children: ReactNode }) {
  return (
    <div className="mt-6 first:mt-0">
      <h3 className="text-sm font-semibold">{props.title}</h3>
      <div className="mt-2">{props.children}</div>
    </div>
  );
}

const marked = (text: string, estimated: boolean) => (estimated ? `${text} (estimated)` : text);

// A table of one value per month and column. Each cell links to its Transactions when it can.
function MonthTable(props: {
  label: string;
  months: readonly string[];
  columns: readonly {
    name: string;
    cells: readonly { text: string; estimated: boolean }[];
    href?: (month: string) => string;
  }[];
}) {
  return (
    <ReportTable
      label={props.label}
      caption={props.label}
      head="Month"
      columns={props.columns.map((column) => ({ key: column.name, name: column.name }))}
      rows={props.months.map((month, index) => ({
        key: month,
        head: monthText(month),
        cells: props.columns.map((column) => {
          const cell = column.cells[index];
          const text = cell === undefined ? "" : marked(cell.text, cell.estimated);
          return column.href === undefined || cell === undefined ? (
            text
          ) : (
            <Link key={column.name} className={CELL_LINK} to={column.href(month)}>
              {text}
            </Link>
          );
        }),
      }))}
    />
  );
}

const shareText = (share: number | null) => (share === null ? "no limit" : percent(share));
const principalText = (principal: number | null) =>
  principal === null ? "none" : dollarsAndCents(principal);

// The report's charts and tables for every Account.
function allAccounts(view: BalancesReportView): { chart: ReactNode; table: ReactNode } {
  const monthHref = (month: string) => drillDownHref({ month });
  const accountHrefOf = (account: string) => (month: string) => drillDownHref({ account, month });
  const amounts = (points: BalancesReportView["cashOnHand"]) =>
    points.map((point) => ({ ...point, value: point.amount }));
  const cards = view.creditUse.cards.map((card, at) => ({
    id: card.id,
    name: card.name,
    color: LINE_COLORS[at % LINE_COLORS.length] ?? FULL_COLOR,
    points: card.points.map((point) => ({ ...point, value: point.share })),
    href: accountHrefOf(card.id),
  }));
  const creditSeries: Series[] =
    cards.length === 0
      ? []
      : [
          ...cards,
          {
            id: "all-cards",
            name: "All cards",
            color: INK_COLOR,
            bold: true,
            points: view.creditUse.all.map((point) => ({ ...point, value: point.share })),
          },
        ];
  const loans = view.loans.map((loan, at) => ({
    id: loan.id,
    name: loan.name,
    color: LINE_COLORS[at % LINE_COLORS.length] ?? FULL_COLOR,
    points: loan.points.map((point) => ({ ...point, value: point.principal })),
    href: accountHrefOf(loan.id),
  }));
  const dollars = (value: number) => wholeDollars(value);
  const shares = (value: number) => percent(value);
  const dollarTicks = Y_AXIS.tickFormatter;

  const chart = (
    <>
      <Part title="Cash on hand and Debt">
        <MonthLinesChart
          format={dollars}
          tick={dollarTicks}
          series={[
            {
              id: "cash",
              name: "Cash on hand",
              color: FULL_COLOR,
              points: amounts(view.cashOnHand),
              href: monthHref,
            },
            {
              id: "debt",
              name: "Debt",
              color: BUDGET_LINE_COLOR,
              points: amounts(view.debt),
              href: monthHref,
            },
          ]}
        />
      </Part>
      <Part title="Credit use">
        {creditSeries.length === 0 ? (
          <p className="text-muted">No credit card with a credit limit.</p>
        ) : (
          <MonthLinesChart format={shares} tick={shares} series={creditSeries} />
        )}
      </Part>
      <Part title="Loan pay-down">
        {loans.length === 0 ? (
          <p className="text-muted">No loan to show.</p>
        ) : (
          <MonthLinesChart format={dollars} tick={dollarTicks} series={loans} />
        )}
      </Part>
    </>
  );

  const money = (points: BalancesReportView["cashOnHand"]) =>
    points.map((point) => ({ text: dollarsAndCents(point.amount), estimated: point.estimated }));
  const table = (
    <div className="flex flex-col gap-4">
      <MonthTable
        label="Cash on hand and Debt by month"
        months={view.months}
        columns={[
          { name: "Cash on hand", cells: money(view.cashOnHand), href: monthHref },
          { name: "Debt", cells: money(view.debt), href: monthHref },
        ]}
      />
      {cards.length === 0 ? null : (
        <MonthTable
          label="Credit use by month"
          months={view.months}
          columns={[
            ...view.creditUse.cards.map((card) => ({
              name: card.name,
              cells: card.points.map((point) => ({
                text: shareText(point.share),
                estimated: point.estimated,
              })),
              href: accountHrefOf(card.id),
            })),
            {
              name: "All cards",
              cells: view.creditUse.all.map((point) => ({
                text: shareText(point.share),
                estimated: point.estimated,
              })),
            },
          ]}
        />
      )}
      {loans.length === 0 ? null : (
        <MonthTable
          label="Loan pay-down by month"
          months={view.months}
          columns={view.loans.map((loan) => ({
            name: loan.name,
            cells: loan.points.map((point) => ({
              text: principalText(point.principal),
              estimated: point.estimated,
            })),
            href: accountHrefOf(loan.id),
          }))}
        />
      )}
    </div>
  );
  return { chart, table };
}

// The big number: Cash on hand now. Its line: Debt now, and its change since the range's first
// month-end, green when it fell.
export function balancesHeadline(view: BalancesReportView): Headline | undefined {
  const cash = view.cashOnHand.at(-1);
  if (cash === undefined) return undefined;
  const debt = view.debt.at(-1);
  const first = view.debt[0];
  const line: LinePart[] = [];
  if (debt !== undefined) {
    const words = `Debt ${wholeDollars(debt.amount)}${debt.estimated ? " (estimated)" : ""}`;
    const change = first === undefined || first === debt ? 0 : debt.amount - first.amount;
    const amount = wholeDollars(Math.abs(change));
    if (first === undefined || first === debt || amount === "$0") line.push(words);
    else {
      line.push(`${words}, `, {
        tone: change < 0 ? "good" : "serious",
        text: `${change < 0 ? "▼" : "▲"} ${amount} since ${monthText(first.month)}`,
      });
    }
  }
  return {
    amount: wholeDollars(cash.amount),
    unit: "Cash on hand",
    estimated: cash.estimated,
    line,
  };
}

// One Account's balance line, and its month-ends as a table.
function oneAccount(
  view: BalancesReportView,
  account: NonNullable<BalancesReportView["account"]>,
): { chart: ReactNode; table: ReactNode; headline?: Headline } {
  const months = account.monthEnds.map((end) => end.month);
  const latest = account.points.findLast((point) => point.currentBalance !== null);
  return {
    ...(latest?.currentBalance == null
      ? {}
      : {
          headline: {
            amount: wholeDollars(latest.currentBalance),
            unit: account.name,
            estimated: latest.estimated,
          },
        }),
    chart: <BalanceChart points={account.points} today={view.today} />,
    table:
      months.length === 0 ? undefined : (
        <MonthTable
          label={`${account.name} by month`}
          months={months}
          columns={[
            {
              name: "Balance",
              cells: account.monthEnds.map((end) => ({
                text: end.currentBalance === null ? "none" : dollarsAndCents(end.currentBalance),
                estimated: end.estimated,
              })),
              href: (month) => drillDownHref({ account: account.id, month }),
            },
          ]}
        />
      ),
  };
}

// The Account filter: "All Accounts" or one. A choice opens the page with it set.
export function AccountFilter(props: {
  params: URLSearchParams;
  accounts: BalancesReportView["accounts"];
}) {
  const navigate = useNavigate();
  return (
    <label className={FILTER_LABEL}>
      Account
      <select
        name="account"
        className={FILTER_SELECT}
        value={props.params.get("account") ?? ""}
        onChange={(event) => void navigate(accountHref(props.params, event.target.value))}
      >
        <option value="">All Accounts</option>
        {props.accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const CAPTION = "Choose a point to see that month's Transactions.";

// The report drawn from its answer.
export function BalancesReportBody(props: {
  view: BalancesReportView;
  params: URLSearchParams;
  initialTable?: boolean;
}) {
  const { view } = props;
  const filter = <AccountFilter params={props.params} accounts={view.accounts} />;
  const frame = (parts: { chart: ReactNode; table?: ReactNode; headline?: Headline }) => (
    <ReportFrame
      id="balances"
      title="Balances and debt"
      filter={filter}
      chart={parts.chart}
      {...(parts.headline === undefined ? {} : { headline: parts.headline })}
      {...(parts.table === undefined ? {} : { table: parts.table, caption: CAPTION })}
      {...(props.initialTable === undefined ? {} : { initialTable: props.initialTable })}
    />
  );
  if (view.account !== null) return frame(oneAccount(view, view.account));
  if (view.months.length === 0) {
    return frame({ chart: <p className="text-muted">No balances yet.</p> });
  }
  const headline = balancesHeadline(view);
  return frame({ ...allAccounts(view), ...(headline === undefined ? {} : { headline }) });
}

type Loaded =
  | { state: "loading" }
  | { state: "loaded"; view: BalancesReportView }
  | { state: "not found" }
  | { state: "failed" };

export function BalancesReport(props: ReportSectionProps) {
  const account = props.params.get("account") ?? undefined;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        const query = { range: props.range, ...(account === undefined ? {} : { account }) };
        const res = await api.reports.balances.$get({ query });
        if (!live) return;
        if (res.status === 404) return setLoaded({ state: "not found" });
        if (!res.ok) return setLoaded({ state: "failed" });
        setLoaded({ state: "loaded", view: (await res.json()) as BalancesReportView });
      } catch {
        if (live) setLoaded({ state: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, [props.range, account]);

  if (loaded.state === "loaded")
    return <BalancesReportBody view={loaded.view} params={props.params} />;
  const chart =
    loaded.state === "loading" ? (
      <p className="text-muted">Loading balances…</p>
    ) : loaded.state === "not found" ? (
      <p className="text-muted">No Account has this ID.</p>
    ) : (
      <ErrorLine error="The server did not answer." />
    );
  return <ReportFrame id="balances" title="Balances and debt" chart={chart} />;
}
