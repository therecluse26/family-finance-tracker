import { Link, useNavigate } from "react-router";
import {
  Bar,
  CartesianGrid,
  Cell,
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
import {
  AXIS_TEXT_COLOR,
  BUDGET_LINE_COLOR,
  FULL_COLOR,
  GROUP_COLORS,
  MUTED_COLOR,
  SO_FAR_OPACITY,
  SURFACE_COLOR,
} from "../../chart-colors.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { drillDownHref } from "./drill-down.ts";
import {
  CHART_BOX,
  ChartKey,
  GRID,
  isCurrentMonth,
  monthName,
  reportTooltip,
  type TooltipContent,
  tooltipContent,
  X_AXIS,
  Y_AXIS,
} from "./ReportChart.tsx";
import { type Headline, ReportFrame } from "./ReportFrame.tsx";
import { ReportTable } from "./ReportTable.tsx";
import { CELL_LINK, useReportView } from "./report-view.ts";

// Cash flow (spec 07, Reports): Income, Spending and Saving as three bars per month, and what is
// left over as a line: Income less Spending less Saving, which may be below $0. It has no filter.
// The bars are greys and teal; the Left over line, the number that matters, is the one blue. The
// current month is pale, and its Left over point hollow at the end of a dotted stretch, as "so
// far". A summary under it holds the range's totals and averages per month.

// The three bars, each a Transaction type, so a tap opens that type's Transactions in its month.
const BARS = [
  { key: "income", type: "Income", color: MUTED_COLOR },
  { key: "spending", type: "Spending", color: BUDGET_LINE_COLOR },
  { key: "saving", type: "Saving", color: GROUP_COLORS.Shopping },
] as const;
const LEFT_OVER_COLOR = FULL_COLOR;

// A month's bar of `type` opens its Transactions; a point on the Left over line opens the month.
export function cashFlowHref(month: string, type?: (typeof BARS)[number]["type"]): string {
  return drillDownHref(type === undefined ? { month } : { type, month });
}

export const cashFlowRequests = {
  view: (range: ReportRange) => api.reports["cash-flow"].$get({ query: { range } }),
};

// A month of the chart: its amounts, and its Left over twice: on the solid line through the full
// months, and on the dotted stretch from the last full month to the current one.
type ChartRow = CashFlowReportView["bars"][number] & {
  full: number | null;
  soFar: number | null;
};

export function cashFlowRows(view: CashFlowReportView): ChartRow[] {
  const last = view.bars.length - 1;
  return view.bars.map((bar, at) => ({
    ...bar,
    full: at === last ? null : bar.leftOver,
    soFar: at >= last - 1 ? bar.leftOver : null,
  }));
}

// A Left over point, which opens its month. The current month's is hollow.
function LeftOverDot(props: { cx?: number; cy?: number; payload?: ChartRow; hollow: boolean }) {
  const navigate = useNavigate();
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || payload === undefined) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the chart is hidden from screen readers and the keyboard; the table under it holds the same links.
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={props.hollow ? SURFACE_COLOR : LEFT_OVER_COLOR}
      stroke={LEFT_OVER_COLOR}
      strokeWidth={2}
      cursor="pointer"
      onClick={() => void navigate(cashFlowHref(payload.month))}
    />
  );
}

// A month's hover label: Income, Spending, Saving and Left over.
export function cashFlowTooltip(view: CashFlowReportView, month: string): TooltipContent | null {
  const bar = view.bars.find((each) => each.month === month);
  if (bar === undefined) return null;
  const content = tooltipContent({
    month,
    current: isCurrentMonth(view.months, month),
    items: BARS.map((each) => ({ name: each.type, cents: bar[each.key], color: each.color })),
  });
  return { ...content, total: { name: "Left over", amount: wholeDollars(bar.leftOver) } };
}

