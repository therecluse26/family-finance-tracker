import type { ReactNode } from "react";
import { Tooltip } from "recharts";
import { MINUS, monthLabel, wholeDollars } from "../../../format.ts";
import { AXIS_TEXT_COLOR, GRID_COLOR } from "../../chart-colors.ts";

// What the Reports page's charts share (spec 07, Reports): the axis words, the key under a chart,
// and the hover label. Each report draws its own chart with these, so the five read as one.

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const partsOf = (month: string) => {
  const [year = "", number = ""] = month.split("-");
  return { year, at: Number(number) - 1 };
};

// A month, YYYY-MM, in words: "October 2026".
export function monthWords(month: string): string {
  const { year, at } = partsOf(month);
  return `${LONG[at] ?? month} ${year}`;
}

// A month, YYYY-MM, as a table writes it: "Oct 2026".
export const monthLabelOf = (month: string) => monthLabel(`${month}-01`);

// A month's name alone: "October".
export function monthName(month: string): string {
  return LONG[partsOf(month).at] ?? month;
}

// A month axis mark: "Dec", with the year on the first mark and on each January: "Jan 2026".
export function monthTick(month: string, index: number): string {
  const { year, at } = partsOf(month);
  const short = SHORT[at] ?? month;
  return index === 0 || at === 0 ? `${short} ${year}` : short;
}

// A dollar axis mark, in whole cents: "$0", "$500", "$4k", "$1.5k", "$40k", "−$2k".
export function dollarTick(cents: number): string {
  const dollars = Math.round(cents / 100);
  const abs = Math.abs(dollars);
  const sign = dollars < 0 ? MINUS : "";
  if (abs < 1000) return `${sign}$${abs}`;
  const thousands = Math.round(abs / 100) / 10;
  return `${sign}$${thousands}k`;
}

// Round dollar marks for a value axis from $0 to at least `maxCents`: at most five steps of 1, 2,
// 2.5 or 5 times a power of ten dollars, so an axis reads "$0, $500, $1k, $1.5k" and never "$650".
export function dollarTicks(maxCents: number): number[] {
  const dollars = Math.max(1, Math.ceil(maxCents / 100));
  const power = 10 ** Math.max(0, Math.floor(Math.log10(dollars / 5)));
  const step =
    (power >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10])
      .map((each) => each * power)
      .find((each) => each * 5 >= dollars) ?? 10 * power;
  const count = Math.ceil(dollars / step);
  return Array.from({ length: count + 1 }, (_, at) => Math.round(at * step * 100));
}

// Every report ends its range with the Household's current month (src/server/reports.ts), which
// is not over yet. The charts draw it pale, as "so far", so it never reads as a fall.
export const isCurrentMonth = (months: readonly string[], month: string) => month === months.at(-1);

// The caption's words for the current month: "Pale bar: November so far."
export const soFarCaption = (months: readonly string[]) =>
  months.length === 0 ? "" : `Pale bar: ${monthName(months.at(-1) ?? "")} so far.`;

// A chart's box: about 200 px high on a phone, 256 px from 640 px.
export const CHART_BOX = "h-[200px] w-full min-[640px]:h-64";

// The axes' look: small muted words, no axis line on the values, light grid lines.
const TICK = { fill: AXIS_TEXT_COLOR, fontSize: 12 };
export const X_AXIS = {
  dataKey: "month",
  tick: TICK,
  tickLine: false,
  stroke: GRID_COLOR,
  tickFormatter: (month: unknown, index: number) => monthTick(String(month), index),
  minTickGap: 12,
} as const;
export const Y_AXIS = {
  tick: TICK,
  tickLine: false,
  axisLine: false,
  width: 48,
  tickFormatter: (cents: number) => dollarTick(cents),
} as const;
export const GRID = { stroke: GRID_COLOR, vertical: false } as const;

// The key under a chart: a small mark in each series' color, and its name in ink. Marks are a box
// for bars, a line, or a dashed or dotted line.
export type KeyItem = {
  name: string;
  color: string;
  mark?: "box" | "line" | "dashed" | "dotted";
};

