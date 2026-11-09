import { Link, useNavigate } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { directionAgainstUsual, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import type { MerchantsReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import {
  BUDGET_LINE_COLOR,
  SO_FAR_OPACITY,
  SURFACE_COLOR,
  TREND_COLOR,
} from "../../chart-colors.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import { Meter } from "../../components/Meter.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { merchantMonthHref } from "./merchant-words.ts";
import {
  CHART_BOX,
  ChartKey,
  GRID,
  isCurrentMonth,
  monthLabelOf,
  monthName,
  reportTooltip,
  soFarCaption,
  tooltipContent,
  X_AXIS,
  Y_AXIS,
} from "./ReportChart.tsx";
import { type Headline, type LinePart, ReportFrame } from "./ReportFrame.tsx";
import { ReportTable } from "./ReportTable.tsx";
import { CELL_LINK, FILTER_LABEL, FILTER_SELECT, useReportView } from "./report-view.ts";

// Merchants (spec 07, Reports): the top 10 Merchants of the range as a ranked list, each with its
// total, a bar against the top one, and a small line of its months; or one Merchant's months as
// bars with its usual month. The Merchant filter lives in the address as `merchant`, a Merchant
// group's key; a tap on a row of the list sets it. Each bar opens the Transactions page for its
// Merchant and month.

const BAR_COLOR = TREND_COLOR;

// The page with the Merchant filter set to `key`, or cleared, keeping the range and every other
// parameter, at this section.
export function merchantFilterHref(params: URLSearchParams, key: string): string {
  const query = new URLSearchParams(params);
  if (key === "") query.delete("merchant");
  else query.set("merchant", key);
  const search = query.toString();
  return `/reports${search === "" ? "" : `?${search}`}#merchants`;
}

// The Merchant filter: the top 10, or one of them.
export function MerchantFilter(props: {
  params: URLSearchParams;
  merchant: string | null;
  choices: readonly { key: string; merchantName: string }[];
}) {
  const navigate = useNavigate();
  const known = props.choices.some((choice) => choice.key === props.merchant);
  return (
    <label className={FILTER_LABEL}>
      Merchant
      <select
        className={FILTER_SELECT}
        value={props.merchant ?? ""}
        onChange={(event) => void navigate(merchantFilterHref(props.params, event.target.value))}
      >
        <option value="">Top 10</option>
        {props.choices.map((choice) => (
          <option key={choice.key} value={choice.key}>
            {choice.merchantName}
          </option>
        ))}
        {props.merchant === null || known ? null : (
          <option value={props.merchant}>No such Merchant</option>
        )}
      </select>
    </label>
  );
}

type DrillMerchant = { merchantId: string | null; merchantName: string };

// A table cell: the Merchant's month, as a link to its Transactions when a filter names that
// Merchant alone.
export function MonthCell(props: { merchant: DrillMerchant; month: string; cents: number }) {
  const href = merchantMonthHref(props.merchant, props.month);
  const amount = wholeDollars(props.cents);
  return href === null ? (
    amount
  ) : (
    <Link className={CELL_LINK} to={href}>
      {amount}
    </Link>
  );
}

// A Merchant's last 12 months as a small line: grey, with the current month's point hollow at the
// end of a dotted stretch, as "so far". It shows a shape its row already says in numbers, so
// screen readers skip it.
export function Sparkline(props: { values: readonly number[] }) {
  const values = props.values.slice(-12);
  const width = 84;
  const height = 24;
  const top = Math.max(...values, 1);
  const step = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  const points = values.map((value, at) => ({
    x: 3 + at * step,
    y: 3 + (height - 6) * (1 - value / top),
  }));
  const path = (from: number, to: number) =>
    points
      .slice(from, to)
      .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(" ");
  const last = points.at(-1);
  return (
    <svg
      aria-hidden="true"
      className="block shrink-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-slot="sparkline"
    >
      <polyline
        points={path(0, -1)}
        fill="none"
        stroke={BUDGET_LINE_COLOR}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <polyline
        points={path(-2, points.length)}
        fill="none"
        stroke={BUDGET_LINE_COLOR}
        strokeWidth={1.5}
        strokeDasharray="2 2"
      />
      {last === undefined ? null : (
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          fill={SURFACE_COLOR}
          stroke={BUDGET_LINE_COLOR}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

// The top 10 as a ranked list, as on the Top Merchants page. A row opens that Merchant's own
// view.
export function MerchantRanks(props: { view: MerchantsReportView; params: URLSearchParams }) {
  const { series } = props.view;
  const top = Math.max(...series.map((each) => each.total), 0);
  return (
    <ol data-slot="merchant-ranks">
      {series.map((each, place) => (
        <li key={each.key} className="border-t border-line-soft first:border-t-0">
          <Link
            className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-control px-1 py-2.5 text-sm hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:grid-cols-[1.5rem_minmax(0,1.2fr)_minmax(0,1.6fr)_5.5rem_5.5rem]"
            to={merchantFilterHref(props.params, each.key)}
          >
            <span className="text-muted tabular-nums">{place + 1}</span>
            <span className="min-w-0 font-semibold break-words text-ink">{each.merchantName}</span>
            <Meter
              share={top > 0 ? each.total / top : 0}
              track={false}
              size="normal"
              className="col-start-2 sm:col-start-3 sm:row-start-1"
            />
            <span className="col-start-3 row-start-2 justify-self-end sm:col-start-4 sm:row-start-1">
              <Sparkline values={each.byMonth} />
            </span>
            <span className="col-start-3 row-start-1 text-right tabular-nums sm:col-start-5">
              {wholeDollars(each.total)}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

// One Merchant's months as bars, the current one pale, with a dashed line at its usual month.
function OneMerchantChart(props: { view: MerchantsReportView }) {
  const navigate = useNavigate();
  const { months, series, usual } = props.view;
  const [one] = series;
  if (one === undefined) return null;
  const rows = months.map((month, index) => ({ month, spending: one.byMonth[index] ?? 0 }));
  return (
    <>
      <div className={CHART_BOX}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          >
            <CartesianGrid {...GRID} />
            <XAxis {...X_AXIS} />
            <YAxis {...Y_AXIS} />
            {reportTooltip(
              ({ month }) =>
                tooltipContent({
                  month,
                  current: isCurrentMonth(months, month),
                  items: [
                    {
                      name: one.merchantName,
                      cents: rows.find((row) => row.month === month)?.spending ?? null,
                      color: BAR_COLOR,
                    },
                    ...(usual === null ? [] : [{ name: "Usual month", cents: usual }]),
                  ],
                }),
              { cursor: "band" },
            )}
            <Bar
              dataKey="spending"
              fill={BAR_COLOR}
              className="cursor-pointer"
              isAnimationActive={false}
              onClick={(_, index) => {
                const month = months[index];
                const href = month === undefined ? null : merchantMonthHref(one, month);
                if (href !== null) void navigate(href);
              }}
            >
              {rows.map((row, at) => (
                <Cell key={row.month} fillOpacity={at === rows.length - 1 ? SO_FAR_OPACITY : 1} />
              ))}
            </Bar>
            {usual === null ? null : (
              <ReferenceLine y={usual} stroke={BUDGET_LINE_COLOR} strokeDasharray="5 4" />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ChartKey
        items={[
          { name: one.merchantName, color: BAR_COLOR },
          ...(usual === null
            ? []
            : [{ name: "Usual month", color: BUDGET_LINE_COLOR, mark: "dashed" as const }]),
        ]}
      />
    </>
  );
}

// The chart's numbers: one row a month, one column a Merchant, each a link to its Transactions.
export function MerchantsTable(props: { view: MerchantsReportView }) {
  const { months, series, usual } = props.view;
  const title =
    props.view.merchant === null
      ? "Spending at the top Merchants, by month"
      : `Spending at ${series[0]?.merchantName ?? "this Merchant"}, by month`;
  return (
    <ReportTable
      label={title}
      caption={title}
      slot="merchants-table"
      head="Month"
      columns={series.map((each) => ({ key: each.key, name: each.merchantName }))}
      rows={months.map((month, index) => ({
        key: month,
        head: monthLabelOf(month),
        cells: series.map((each) => (
          <MonthCell
            key={each.key}
            merchant={each}
            month={month}
            cents={each.byMonth[index] ?? 0}
          />
        )),
      }))}
      foot={
        usual === null ? [] : [{ key: "usual", head: "Usual month", cells: [wholeDollars(usual)] }]
      }
    />
  );
}

const monthsWord = (count: number) => (count === 1 ? "1 month" : `${count} months`);

// The big number: the top Merchant's total over the range. Its line: how many the list holds
// and their total. For one Merchant: its total, and its latest full month against its usual.
export function merchantsHeadline(view: MerchantsReportView): Headline | undefined {
  const [top] = view.series;
  if (top === undefined) return undefined;
  const range = monthsWord(view.months.length);
  if (view.merchant !== null) {
    const line: LinePart[] = [`Over ${range}`];
    const latest = view.months.length >= 2 ? view.months.length - 2 : undefined;
    const spent = latest === undefined ? undefined : top.byMonth[latest];
    const month = latest === undefined ? undefined : view.months[latest];
    if (view.usual !== null && spent !== undefined && month !== undefined) {
      line.push(
        ` · ${monthName(month)} ${wholeDollars(spent)}, `,
        directionAgainstUsual(spent - view.usual, "bad"),
      );
    }
    return { amount: wholeDollars(top.total), unit: `at ${top.merchantName}`, line };
  }
  const all = view.series.reduce((sum, each) => sum + each.total, 0);
  const count = view.series.length;
  return {
    amount: wholeDollars(top.total),
    unit: `at ${top.merchantName}`,
    line: [
      `The top ${count === 1 ? "Merchant" : `${count} Merchants`}: ${wholeDollars(all)} over ${range}`,
    ],
  };
}

// The card, once its view is loaded.
export function MerchantsReportCard(props: {
  params: URLSearchParams;
  merchants?: MerchantsReportView | undefined;
  error?: string | undefined;
}) {
  const { merchants } = props;
  const merchant = merchants?.merchant ?? (props.params.get("merchant")?.trim() || null);
  const filter = (
    <MerchantFilter params={props.params} merchant={merchant} choices={merchants?.choices ?? []} />
  );
  const frame = { id: "merchants", title: "Merchants", filter } as const;
  if (merchants === undefined) {
    return <ReportFrame {...frame} chart={<ErrorLine error={props.error} />} />;
  }
  if (merchants.series.length === 0) {
    const noHistory = merchants.months.length === 0;
    const line =
      merchant === null || noHistory ? "No Spending yet." : "No Spending at this Merchant.";
    return <ReportFrame {...frame} chart={<p className="text-muted">{line}</p>} />;
  }
  const headline = merchantsHeadline(merchants);
  const one = merchants.merchant !== null;
  return (
    <ReportFrame
      {...frame}
      {...(headline === undefined ? {} : { headline })}
      chart={
        one ? (
          <OneMerchantChart view={merchants} />
        ) : (
          <MerchantRanks view={merchants} params={props.params} />
        )
      }
      chartReads={!one}
      caption={
        one
          ? `${soFarCaption(merchants.months)} Choose a bar to see its Transactions.`
          : `Small lines: each Merchant's months, the dotted end ${monthName(merchants.months.at(-1) ?? "")} so far. Choose a Merchant to see its months.`
      }
      table={<MerchantsTable view={merchants} />}
    />
  );
}

export const merchantsReportRequests = {
  merchants: (range: ReportRange, merchant: string | null) =>
    api.reports.merchants.$get({
      query: merchant === null ? { range } : { range, merchant },
    }),
};

export function MerchantsReport(props: ReportSectionProps) {
  const merchant = props.params.get("merchant")?.trim() || null;
  const { view, error } = useReportView<MerchantsReportView>(
    `${props.range} ${merchant ?? ""}`,
    () => merchantsReportRequests.merchants(props.range, merchant),
  );
  return <MerchantsReportCard params={props.params} merchants={view} error={error} />;
}
