import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dollarsAndCents, monthLabel, wholeDollars } from "../../../format.ts";
import type { ReportRange } from "../../../reports/range.ts";
import type { MerchantsReportView, RecurringReportView } from "../../../server/reports-views.ts";
import { api } from "../../api.ts";
import { BUDGET_LINE_COLOR, GROUP_COLORS } from "../../chart-colors.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import type { ReportSectionProps } from "../../reports.ts";
import { merchantMonthHref } from "./merchant-words.ts";
import { ReportFrame } from "./ReportFrame.tsx";

// Merchants and Recurring charges (spec 07, Reports): Spending at the top 10 Merchants by month, or
// at one Merchant with its usual month, and the Recurring charges' payments by month with their
// price changes. The Merchant filter lives in the address as `merchant`, a Merchant group's key.
// Each point and bar opens the Transactions page for its Merchant and month.

// Ten colours for the Merchants' lines and the Recurring charges' bars: the Category groups' five
// mid tones, then five more of the same weight. "Other" is the groups' grey.
const SERIES_COLORS = [
  GROUP_COLORS.Bills,
  GROUP_COLORS.Shopping,
  GROUP_COLORS.Transportation,
  GROUP_COLORS["Health and care"],
  GROUP_COLORS.Leisure,
  "#2F8740",
  "#B5512B",
  "#1F7FA8",
  "#97710C",
  "#9B4FB0",
] as const;
const OTHER_COLOR = GROUP_COLORS.Other;
const colorOf = (index: number) => SERIES_COLORS[index % SERIES_COLORS.length] ?? OTHER_COLOR;

const TICK = { fill: "#4b5563", fontSize: 12 };
const monthText = (month: string) => monthLabel(`${month}-01`);

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
    <label className="flex items-center gap-2 text-sm">
      Merchant
      <select
        className="block h-9 rounded-control border border-field bg-white px-3 text-sm text-ink"
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

// A tap on a bar or a point opens its Merchant's month, when a filter names that Merchant alone.
function openMonth(
  navigate: ReturnType<typeof useNavigate>,
  merchant: DrillMerchant,
  month: string | undefined,
) {
  const href = month === undefined ? null : merchantMonthHref(merchant, month);
  if (href !== null) void navigate(href);
}

// A table cell: the Merchant's month, as a link to its Transactions when a filter names that
// Merchant alone.
function MonthCell(props: { merchant: DrillMerchant; month: string; cents: number }) {
  const href = merchantMonthHref(props.merchant, props.month);
  const amount = wholeDollars(props.cents);
  return (
    <td className="text-right">
      {href === null ? (
        amount
      ) : (
        <Link className="hover:underline" to={href}>
          {amount}
        </Link>
      )}
    </td>
  );
}

