import { Link, useNavigate } from "react-router";
import {
  Bar,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { monthLabel, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import type { CashFlowAmounts, CashFlowReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import { BUDGET_LINE_COLOR, GROUP_COLORS } from "../../chart-colors.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { drillDownHref } from "./drill-down.ts";
import { ReportFrame } from "./ReportFrame.tsx";
import { CELL_LINK, TABLE, TD, TD_NUMBER, TH, TH_NUMBER, useReportView } from "./report-view.ts";

// Cash flow (spec 07, Reports): Income, Spending and Saving as three bars per month, and what is
// left over as a line: Income less Spending less Saving, which may be below $0. It has no filter.
// A summary under it holds the range's totals and averages per month.

// The three bars, each a Transaction type, so a tap opens that type's Transactions in its month.
const BARS = [
  { key: "income", type: "Income", color: GROUP_COLORS.Shopping },
  { key: "spending", type: "Spending", color: GROUP_COLORS.Bills },
  { key: "saving", type: "Saving", color: GROUP_COLORS.Leisure },
] as const;
const LEFT_OVER_COLOR = GROUP_COLORS.Transportation;

// A month's bar of `type` opens its Transactions; a point on the Left over line opens the month.
export function cashFlowHref(month: string, type?: (typeof BARS)[number]["type"]): string {
  return drillDownHref(type === undefined ? { month } : { type, month });
}

export const cashFlowRequests = {
  view: (range: ReportRange) => api.reports["cash-flow"].$get({ query: { range } }),
};

type ChartRow = CashFlowReportView["bars"][number] & { label: string };

// A Left over point, which opens its month.
function LeftOverDot(props: { cx?: number; cy?: number; payload?: ChartRow }) {
  const navigate = useNavigate();
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || payload === undefined) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the chart is hidden from screen readers and the keyboard; the table under it holds the same links.
    <circle
      cx={cx}
      cy={cy}
      r={3.5}
      fill={LEFT_OVER_COLOR}
      cursor="pointer"
      onClick={() => void navigate(cashFlowHref(payload.month))}
    />
  );
}

function CashFlowChart(props: { view: CashFlowReportView }) {
  const navigate = useNavigate();
  const rows: ChartRow[] = props.view.bars.map((bar) => ({
    ...bar,
    label: monthLabel(`${bar.month}-01`),
  }));
  return (
    <>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis
              width={64}
              tick={{ fontSize: 12 }}
              tickFormatter={(cents: number) => wholeDollars(cents)}
            />
            <ReferenceLine y={0} stroke={BUDGET_LINE_COLOR} />
            {BARS.map((bar) => (
              <Bar
                key={bar.key}
                name={bar.type}
                dataKey={bar.key}
                fill={bar.color}
                cursor="pointer"
                isAnimationActive={false}
                onClick={(item) => {
                  const month = (item.payload as ChartRow | undefined)?.month;
                  if (month !== undefined) void navigate(cashFlowHref(month, bar.type));
                }}
              />
            ))}
            <Line
              name="Left over"
              dataKey="leftOver"
              stroke={LEFT_OVER_COLOR}
              strokeWidth={2}
              dot={(dot: { cx?: number; cy?: number; payload?: ChartRow; index?: number }) => (
                <LeftOverDot key={dot.index} {...dot} />
              )}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted">
        {BARS.map((bar) => (
          <li key={bar.key} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: bar.color }}
            />
            {bar.type}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: LEFT_OVER_COLOR }} />
          Left over
        </li>
      </ul>
    </>
  );
}

// The chart's numbers, one row per month. Each amount opens its Transactions.
export function CashFlowTable(props: { view: CashFlowReportView }) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE} aria-label="Cash flow by month">
        <thead>
          <tr>
            <th className={TH}>Month</th>
            {BARS.map((bar) => (
              <th key={bar.key} className={TH_NUMBER}>
                {bar.type}
              </th>
            ))}
            <th className={TH_NUMBER}>Left over</th>
          </tr>
        </thead>
        <tbody>
          {props.view.bars.map((row) => (
            <tr key={row.month}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                {monthLabel(`${row.month}-01`)}
              </th>
              {BARS.map((bar) => (
                <td key={bar.key} className={TD_NUMBER}>
                  <Link className={CELL_LINK} to={cashFlowHref(row.month, bar.type)}>
                    {wholeDollars(row[bar.key])}
                  </Link>
                </td>
              ))}
              <td className={TD_NUMBER}>
                <Link className={CELL_LINK} to={cashFlowHref(row.month)}>
                  {wholeDollars(row.leftOver)}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The range's totals and averages per month of the four.
export function CashFlowSummary(props: { view: CashFlowReportView }) {
  const line = (label: string, amounts: CashFlowAmounts) => (
    <tr>
      <th scope="row" className={`${TD} text-left font-normal`}>
        {label}
      </th>
      {BARS.map((bar) => (
        <td key={bar.key} className={TD_NUMBER}>
          {wholeDollars(amounts[bar.key])}
        </td>
      ))}
      <td className={TD_NUMBER}>{wholeDollars(amounts.leftOver)}</td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className={TABLE} aria-label="Cash flow over the range">
        <thead>
          <tr>
            <th className={TH}>
              <span className="sr-only">Over the range</span>
            </th>
            {BARS.map((bar) => (
              <th key={bar.key} className={TH_NUMBER}>
                {bar.type}
              </th>
            ))}
            <th className={TH_NUMBER}>Left over</th>
          </tr>
        </thead>
        <tbody>
          {line("Total", props.view.total)}
          {line("Per month", props.view.average)}
        </tbody>
      </table>
    </div>
  );
}

// The report as drawn from its view.
export function CashFlowReportBody(props: {
  view: CashFlowReportView | undefined;
  error?: string | undefined;
}) {
  const { view } = props;
  const frame = { id: "cash-flow", title: "Cash flow" } as const;
  if (view === undefined)
    return <ReportFrame {...frame} chart={<ErrorLine error={props.error} />} />;
  if (view.months.length === 0) {
    return (
      <ReportFrame {...frame} chart={<p className="text-muted">No posted Transactions yet.</p>} />
    );
  }
  return (
    <ReportFrame
      {...frame}
      chart={<CashFlowChart view={view} />}
      table={<CashFlowTable view={view} />}
      summary={<CashFlowSummary view={view} />}
    />
  );
}

export function CashFlowReport(props: ReportSectionProps) {
  const { view, error } = useReportView<CashFlowReportView>(props.range, () =>
    cashFlowRequests.view(props.range),
  );
  return <CashFlowReportBody view={view} error={error} />;
}
