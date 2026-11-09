import { useNavigate } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceDot,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { dollarsAndCents, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import type { RecurringReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import {
  FULL_COLOR,
  MUTED_COLOR,
  SO_FAR_OPACITY,
  SURFACE_COLOR,
  TREND_COLOR,
} from "../../chart-colors.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { MonthCell } from "./Merchants.tsx";
import { merchantMonthHref } from "./merchant-words.ts";
import {
  CHART_BOX,
  ChartKey,
  dollarTicks,
  GRID,
  isCurrentMonth,
  monthLabelOf,
  monthName,
  monthWords,
  reportTooltip,
  type TooltipContent,
  X_AXIS,
  Y_AXIS,
} from "./ReportChart.tsx";
import { type Headline, type LinePart, ReportFrame } from "./ReportFrame.tsx";
import { ReportTable } from "./ReportTable.tsx";
import { useReportView } from "./report-view.ts";

// Recurring charges (spec 07, Reports): each month's Recurring charge payments as one grey stack,
// a charge to a segment, with a ring over a month with a price change. The segment under the
// pointer turns blue and its hover label names the charge. Each segment opens the Transactions
// page for its charge's Merchant and month. Under it, each charge now against a year ago.

const SEGMENT_COLOR = TREND_COLOR;
const OTHER_COLOR = MUTED_COLOR;

// "Streamly $15.49 to $17.99", or "Streamly $17.99" with no payment before.
const priceChangeText = (change: RecurringReportView["priceChanges"][number]) =>
  `${change.name} ${change.before === null ? "" : `${dollarsAndCents(change.before)} to `}${dollarsAndCents(change.amount)}`;

// The hover label of one segment: the month, its charge's payments and any price change, and
// the month's total.
export function recurringTooltip(
  view: RecurringReportView,
  month: string,
  dataKey: string | undefined,
): TooltipContent | null {
  const index = view.months.indexOf(month);
  if (index < 0) return null;
  const at = dataKey?.startsWith("c") ? Number(dataKey.slice(1)) : undefined;
  const charge = at === undefined ? undefined : view.charges[at];
  const rows =
    charge !== undefined
      ? [
          { name: charge.name, amount: dollarsAndCents(charge.byMonth[index] ?? 0) },
          ...view.priceChanges
            .filter((change) => change.chargeId === charge.id && change.month === month)
            .map((change) => ({
              name: "Price change",
              amount: `${change.before === null ? "" : `${dollarsAndCents(change.before)} to `}${dollarsAndCents(change.amount)}`,
            })),
        ]
      : dataKey === "other"
        ? [
            {
              name: `Other (${view.other.count})`,
              amount: dollarsAndCents(view.other.byMonth[index] ?? 0),
            },
          ]
        : [];
  return {
    title: `${monthWords(month)}${isCurrentMonth(view.months, month) ? " so far" : ""}`,
    rows,
    total: { name: "All Recurring charges", amount: dollarsAndCents(view.totals[index] ?? 0) },
  };
}

function RecurringChart(props: { view: RecurringReportView }) {
  const navigate = useNavigate();
  const { view } = props;
  const { months, charges, other, totals, priceChanges } = view;
  const rows = months.map((month, index) => ({
    month,
    ...Object.fromEntries(charges.map((each, place) => [`c${place}`, each.byMonth[index] ?? 0])),
    other: other.byMonth[index] ?? 0,
  }));
  const marked = [...new Set(priceChanges.map((change) => change.month))];
  const ticks = dollarTicks(Math.max(0, ...totals));
  const pale = (key: string) =>
    rows.map((row, at) => (
      <Cell key={`${key}-${row.month}`} fillOpacity={at === rows.length - 1 ? SO_FAR_OPACITY : 1} />
    ));
  return (
    <>
      <div className={CHART_BOX}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 12, right: 4, bottom: 0, left: 0 }}
          >
            <CartesianGrid {...GRID} />
            <XAxis {...X_AXIS} />
            <YAxis {...Y_AXIS} ticks={ticks} domain={[0, ticks.at(-1) ?? 0]} />
            {reportTooltip(({ month, dataKey }) => recurringTooltip(view, month, dataKey), {
              cursor: "band",
              item: true,
            })}
            {charges.map((each, place) => (
              <Bar
                key={each.id}
                dataKey={`c${place}`}
                name={each.name}
                stackId="charges"
                fill={SEGMENT_COLOR}
                stroke={SURFACE_COLOR}
                strokeWidth={1}
                activeBar={{ fill: FULL_COLOR, fillOpacity: 1 }}
                className="cursor-pointer"
                isAnimationActive={false}
                onClick={(_, index) => {
                  const month = months[index];
                  const href = month === undefined ? null : merchantMonthHref(each, month);
                  if (href !== null) void navigate(href);
                }}
              >
                {pale(each.id)}
              </Bar>
            ))}
            {other.count === 0 ? null : (
              <Bar
                dataKey="other"
                name="Other"
                stackId="charges"
                fill={OTHER_COLOR}
                stroke={SURFACE_COLOR}
                strokeWidth={1}
                activeBar={{ fill: FULL_COLOR, fillOpacity: 1 }}
                isAnimationActive={false}
              >
                {pale("other")}
              </Bar>
            )}
            {marked.map((month) => (
              <ReferenceDot
                key={month}
                x={month}
                y={totals[months.indexOf(month)] ?? 0}
                r={4.5}
                fill={SURFACE_COLOR}
                stroke={FULL_COLOR}
                strokeWidth={2}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartKey
        items={[
          { name: "A Recurring charge", color: SEGMENT_COLOR },
          ...(other.count === 0 ? [] : [{ name: `Other (${other.count})`, color: OTHER_COLOR }]),
        ]}
      />
    </>
  );
}

// The chart's numbers: one row a month, one column a Recurring charge, with Other, the total, and
// the month's price changes.
export function RecurringTable(props: { view: RecurringReportView }) {
  const { months, charges, other, totals, priceChanges } = props.view;
  return (
    <ReportTable
      label="Recurring charges, by month"
      caption="Recurring charges, by month"
      slot="recurring-table"
      head="Month"
      columns={[
        ...charges.map((each) => ({ key: each.id, name: each.name })),
        ...(other.count === 0 ? [] : [{ key: "other", name: `Other (${other.count})` }]),
        { key: "total", name: "Total" },
        { key: "price-changes", name: "Price changes", align: "left" as const },
      ]}
      rows={months.map((month, index) => ({
        key: month,
        head: monthLabelOf(month),
        cells: [
          ...charges.map((each) => (
            <MonthCell
              key={each.id}
              merchant={each}
              month={month}
              cents={each.byMonth[index] ?? 0}
            />
          )),
          ...(other.count === 0 ? [] : [wholeDollars(other.byMonth[index] ?? 0)]),
          wholeDollars(totals[index] ?? 0),
          priceChanges
            .filter((change) => change.month === month)
            .map(priceChangeText)
            .join("; "),
        ],
      }))}
    />
  );
}

// Each Recurring charge's amount now against a year ago.
export function ChargeChangesTable(props: { view: RecurringReportView }) {
  const amount = (cents: number | null) => (cents === null ? "None" : dollarsAndCents(cents));
  return (
    <ReportTable
      label="Recurring charges now and a year ago"
      caption="Now and a year ago"
      slot="charge-changes"
      head="Charge"
      columns={[
        { key: "now", name: "Now" },
        { key: "year-ago", name: "A year ago" },
        { key: "change", name: "Change" },
      ]}
      rows={props.view.changes.map((charge) => ({
        key: charge.id,
        head: charge.name,
        cells: [
          charge.now === null ? "Ended" : amount(charge.now),
          amount(charge.yearAgo),
          charge.change === null ? "" : dollarsAndCents(charge.change, { signed: true }),
        ],
      }))}
    />
  );
}

// The big number: the latest full month's Recurring charges, or the current month's so far when
// it is the only one. Its line: how the charges' prices moved against a year ago, summed over the
// charges with a price then and now; lower is green and higher orange.
export function recurringHeadline(view: RecurringReportView): Headline | undefined {
  const index = view.months.length >= 2 ? view.months.length - 2 : view.months.length - 1;
  const month = view.months[index];
  if (month === undefined) return undefined;
  const changed = view.changes.filter((charge) => charge.change !== null);
  const sum = changed.reduce((total, charge) => total + (charge.change ?? 0), 0);
  const line: LinePart[] = [];
  if (changed.length > 0) {
    line.push(
      sum === 0
        ? { tone: "muted", text: "● Prices the same as a year ago" }
        : {
            tone: sum > 0 ? "serious" : "good",
            text: `${sum > 0 ? "▲" : "▼"} Prices ${dollarsAndCents(Math.abs(sum))} ${sum > 0 ? "higher" : "lower"} than a year ago`,
          },
    );
  }
  const current = isCurrentMonth(view.months, month);
  return {
    amount: wholeDollars(view.totals[index] ?? 0),
    unit: `in ${monthName(month)}${current ? " so far" : ""}`,
    line,
  };
}

const Empty = () => <p className="text-muted">No Recurring charge payments yet.</p>;

// The card, once its view is loaded.
export function RecurringReportCard(props: {
  recurring?: RecurringReportView | undefined;
  error?: string | undefined;
}) {
  const { recurring } = props;
  const frame = { id: "recurring", title: "Recurring charges" } as const;
  if (recurring === undefined) {
    return <ReportFrame {...frame} chart={<ErrorLine error={props.error} />} />;
  }
  if (recurring.changes.length === 0) return <ReportFrame {...frame} chart={<Empty />} />;
  const headline = recurringHeadline(recurring);
  const ring = recurring.priceChanges.length === 0 ? "" : " A ring marks a price change.";
  return (
    <ReportFrame
      {...frame}
      {...(headline === undefined ? {} : { headline })}
      chart={<RecurringChart view={recurring} />}
      caption={`Pale bar: ${monthName(recurring.months.at(-1) ?? "")} so far.${ring} Choose a charge to see its Transactions.`}
      summary={<ChargeChangesTable view={recurring} />}
      table={<RecurringTable view={recurring} />}
    />
  );
}

export const recurringReportRequests = {
  recurring: (range: ReportRange) => api.reports.recurring.$get({ query: { range } }),
};

export function RecurringReport(props: ReportSectionProps) {
  const { view, error } = useReportView<RecurringReportView>(props.range, () =>
    recurringReportRequests.recurring(props.range),
  );
  return <RecurringReportCard recurring={view} error={error} />;
}