function MerchantsChart(props: { view: MerchantsReportView }) {
  const navigate = useNavigate();
  const pointed = useRef("");
  const { months, series, usual } = props.view;
  const [one] = series;
  if (props.view.merchant !== null && one !== undefined) {
    const rows = months.map((month, index) => ({ month, spending: one.byMonth[index] ?? 0 }));
    return (
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 8, left: 8 }}>
            <CartesianGrid stroke="#e5e7eb" vertical={false} />
            <XAxis dataKey="month" tickFormatter={monthText} tick={TICK} />
            <YAxis tickFormatter={(cents: number) => wholeDollars(cents)} tick={TICK} width={80} />
            <Tooltip
              labelFormatter={(month) => monthText(String(month))}
              formatter={(cents) => [wholeDollars(Number(cents)), one.merchantName]}
            />
            <Bar
              dataKey="spending"
              fill={colorOf(0)}
              className="cursor-pointer"
              isAnimationActive={false}
              onClick={(_, index) => openMonth(navigate, one, months[index])}
            />
            {usual === null ? null : (
              <ReferenceLine
                y={usual}
                stroke={BUDGET_LINE_COLOR}
                strokeDasharray="6 4"
                label={{ value: "Usual", position: "insideTopRight", fill: BUDGET_LINE_COLOR }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  const rows = months.map((month, index) => ({
    month,
    ...Object.fromEntries(series.map((each, place) => [`m${place}`, each.byMonth[index] ?? 0])),
  }));
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          accessibilityLayer={false}
          data={rows}
          margin={{ top: 8, right: 8, left: 8 }}
          // The point under the pointer is the month's: a tap on a line's point opens it.
          onMouseMove={(state) => {
            pointed.current = String(state.activeLabel ?? "");
          }}
        >
          <CartesianGrid stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthText} tick={TICK} />
          <YAxis tickFormatter={(cents: number) => wholeDollars(cents)} tick={TICK} width={80} />
          <Tooltip
            labelFormatter={(month) => monthText(String(month))}
            formatter={(cents) => wholeDollars(Number(cents))}
          />
          <Legend />
          {series.map((each, place) => (
            <Line
              key={each.key}
              dataKey={`m${place}`}
              name={each.merchantName}
              stroke={colorOf(place)}
              isAnimationActive={false}
              activeDot={{
                r: 5,
                className: "cursor-pointer",
                onClick: () => {
                  if (months.includes(pointed.current)) openMonth(navigate, each, pointed.current);
                },
              }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums" data-slot="merchants-table">
        <caption className="text-left font-semibold">{title}</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">
              Month
            </th>
            {series.map((each) => (
              <th key={each.key} scope="col" className="text-right">
                {each.merchantName}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((month, index) => (
            <tr key={month}>
              <th scope="row" className="text-left font-normal">
                {monthText(month)}
              </th>
              {series.map((each) => (
                <MonthCell
                  key={each.key}
                  merchant={each}
                  month={month}
                  cents={each.byMonth[index] ?? 0}
                />
              ))}
            </tr>
          ))}
        </tbody>
        {usual === null ? null : (
          <tfoot>
            <tr>
              <th scope="row" className="text-left">
                Usual month
              </th>
              <td className="text-right">{wholeDollars(usual)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function RecurringChart(props: { view: RecurringReportView }) {
  const navigate = useNavigate();
  const { months, charges, other, totals, priceChanges } = props.view;
  const rows = months.map((month, index) => ({
    month,
    ...Object.fromEntries(charges.map((each, place) => [`c${place}`, each.byMonth[index] ?? 0])),
    other: other.byMonth[index] ?? 0,
  }));
  const marked = [...new Set(priceChanges.map((change) => change.month))];
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={rows} margin={{ top: 16, right: 8, left: 8 }}>
          <CartesianGrid stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthText} tick={TICK} />
          <YAxis tickFormatter={(cents: number) => wholeDollars(cents)} tick={TICK} width={80} />
          <Tooltip
            labelFormatter={(month) => monthText(String(month))}
            formatter={(cents) => wholeDollars(Number(cents))}
          />
          <Legend />
          {charges.map((each, place) => (
            <Bar
              key={each.id}
              dataKey={`c${place}`}
              name={each.name}
              stackId="charges"
              fill={colorOf(place)}
              className="cursor-pointer"
              isAnimationActive={false}
              onClick={(_, index) => openMonth(navigate, each, months[index])}
            />
          ))}
          {other.count === 0 ? null : (
            <Bar
              dataKey="other"
              name="Other"
              stackId="charges"
              fill={OTHER_COLOR}
              isAnimationActive={false}
            />
          )}
          {marked.map((month) => (
            <ReferenceDot
              key={month}
              x={month}
              y={totals[months.indexOf(month)] ?? 0}
              r={5}
              fill="#ffffff"
              stroke="#14171C"
              strokeWidth={2}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// "Streamly $15.49 to $17.99", or "Streamly $17.99" with no payment before.
const priceChangeText = (change: RecurringReportView["priceChanges"][number]) =>
  `${change.name} ${change.before === null ? "" : `${dollarsAndCents(change.before)} to `}${dollarsAndCents(change.amount)}`;

// The chart's numbers: one row a month, one column a Recurring charge, with Other, the total, and
// the month's price changes.
export function RecurringTable(props: { view: RecurringReportView }) {
  const { months, charges, other, totals, priceChanges } = props.view;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums" data-slot="recurring-table">
        <caption className="text-left font-semibold">Recurring charges, by month</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">
              Month
            </th>
            {charges.map((each) => (
              <th key={each.id} scope="col" className="text-right">
                {each.name}
              </th>
            ))}
            {other.count === 0 ? null : (
              <th scope="col" className="text-right">
                Other ({other.count})
              </th>
            )}
            <th scope="col" className="text-right">
              Total
            </th>
            <th scope="col" className="text-left">
              Price changes
            </th>
          </tr>
        </thead>
        <tbody>
          {months.map((month, index) => (
            <tr key={month}>
              <th scope="row" className="text-left font-normal">
                {monthText(month)}
              </th>
              {charges.map((each) => (
                <MonthCell
                  key={each.id}
                  merchant={each}
                  month={month}
                  cents={each.byMonth[index] ?? 0}
                />
              ))}
              {other.count === 0 ? null : (
                <td className="text-right">{wholeDollars(other.byMonth[index] ?? 0)}</td>
              )}
              <td className="text-right">{wholeDollars(totals[index] ?? 0)}</td>
              <td data-slot="price-changes">
                {priceChanges
                  .filter((change) => change.month === month)
                  .map(priceChangeText)
                  .join("; ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Each Recurring charge's amount now against a year ago.
export function ChargeChangesTable(props: { view: RecurringReportView }) {
  const amount = (cents: number | null) => (cents === null ? "None" : dollarsAndCents(cents));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums" data-slot="charge-changes">
        <caption className="text-left font-semibold">Recurring charges now and a year ago</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left">
              Charge
            </th>
            <th scope="col" className="text-right">
              Now
            </th>
            <th scope="col" className="text-right">
              A year ago
            </th>
            <th scope="col" className="text-right">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {props.view.changes.map((charge) => (
            <tr key={charge.id}>
              <th scope="row" className="text-left font-normal">
                {charge.name}
              </th>
              <td className="text-right">{charge.now === null ? "Ended" : amount(charge.now)}</td>
              <td className="text-right">{amount(charge.yearAgo)}</td>
              <td className="text-right">
                {charge.change === null ? "" : dollarsAndCents(charge.change, { signed: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Empty = (props: { children: string }) => <p className="text-muted">{props.children}</p>;

// The section with its two views, once they are loaded.
export function MerchantsReportCard(props: {
  params: URLSearchParams;
  merchants?: MerchantsReportView | undefined;
  recurring?: RecurringReportView | undefined;
  error?: string | undefined;
}) {
  const { merchants, recurring } = props;
  const merchant = merchants?.merchant ?? (props.params.get("merchant")?.trim() || null);
  const noHistory = merchants?.months.length === 0;
  const merchantsEmpty =
    merchants === undefined || merchants.series.length === 0 ? (
      <Empty>
        {merchant === null || noHistory ? "No Spending yet." : "No Spending at this Merchant."}
      </Empty>
    ) : null;
  const recurringEmpty =
    recurring === undefined || recurring.changes.length === 0 ? (
      <Empty>No Recurring charge payments yet.</Empty>
    ) : null;
  const loaded = merchants !== undefined && recurring !== undefined;
  const heading = (text: string) => <h3 className="mt-4 font-semibold first:mt-0">{text}</h3>;
  const merchantTitle =
    merchant === null ? "Top 10 Merchants" : (merchants?.series[0]?.merchantName ?? "Merchant");

  const chart = !loaded ? null : (
    <>
      {heading(merchantTitle)}
      {merchantsEmpty ?? <MerchantsChart view={merchants} />}
      {heading("Recurring charges")}
      {recurringEmpty ?? (
        <>
          <RecurringChart view={recurring} />
          {recurring.priceChanges.length === 0 ? null : (
            <p className="text-small text-muted">A ring marks a month with a price change.</p>
          )}
          <div className="mt-3">
            <ChargeChangesTable view={recurring} />
          </div>
        </>
      )}
    </>
  );
  const table = !loaded ? undefined : (
    <div className="flex flex-col gap-4">
      {merchantsEmpty ?? <MerchantsTable view={merchants} />}
      {recurringEmpty ?? (
        <>
          <RecurringTable view={recurring} />
          <ChargeChangesTable view={recurring} />
        </>
      )}
    </div>
  );
  return (
    <ReportFrame
      id="merchants"
      title="Merchants and Recurring charges"
      filter={
        <MerchantFilter
          params={props.params}
          merchant={merchant}
          choices={merchants?.choices ?? []}
        />
      }
      chart={
        <>
          <ErrorLine error={props.error} />
          {chart}
        </>
      }
      {...(table === undefined ? {} : { table })}
    />
  );
}

export const merchantsReportRequests = {
  merchants: (range: ReportRange, merchant: string | null) =>
    api.reports.merchants.$get({
      query: merchant === null ? { range } : { range, merchant },
    }),
  recurring: (range: ReportRange) => api.reports.recurring.$get({ query: { range } }),
};

export function MerchantsReport(props: ReportSectionProps) {
  const merchant = props.params.get("merchant")?.trim() || null;
  const [merchants, setMerchants] = useState<MerchantsReportView | undefined>();
  const [recurring, setRecurring] = useState<RecurringReportView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [merchantsRes, recurringRes] = await Promise.all([
          merchantsReportRequests.merchants(props.range, merchant),
          merchantsReportRequests.recurring(props.range),
        ]);
        if (!current) return;
        if (!merchantsRes.ok || !recurringRes.ok) return setError("That did not work.");
        const [merchantsView, recurringView] = await Promise.all([
          merchantsRes.json() as Promise<MerchantsReportView>,
          recurringRes.json() as Promise<RecurringReportView>,
        ]);
        if (!current) return;
        setMerchants(merchantsView);
        setRecurring(recurringView);
        setError(undefined);
      } catch {
        if (current) setError("The server did not answer.");
      }
    })();
    return () => {
      current = false;
    };
  }, [props.range, merchant]);

  return (
    <MerchantsReportCard
      params={props.params}
      merchants={merchants}
      recurring={recurring}
      error={error}
    />
  );
}