function CashFlowChart(props: { view: CashFlowReportView }) {
  const navigate = useNavigate();
  const rows = cashFlowRows(props.view);
  const last = rows.length - 1;
  type Dot = { cx?: number; cy?: number; payload?: ChartRow; index?: number };
  return (
    <>
      <div className={CHART_BOX}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
            barGap={1}
          >
            <CartesianGrid {...GRID} />
            <XAxis {...X_AXIS} />
            <YAxis {...Y_AXIS} />
            {reportTooltip(({ month }) => cashFlowTooltip(props.view, month), { cursor: "band" })}
            <ReferenceLine y={0} stroke={AXIS_TEXT_COLOR} />
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
              >
                {rows.map((row, at) => (
                  <Cell key={row.month} fillOpacity={at === last ? SO_FAR_OPACITY : 1} />
                ))}
              </Bar>
            ))}
            <Line
              name="Left over"
              dataKey="full"
              stroke={LEFT_OVER_COLOR}
              strokeWidth={2}
              dot={(dot: Dot) => <LeftOverDot key={dot.index} {...dot} hollow={false} />}
              activeDot={false}
              isAnimationActive={false}
            />
            <Line
              name="Left over so far"
              dataKey="soFar"
              stroke={LEFT_OVER_COLOR}
              strokeWidth={2}
              strokeDasharray="2 3"
              dot={(dot: Dot) =>
                dot.index === last ? (
                  <LeftOverDot key={dot.index} {...dot} hollow />
                ) : (
                  <g key={dot.index} />
                )
              }
              activeDot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartKey
        items={[
          ...BARS.map((bar) => ({ name: bar.type, color: bar.color })),
          { name: "Left over", color: LEFT_OVER_COLOR, mark: "line" },
        ]}
      />
    </>
  );
}

// The chart's numbers, one row per month. Each amount opens its Transactions.
export function CashFlowTable(props: { view: CashFlowReportView }) {
  return (
    <ReportTable
      label="Cash flow by month"
      head="Month"
      columns={[
        ...BARS.map((bar) => ({ key: bar.key, name: bar.type })),
        { key: "left-over", name: "Left over" },
      ]}
      rows={props.view.bars.map((row) => ({
        key: row.month,
        head: monthLabel(`${row.month}-01`),
        cells: [
          ...BARS.map((bar) => (
            <Link key={bar.key} className={CELL_LINK} to={cashFlowHref(row.month, bar.type)}>
              {wholeDollars(row[bar.key])}
            </Link>
          )),
          <Link key="left-over" className={CELL_LINK} to={cashFlowHref(row.month)}>
            {wholeDollars(row.leftOver)}
          </Link>,
        ],
      }))}
    />
  );
}

// The range's totals and averages per month of the four.
export function CashFlowSummary(props: { view: CashFlowReportView }) {
  const line = (label: string, amounts: CashFlowAmounts) => ({
    key: label,
    head: label,
    cells: [...BARS.map((bar) => wholeDollars(amounts[bar.key])), wholeDollars(amounts.leftOver)],
  });
  return (
    <ReportTable
      label="Cash flow over the range"
      head={<span className="sr-only">Over the range</span>}
      columns={[
        ...BARS.map((bar) => ({ key: bar.key, name: bar.type })),
        { key: "left-over", name: "Left over" },
      ]}
      rows={[line("Total", props.view.total), line("Per month", props.view.average)]}
    />
  );
}

// The big number: Left over across the range, green above $0 and orange below. Its line: the
// Income and Spending, and any Saving, it is left over from.
export function cashFlowHeadline(view: CashFlowReportView): Headline {
  const { total } = view;
  const saving = total.saving === 0 ? "" : `, less ${wholeDollars(total.saving)} Saving`;
  const tone = total.leftOver > 0 ? "good" : total.leftOver < 0 ? "serious" : "muted";
  return {
    amount: wholeDollars(total.leftOver),
    unit: "left over",
    line: [
      {
        tone,
        text: `${wholeDollars(total.income)} Income, less ${wholeDollars(total.spending)} Spending${saving}`,
      },
    ],
  };
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
      headline={cashFlowHeadline(view)}
      chart={<CashFlowChart view={view} />}
      caption={`Pale bars and the line's dotted end: ${monthName(view.months.at(-1) ?? "")} so far. Choose a bar or a point to see its Transactions.`}
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
