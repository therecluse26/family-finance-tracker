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
import { CATEGORY_GROUPS, type CategoryGroup } from "../../../categories/list.ts";
import { directionAgainstUsual, monthLabel, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import {
  NO_CATEGORY_YET,
  type SpendingReportBar,
  type SpendingReportView,
} from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import {
  BUDGET_LINE_COLOR,
  GROUP_COLORS,
  SO_FAR_OPACITY,
  SURFACE_COLOR,
  TREND_COLOR,
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
  soFarCaption,
  type TooltipContent,
  tooltipContent,
  X_AXIS,
  Y_AXIS,
} from "./ReportChart.tsx";
import { type Headline, type LinePart, ReportFrame } from "./ReportFrame.tsx";
import { ReportTable } from "./ReportTable.tsx";
import { CELL_LINK, FILTER_LABEL, FILTER_SELECT, useReportView } from "./report-view.ts";

// Spending over time (spec 07, Reports): one stacked bar per month, one color per Category group,
// or per Category of the chosen group, with a dashed line at each month's Budget and a dotted line
// at the usual month. The current month's bar is pale, as "so far". The summary under it holds
// each group's or Category's total, its average per month, and its change from the range before.

const GROUP_NAMES: readonly CategoryGroup[] = CATEGORY_GROUPS.map(({ name }) => name);
const isGroup = (name: string): name is CategoryGroup =>
  (GROUP_NAMES as readonly string[]).includes(name);

// A Category group's color; a Category's is the group colors in turn, as a group has at most six
// Categories.
const SHADES = Object.values(GROUP_COLORS);
export function segmentColor(view: SpendingReportView, name: string): string {
  if (isGroup(name)) return GROUP_COLORS[name];
  if (name === NO_CATEGORY_YET) return TREND_COLOR;
  return SHADES[Math.max(0, view.segments.indexOf(name)) % SHADES.length] ?? TREND_COLOR;
}

// Where a segment's tap goes: a Category opens its Category and month. A Category group, or the
// Spending with no Category yet, opens the month's Spending, since the Transactions page has no
// group filter.
export function segmentHref(view: SpendingReportView, name: string, month: string): string {
  return view.group === null
    ? drillDownHref({ type: "Spending", month })
    : drillDownHref({ category: name, month });
}

// The Reports page with `group` set, or cleared with "", keeping the range and every other filter.
export function groupHref(params: URLSearchParams, group: string): string {
  const query = new URLSearchParams(params);
  if (group === "") query.delete("group");
  else query.set("group", group);
  return `/reports?${query.toString()}#spending`;
}

export const spendingRequests = {
  view: (range: ReportRange, group: CategoryGroup | null) =>
    api.reports.spending.$get({ query: group === null ? { range } : { range, group } }),
};

function GroupFilter(props: { params: URLSearchParams; group: CategoryGroup | null }) {
  const navigate = useNavigate();
  return (
    <label className={FILTER_LABEL}>
      Group
      <select
        className={FILTER_SELECT}
        value={props.group ?? ""}
        onChange={(event) => void navigate(groupHref(props.params, event.target.value))}
      >
        <option value="">All groups</option>
        {GROUP_NAMES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

// A month's hover label: its segments with Spending, top first as the bar stacks them, their total,
// and its Budget.
export function spendingTooltip(view: SpendingReportView, month: string): TooltipContent | null {
  const bar = view.bars.find((each) => each.month === month);
  if (bar === undefined) return null;
  const content = tooltipContent({
    month,
    current: isCurrentMonth(view.months, month),
    items: [...view.segments].reverse().map((name) => ({
      name,
      cents: bar.segments[name] || null,
      color: segmentColor(view, name),
    })),
    total: "Spending",
  });
  if (bar.budget === null) return content;
  return {
    ...content,
    rows: [...content.rows, { name: "Budget", amount: wholeDollars(bar.budget) }],
  };
}

// A Budget with no Budget in the month before or after has no line to draw, such as a Budget set
// this month. It gets a short dash across its bar instead.
export function loneBudget(view: SpendingReportView, index: number | undefined): boolean {
  if (index === undefined || (view.bars[index]?.budget ?? null) === null) return false;
  const near = [view.bars[index - 1], view.bars[index + 1]];
  return near.every((bar) => (bar?.budget ?? null) === null);
}

function BudgetMark(props: { cx?: number; cy?: number; lone: boolean }) {
  const { cx, cy } = props;
  if (!props.lone || cx === undefined || cy === undefined) return <g />;
  return (
    <line x1={cx - 10} x2={cx + 10} y1={cy} y2={cy} stroke={BUDGET_LINE_COLOR} strokeWidth={2} />
  );
}

function SpendingChart(props: { view: SpendingReportView }) {
  const navigate = useNavigate();
  const { view } = props;
  const last = view.bars.length - 1;
  const budget = view.bars.some((bar) => bar.budget !== null);
  return (
    <>
      <div className={CHART_BOX}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            accessibilityLayer={false}
            data={view.bars}
            margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          >
            <CartesianGrid {...GRID} />
            <XAxis {...X_AXIS} />
            <YAxis {...Y_AXIS} />
            {reportTooltip(({ month }) => spendingTooltip(view, month), { cursor: "band" })}
            {view.segments.map((name) => (
              <Bar
                key={name}
                name={name}
                dataKey={(row: SpendingReportBar) => row.segments[name] ?? 0}
                stackId="spending"
                fill={segmentColor(view, name)}
                stroke={SURFACE_COLOR}
                strokeWidth={1}
                cursor="pointer"
                isAnimationActive={false}
                onClick={(item) => {
                  const month = (item.payload as SpendingReportBar | undefined)?.month;
                  if (month !== undefined) void navigate(segmentHref(view, name, month));
                }}
              >
                {view.bars.map((bar, at) => (
                  <Cell key={bar.month} fillOpacity={at === last ? SO_FAR_OPACITY : 1} />
                ))}
              </Bar>
            ))}
            {budget ? (
              <Line
                name="Budget"
                dataKey="budget"
                stroke={BUDGET_LINE_COLOR}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                dot={(dot: { cx?: number; cy?: number; index?: number }) => (
                  <BudgetMark key={dot.index} {...dot} lone={loneBudget(view, dot.index)} />
                )}
                activeDot={false}
                isAnimationActive={false}
              />
            ) : null}
            {view.usual === null ? null : (
              <ReferenceLine y={view.usual} stroke={TREND_COLOR} strokeDasharray="2 3" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartKey
        items={[
          ...view.segments.map((name) => ({ name, color: segmentColor(view, name) })),
          ...(budget
            ? [{ name: "Budget", color: BUDGET_LINE_COLOR, mark: "dashed" as const }]
            : []),
          ...(view.usual === null
            ? []
            : [{ name: "Usual month", color: TREND_COLOR, mark: "dotted" as const }]),
        ]}
      />
    </>
  );
}

// The chart's numbers: each month's segments, its Spending and its Budget. Each amount opens its
// Transactions.
export function SpendingTable(props: { view: SpendingReportView }) {
  const { view } = props;
  return (
    <ReportTable
      label="Spending by month"
      {...(view.usual === null ? {} : { caption: `Usual month: ${wholeDollars(view.usual)}` })}
      head="Month"
      columns={[
        ...view.segments.map((name) => ({ key: name, name })),
        { key: "spending", name: "Spending" },
        { key: "budget", name: "Budget" },
      ]}
      rows={view.bars.map((bar) => ({
        key: bar.month,
        head: monthLabel(`${bar.month}-01`),
        cells: [
          ...view.segments.map((name) => (
            <Link key={name} className={CELL_LINK} to={segmentHref(view, name, bar.month)}>
              {wholeDollars(bar.segments[name] ?? 0)}
            </Link>
          )),
          <Link
            key="spending"
            className={CELL_LINK}
            to={drillDownHref({ type: "Spending", month: bar.month })}
          >
            {wholeDollars(bar.spending)}
          </Link>,
          bar.budget === null ? "" : wholeDollars(bar.budget),
        ],
      }))}
    />
  );
}

// Each group's or Category's total over the range, its average per month, and its change from the
// range before. With no whole range before, the change is empty, and its column is left out.
export function SpendingSummary(props: { view: SpendingReportView }) {
  const { view } = props;
  return (
    <ReportTable
      label="Spending over the range"
      head={view.group === null ? "Category group" : "Category"}
      columns={[
        { key: "total", name: "Total" },
        { key: "average", name: "Per month" },
        { key: "change", name: "Change from the range before" },
      ]}
      rows={view.rows.map((row) => ({
        key: row.name,
        head: row.name,
        cells: [
          wholeDollars(row.total),
          wholeDollars(row.average),
          row.change === null ? "" : wholeDollars(row.change, { signed: true }),
        ],
      }))}
    />
  );
}

const monthsWord = (count: number) => (count === 1 ? "1 month" : `${count} months`);

// The big number: the range's average per month. Its line: the range's total, and the latest
// full month against the usual month, as the dashboard's Spending tile says it.
export function spendingHeadline(view: SpendingReportView): Headline {
  const total = view.rows.reduce((sum, row) => sum + row.total, 0);
  const average = view.rows.reduce((sum, row) => sum + row.average, 0);
  const line: LinePart[] = [`${wholeDollars(total)} over ${monthsWord(view.months.length)}`];
  const full = view.bars.length >= 2 ? view.bars.at(-2) : undefined;
  if (full !== undefined && view.usual !== null) {
    line.push(
      ` · ${monthName(full.month)} ${wholeDollars(full.spending)}, `,
      directionAgainstUsual(full.spending - view.usual, "bad"),
    );
  }
  return { amount: wholeDollars(average), unit: "a month on average", line };
}

// The report as drawn from its view.
export function SpendingReportBody(props: {
  view: SpendingReportView | undefined;
  params: URLSearchParams;
  group: CategoryGroup | null;
  error?: string | undefined;
}) {
  const { view } = props;
  const filter = <GroupFilter params={props.params} group={props.group} />;
  const frame = { id: "spending", title: "Spending over time", filter } as const;
  if (view === undefined)
    return <ReportFrame {...frame} chart={<ErrorLine error={props.error} />} />;
  if (view.bars.every((bar) => bar.spending === 0)) {
    const line = view.months.length === 0 ? "No posted Transactions yet." : "No Spending yet.";
    return <ReportFrame {...frame} chart={<p className="text-muted">{line}</p>} />;
  }
  return (
    <ReportFrame
      {...frame}
      headline={spendingHeadline(view)}
      chart={<SpendingChart view={view} />}
      caption={`${soFarCaption(view.months)} Choose a bar to see its Transactions.`}
      table={<SpendingTable view={view} />}
      summary={<SpendingSummary view={view} />}
    />
  );
}

export function SpendingReport(props: ReportSectionProps) {
  const name = props.params.get("group") ?? "";
  const group = isGroup(name) ? name : null;
  const { view, error } = useReportView<SpendingReportView>(`${props.range} ${group ?? ""}`, () =>
    spendingRequests.view(props.range, group),
  );
  return <SpendingReportBody view={view} params={props.params} group={group} error={error} />;
}
