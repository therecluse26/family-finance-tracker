import { type ReactNode, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  type BarShapeProps,
  Rectangle,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import type {
  CardsPictureView,
  DaysPictureView,
  PictureChoice,
  PictureType,
  PictureView,
  RecurringPictureView,
  TrendPictureView,
} from "../../pictures/picture-view.ts";
import {
  type BarRow,
  calendarWeeks,
  cardRows,
  cardsCaption,
  daysCaption,
  readPicture,
  recurringCaption,
  recurringRows,
  type TrendBar,
  trendBars,
  trendCaption,
} from "../pictures.ts";

// The pictures on the picture menu (spec 08, Picture menu). The AI picks one and names what to
// show; the app draws it from its own data. Each drawing's caption carries its meaning in words,
// so the shapes are hidden from screen readers.

const FULL_COLOR = "#1d4ed8";
const MUTED_COLOR = "#cbd5e1";
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function Caption(props: { children: ReactNode }) {
  return <figcaption className="mt-1 text-xs text-gray-600">{props.children}</figcaption>;
}

// --- days ---------------------------------------------------------------------------------------

// A calendar of the month. Each day it happened has a dot, larger for more Transactions, up to 3.
function DaysPicture(props: { picture: DaysPictureView }) {
  return (
    <figure data-slot="picture" data-picture="days">
      <div aria-hidden="true" className="grid w-fit grid-cols-7 gap-1">
        {WEEKDAYS.map((day, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two weekdays share a letter.
          <span key={index} className="w-5 text-center text-[10px] text-gray-500">
            {day}
          </span>
        ))}
        {calendarWeeks(props.picture)
          .flat()
          .map((cell, index) =>
            cell === null ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blanks before the 1st have no date.
              <span key={index} className="h-5 w-5" />
            ) : (
              <span
                key={cell.date}
                className="grid h-5 w-5 place-items-center"
                data-day={cell.day}
                data-marked={cell.count > 0 ? "" : undefined}
              >
                <span
                  className="rounded-full"
                  style={{
                    width: cell.count > 0 ? 6 + Math.min(cell.count, 3) * 2 : 3,
                    height: cell.count > 0 ? 6 + Math.min(cell.count, 3) * 2 : 3,
                    background: cell.count > 0 ? FULL_COLOR : MUTED_COLOR,
                  }}
                />
              </span>
            ),
          )}
      </div>
      <Caption>{daysCaption(props.picture)}</Caption>
    </figure>
  );
}

// --- trend --------------------------------------------------------------------------------------

// The dashed mark at a month's Budget, across its bar. A month with no Budget has none.
function BudgetMark(props: BarShapeProps) {
  const { x, y, width, payload } = props;
  if ((payload as TrendBar | undefined)?.budget == null) return <g />;
  return (
    <line
      x1={x}
      x2={x + width}
      y1={y}
      y2={y}
      stroke="#111827"
      strokeWidth={1.5}
      strokeDasharray="3 2"
    />
  );
}

// The picture's month in full color; the 6 before it muted.
function SpendingBar(props: BarShapeProps) {
  const current = (props.payload as TrendBar | undefined)?.current === true;
  return <Rectangle {...props} fill={current ? FULL_COLOR : MUTED_COLOR} />;
}

// 7 bars of Spending, and the dashed line at each month's Budget on its own hidden axis, so each
// mark lies across its month's bar.
function TrendPicture(props: { picture: TrendPictureView }) {
  return (
    <figure data-slot="picture" data-picture="trend">
      <div aria-hidden="true" className="h-20 w-full max-w-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={trendBars(props.picture)}
            margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          >
            <XAxis dataKey="label" hide />
            <XAxis dataKey="label" xAxisId="budget" hide />
            <YAxis hide domain={[0, "auto"]} />
            <Bar dataKey="spending" shape={SpendingBar} isAnimationActive={false} />
            <Bar dataKey="budget" xAxisId="budget" shape={BudgetMark} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Caption>{trendCaption(props.picture)}</Caption>
    </figure>
  );
}

// --- cards and recurring ------------------------------------------------------------------------

// One row's bar, as long as its share of the largest row.
function RowBar(props: { amount: number; most: number }) {
  return (
    <div aria-hidden="true" className="h-2 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[{ amount: props.amount }]} layout="vertical" margin={{}}>
          <XAxis type="number" hide domain={[0, Math.max(props.most, 1)]} />
          <YAxis type="category" hide />
          <Bar dataKey="amount" fill={FULL_COLOR} radius={4} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// A row per card or charge: its name and words, then its bar.
function BarList(props: { picture: PictureType; rows: BarRow[]; caption: string }) {
  const most = Math.max(...props.rows.map((row) => row.amount));
  return (
    <figure data-slot="picture" data-picture={props.picture} className="w-full max-w-64">
      <ul className="flex flex-col gap-1.5">
        {props.rows.map((row) => (
          <li key={row.key}>
            <span className="flex justify-between gap-2 text-xs">
              <span className="truncate text-gray-600">{row.name}</span>
              <span className="whitespace-nowrap">
                {row.words}
                {row.flag === undefined ? null : <span data-slot="promo"> {row.flag}</span>}
              </span>
            </span>
            <RowBar amount={row.amount} most={most} />
          </li>
        ))}
      </ul>
      <Caption>{props.caption}</Caption>
    </figure>
  );
}

function CardsPicture(props: { picture: CardsPictureView }) {
  return (
    <BarList picture="cards" rows={cardRows(props.picture)} caption={cardsCaption(props.picture)} />
  );
}

function RecurringPicture(props: { picture: RecurringPictureView }) {
  return (
    <BarList
      picture="recurring"
      rows={recurringRows(props.picture)}
      caption={recurringCaption(props.picture)}
    />
  );
}

// --- The menu -----------------------------------------------------------------------------------

// One drawing per picture type. A new picture type is one more entry.
const PICTURE_DRAWINGS: {
  [T in PictureType]: (props: { picture: Extract<PictureView, { type: T }> }) => ReactNode;
} = { days: DaysPicture, trend: TrendPicture, cards: CardsPicture, recurring: RecurringPicture };

// A drawn picture, or nothing for null.
export function PictureDrawing(props: { picture: PictureView | null }) {
  if (props.picture === null) return null;
  const Drawing = PICTURE_DRAWINGS[props.picture.type] as (props: {
    picture: PictureView;
  }) => ReactNode;
  return <Drawing picture={props.picture} />;
}

// The picture a choice names, drawn for a month (YYYY-MM). No choice, a choice the data does not
// bear out, and a failed request each show nothing.
export function Picture(props: { choice: PictureChoice | null; month: string }) {
  const [picture, setPicture] = useState<PictureView | null>(null);
  const asked = props.choice === null ? null : JSON.stringify([props.choice, props.month]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` holds the choice and month.
  useEffect(() => {
    setPicture(null);
    if (props.choice === null) return;
    let current = true;
    readPicture(props.choice, props.month).then(
      (drawn) => {
        if (current) setPicture(drawn);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [asked]);

  return <PictureDrawing picture={picture} />;
}
