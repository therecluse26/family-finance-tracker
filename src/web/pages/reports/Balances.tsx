import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dollarsAndCents, monthLabel, percent, wholeDollars } from "../../../format.ts";
import type { BalancesReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import { BUDGET_LINE_COLOR, FULL_COLOR, GROUP_COLORS } from "../../chart-colors.ts";
import { BalanceChart, chartRows } from "../../components/BalanceChart.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { drillDownHref } from "./drill-down.ts";
import { ReportFrame } from "./ReportFrame.tsx";

// Balances and debt (spec 07, Reports): Cash on hand and Debt at each month-end of the range, each
// credit card's credit use, and each loan's pay-down, or one Account's balance line. Estimated
// stretches are dashed, and a caption names them. A tap on a point opens that month's
// Transactions. No net worth (spec 13).

const DEBT_COLOR = "#C2457A";
const LINE_COLORS = Object.values(GROUP_COLORS);
const LINK = "text-accent hover:text-accent-dark hover:underline";

// A month, YYYY-MM, as the charts and tables write it: "Oct 2025".
const monthName = (month: string) => monthLabel(`${month}-01`);

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

// Each series is two lines in one color, as in BalanceChart: known month-ends solid and estimated
// ones dashed. The legend under it names each series, and a caption names the dashed line.
function MonthLinesChart(props: { series: readonly Series[]; format: (value: number) => string }) {
  const navigate = useNavigate();
  const months = props.series[0]?.points.map((point) => point.month) ?? [];
  const split = props.series.map((series) =>
    chartRows(
      series.points.map((point) => ({
        date: point.month,
        currentBalance: point.value,
        availableBalance: null,
        estimated: point.estimated,
      })),
    ),
  );
  const rows = months.map((month, index) => {
    const row: Record<string, string | number | null> = { month };
    split.forEach((each, at) => {
      row[`s${at}`] = each[index]?.known ?? null;
      row[`e${at}`] = each[index]?.estimated ?? null;
    });
    return row;
  });
  const estimated = props.series.some((series) => series.points.some((point) => point.estimated));
  const nameOf = (key: string) => props.series[Number(key.slice(1))]?.name ?? "";
  return (
    <figure>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <CartesianGrid stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={(month) => monthName(String(month))}
              tick={{ fill: "#4b5563", fontSize: 12 }}
            />
            <YAxis
              tickFormatter={(value: number) => props.format(value)}
              tick={{ fill: "#4b5563", fontSize: 12 }}
              width={80}
            />
            <Tooltip
              labelFormatter={(month) => monthName(String(month))}
              formatter={(value, key) => [
                props.format(Number(value)),
                `${nameOf(String(key))}${String(key).startsWith("e") ? " (estimated)" : ""}`,
              ]}
            />
            {props.series.flatMap((series, at) =>
              (["s", "e"] as const).map((kind) => (
                <Line
                  key={`${kind}-${series.id}`}
                  dataKey={`${kind}${at}`}
                  name={`${kind}${at}`}
                  type="linear"
                  stroke={series.color}
                  strokeWidth={series.bold ? 3 : 2}
                  strokeDasharray={kind === "e" ? "4 4" : undefined}
                  dot={false}
                  activeDot={{
                    r: 5,
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
      <figcaption className="mt-1 text-sm text-gray-600">
        <ul className="flex flex-wrap gap-x-4">
          {props.series.map((series) => (
            <li key={series.id} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-4"
                style={{ backgroundColor: series.color }}
              />
              {series.name}
            </li>
          ))}
        </ul>
        {estimated ? <p>The dashed line marks estimated month-ends.</p> : null}
      </figcaption>
    </figure>
  );
}

function Part(props: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="font-semibold">{props.title}</h3>
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
    <table aria-label={props.label} className="mt-2 w-full border-collapse text-sm first:mt-0">
      <caption className="text-left font-semibold">{props.label}</caption>
      <thead>
        <tr>
          <th scope="col" className="text-left">
            Month
          </th>
          {props.columns.map((column) => (
            <th key={column.name} scope="col" className="text-right">
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.months.map((month, index) => (
          <tr key={month} className="border-t border-line-soft">
            <th scope="row" className="text-left font-normal">
              {monthName(month)}
            </th>
            {props.columns.map((column) => {
              const cell = column.cells[index];
              const text = cell === undefined ? "" : marked(cell.text, cell.estimated);
              return (
                <td key={column.name} className="text-right tabular-nums">
                  {column.href === undefined || cell === undefined ? (
                    text
                  ) : (
                    <Link className={LINK} to={column.href(month)}>
                      {text}
                    </Link>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
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
            color: BUDGET_LINE_COLOR,
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

  const chart = (
    <>
      <Part title="Cash on hand and Debt">
        <MonthLinesChart
          format={dollars}
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
              color: DEBT_COLOR,
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
          <MonthLinesChart format={shares} series={creditSeries} />
        )}
      </Part>
      <Part title="Loan pay-down">
        {loans.length === 0 ? (
          <p className="text-muted">No loan to show.</p>
        ) : (
          <MonthLinesChart format={dollars} series={loans} />
        )}
      </Part>
    </>
  );

  const money = (points: BalancesReportView["cashOnHand"]) =>
    points.map((point) => ({ text: dollarsAndCents(point.amount), estimated: point.estimated }));
  const table = (
    <>
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
    </>
  );
  return { chart, table };
}

// One Account's balance line, and its month-ends as a table.
function oneAccount(
  view: BalancesReportView,
  account: NonNullable<BalancesReportView["account"]>,
): { chart: ReactNode; table: ReactNode } {
  const months = account.monthEnds.map((end) => end.month);
  return {
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
    <label className="flex items-center gap-2 text-sm">
      Account
      <select
        name="account"
        className="rounded-control border border-field bg-white px-2 py-1.5"
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

// The report drawn from its answer.
export function BalancesReportBody(props: {
  view: BalancesReportView;
  params: URLSearchParams;
  initialTable?: boolean;
}) {
  const { view } = props;
  const filter = <AccountFilter params={props.params} accounts={view.accounts} />;
  const frame = (parts: { chart: ReactNode; table?: ReactNode }) => (
    <ReportFrame
      id="balances"
      title="Balances and debt"
      filter={filter}
      chart={parts.chart}
      {...(parts.table === undefined ? {} : { table: parts.table })}
      {...(props.initialTable === undefined ? {} : { initialTable: props.initialTable })}
    />
  );
  if (view.account !== null) return frame(oneAccount(view, view.account));
  if (view.months.length === 0) {
    return frame({ chart: <p className="text-muted">No balances yet.</p> });
  }
  return frame(allAccounts(view));
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
