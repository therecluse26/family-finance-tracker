import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dateLabel, dollarsAndCents, monthLabel, wholeDollars } from "../../format.ts";
import type { BalancePointView } from "../../server/bank-views.ts";

// An Account's balance over time (spec 07, Account list). One line in one color: known days are
// solid and estimated days are dashed, and a caption names the dashed line, so the mark never rests
// on the line style alone.

export type ChartRow = { date: string; known: number | null; estimated: number | null };

const LINE = "#1d4ed8";

// One row per day. A stretch between two days belongs to the later day's mark, so each day that
// starts or ends a stretch carries its balance in that stretch's series, and the line never breaks
// where the mark changes.
export function chartRows(points: readonly BalancePointView[]): ChartRow[] {
  return points.map((point, index) => {
    const next = points[index + 1];
    const known = !point.estimated || (next !== undefined && !next.estimated);
    const estimated = point.estimated || next?.estimated === true;
    return {
      date: point.date,
      known: known ? point.currentBalance : null,
      estimated: estimated ? point.currentBalance : null,
    };
  });
}

// The axis marks: the first day shown in each month, labelled "Oct 2025" (spec 07, Number formats).
export function monthTicks(rows: readonly ChartRow[]): string[] {
  return rows
    .filter((row, index) => row.date.slice(0, 7) !== rows[index - 1]?.date.slice(0, 7))
    .map((row) => row.date);
}

export function BalanceChart(props: { points: readonly BalancePointView[]; today: string }) {
  const rows = chartRows(props.points);
  if (rows.length === 0) return <p className="mt-3 text-gray-600">No balances yet.</p>;
  const label = (date: string) => dateLabel(date, props.today);
  return (
    <figure className="mt-3">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            accessibilityLayer={false}
            data={rows}
            margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <CartesianGrid stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="date"
              ticks={monthTicks(rows)}
              tickFormatter={monthLabel}
              tick={{ fill: "#4b5563", fontSize: 12 }}
            />
            <YAxis
              tickFormatter={(cents: number) => wholeDollars(cents)}
              tick={{ fill: "#4b5563", fontSize: 12 }}
              width={80}
            />
            <Tooltip
              labelFormatter={(date) => label(String(date))}
              formatter={(cents, name) => [
                dollarsAndCents(Number(cents)),
                name === "estimated" ? "Balance (estimated)" : "Balance",
              ]}
            />
            <Line
              dataKey="known"
              name="known"
              type="stepAfter"
              stroke={LINE}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="estimated"
              name="estimated"
              type="stepAfter"
              stroke={LINE}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {rows.some((row) => row.estimated !== null) ? (
        <figcaption className="mt-1 text-sm text-gray-600">
          The dashed line marks estimated days.
        </figcaption>
      ) : null}
    </figure>
  );
}
