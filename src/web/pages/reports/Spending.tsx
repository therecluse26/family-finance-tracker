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
import { CATEGORY_GROUPS, type CategoryGroup } from "../../../categories/list.ts";
import { monthLabel, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import {
  NO_CATEGORY_YET,
  type SpendingReportBar,
  type SpendingReportView,
} from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import { BUDGET_LINE_COLOR, GROUP_COLORS, TREND_COLOR } from "../../chart-colors.ts";
import { ErrorLine, FIELD } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { drillDownHref } from "./drill-down.ts";
import { ReportFrame } from "./ReportFrame.tsx";
import { CELL_LINK, TABLE, TD, TD_NUMBER, TH, TH_NUMBER, useReportView } from "./report-view.ts";

// Spending over time (spec 07, Reports): one stacked bar per month, one color per Category group,
// or per Category of the chosen group, with a dashed line at each month's Budget and a dashed line
// at the usual month. The table under it holds each group's or Category's total, its average per
// month, and its change from the range before.

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
    <label className="flex items-center gap-2 text-sm">
      Category group
      <select
        className={`${FIELD} mt-0 w-auto py-1.5`}
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

type ChartRow = SpendingReportBar & { label: string };

function SpendingChart(props: { view: SpendingReportView }) {
  const navigate = useNavigate();
  const { view } = props;
  const rows: ChartRow[] = view.bars.map((bar) => ({
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
            {view.segments.map((name) => (
              <Bar
                key={name}
                name={name}
                dataKey={(row: ChartRow) => row.segments[name] ?? 0}
                stackId="spending"
                fill={segmentColor(view, name)}
                cursor="pointer"
                isAnimationActive={false}
                onClick={(item) => {
                  const month = (item.payload as ChartRow | undefined)?.month;
                  if (month !== undefined) void navigate(segmentHref(view, name, month));
                }}
              />
            ))}
            <Line
              name="Budget"
              dataKey="budget"
              stroke={BUDGET_LINE_COLOR}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
            {view.usual === null ? null : (
              <ReferenceLine y={view.usual} stroke={TREND_COLOR} strokeDasharray="3 3" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted">
        {view.segments.map((name) => (
          <li key={name} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ backgroundColor: segmentColor(view, name) }}
            />
            {name}
          </li>
        ))}
        <li>– – Budget</li>
        {view.usual === null ? null : <li>··· Usual month: {wholeDollars(view.usual)}</li>}
      </ul>
    </>
  );
}

// The chart's numbers: each month's segments, its Spending and its Budget. Each amount opens its
// Transactions.
export function SpendingTable(props: { view: SpendingReportView }) {
  const { view } = props;
  return (
    <div className="overflow-x-auto">
      <table className={TABLE} aria-label="Spending by month">
        {view.usual === null ? null : (
          <caption className="text-left text-small text-muted">
            Usual month: {wholeDollars(view.usual)}
          </caption>
        )}
        <thead>
          <tr>
            <th className={TH}>Month</th>
            {view.segments.map((name) => (
              <th key={name} className={TH_NUMBER}>
                {name}
              </th>
            ))}
            <th className={TH_NUMBER}>Spending</th>
            <th className={TH_NUMBER}>Budget</th>
          </tr>
        </thead>
        <tbody>
          {view.bars.map((bar) => (
            <tr key={bar.month}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                {monthLabel(`${bar.month}-01`)}
              </th>
              {view.segments.map((name) => (
                <td key={name} className={TD_NUMBER}>
                  <Link className={CELL_LINK} to={segmentHref(view, name, bar.month)}>
                    {wholeDollars(bar.segments[name] ?? 0)}
                  </Link>
                </td>
              ))}
              <td className={TD_NUMBER}>
                <Link
                  className={CELL_LINK}
                  to={drillDownHref({ type: "Spending", month: bar.month })}
                >
                  {wholeDollars(bar.spending)}
                </Link>
              </td>
              <td className={TD_NUMBER}>{bar.budget === null ? "" : wholeDollars(bar.budget)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Each group's or Category's total over the range, its average per month, and its change from the
// range before. With no whole range before, the change is empty.
export function SpendingSummary(props: { view: SpendingReportView }) {
  const { view } = props;
  return (
    <div className="overflow-x-auto">
      <table className={TABLE} aria-label="Spending over the range">
        <thead>
          <tr>
            <th className={TH}>{view.group === null ? "Category group" : "Category"}</th>
            <th className={TH_NUMBER}>Total</th>
            <th className={TH_NUMBER}>Per month</th>
            <th className={TH_NUMBER}>Change from the range before</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.name}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                {row.name}
              </th>
              <td className={TD_NUMBER}>{wholeDollars(row.total)}</td>
              <td className={TD_NUMBER}>{wholeDollars(row.average)}</td>
              <td className={TD_NUMBER}>
                {row.change === null ? "" : wholeDollars(row.change, { signed: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
      chart={<SpendingChart view={view} />}
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