function KeyMark(props: { item: KeyItem }) {
  const { item } = props;
  if ((item.mark ?? "box") === "box") {
    return (
      <span className="inline-block size-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
    );
  }
  const style = item.mark === "dashed" || item.mark === "dotted" ? item.mark : "solid";
  return (
    <span
      className="inline-block w-4 border-t-2"
      style={{ borderTopColor: item.color, borderTopStyle: style }}
    />
  );
}

export function ChartKey(props: { items: readonly KeyItem[] }) {
  if (props.items.length === 0) return null;
  return (
    <ul
      className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-ink-soft"
      data-slot="chart-key"
    >
      {props.items.map((item) => (
        <li key={item.name} className="flex items-center gap-1.5">
          <KeyMark item={item} />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

// --- The hover label --------------------------------------------------------------------------

// One line of a hover label: a series' name and its amount, with its color's mark when it has one.
export type TooltipRow = { name: string; amount: string; color?: string };
export type TooltipContent = { title: string; rows: TooltipRow[]; total?: TooltipRow };

// A month's hover label: the month in words ("October 2026", or "November 2026 so far" for the
// current month), each series with an amount, and, for a stack, its total under them. A series
// with no amount that month is left out.
export function tooltipContent(args: {
  month: string;
  current?: boolean;
  items: readonly { name: string; cents: number | null; color?: string }[];
  format?: (cents: number) => string;
  // The name of a stack's total, such as "Spending".
  total?: string;
}): TooltipContent {
  const format = args.format ?? wholeDollars;
  const shown = args.items.filter(
    (item): item is { name: string; cents: number; color?: string } => item.cents !== null,
  );
  const rows = shown.map((item) => ({
    name: item.name,
    amount: format(item.cents),
    ...(item.color === undefined ? {} : { color: item.color }),
  }));
  const title = `${monthWords(args.month)}${args.current ? " so far" : ""}`;
  if (args.total === undefined) return { title, rows };
  const sum = shown.reduce((total, item) => total + item.cents, 0);
  return { title, rows, total: { name: args.total, amount: format(sum) } };
}

const TOOLTIP_ROW = "flex items-center gap-2";

// The hover label, drawn as a small Dashboard card.
export function ReportTooltipBox(props: TooltipContent) {
  return (
    <div
      className="min-w-40 rounded-control border border-line bg-white px-3 py-2 text-small text-ink shadow-md"
      data-slot="report-tooltip"
    >
      <p className="font-semibold">{props.title}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {props.rows.map((row) => (
          <li key={row.name} className={TOOLTIP_ROW}>
            {row.color === undefined ? null : (
              <span
                className="inline-block size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: row.color }}
              />
            )}
            <span className="min-w-0 flex-1 text-ink-soft">{row.name}</span>
            <span className="tabular-nums">{row.amount}</span>
          </li>
        ))}
      </ul>
      {props.total === undefined ? null : (
        <p className={`${TOOLTIP_ROW} mt-1 border-t border-line-soft pt-1 font-semibold`}>
          <span className="flex-1">{props.total.name}</span>
          <span className="tabular-nums">{props.total.amount}</span>
        </p>
      )}
    </div>
  );
}

// What Recharts tells the hover label: the month under the pointer, and, for a label of one
// item, which series it is.
export type TooltipAt = { month: string; dataKey: string | undefined };

// The shared hover label, as a Recharts Tooltip for a chart's children. A tap shows it too. A
// `cursor` of "band" shades the month under the pointer; "line" draws a thin line through it.
// With `item`, the label follows one bar of a stack, not the whole month.
export function reportTooltip(
  content: (at: TooltipAt) => TooltipContent | null,
  options: { cursor: "band" | "line"; item?: boolean },
): ReactNode {
  return (
    <Tooltip
      isAnimationActive={false}
      shared={options.item !== true}
      cursor={options.cursor === "band" ? { fill: GRID_COLOR } : { stroke: AXIS_TEXT_COLOR }}
      wrapperStyle={{ zIndex: 20, outline: "none" }}
      content={(props) => {
        const label = props.label ?? props.payload?.[0]?.payload?.month;
        if (props.active !== true || label === undefined || label === null) return null;
        const dataKey = props.payload?.[0]?.dataKey;
        const found = content({
          month: String(label),
          dataKey: dataKey === undefined ? undefined : String(dataKey),
        });
        return found === null ? null : <ReportTooltipBox {...found} />;
      }}
    />
  );
}
