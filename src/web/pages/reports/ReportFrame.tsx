import { type ReactNode, useState } from "react";
import type { StatusTone } from "../../../format.ts";
import { Card } from "../../components/Card.tsx";
import { Estimated, TONE_COLOR } from "../../components/Status.tsx";
import type { ReportSection } from "../../reports.ts";

// One report's card on the Reports page (spec 07, Reports), read as a dashboard card: the small
// grey label, one big number with a line that compares it, the filter at the top right, then the
// chart, a short caption under it, and the report's summary. A "Show the numbers" button at the
// foot opens the table of the chart's numbers. While it is closed the table is still there for
// screen readers, and the chart, which says nothing to them, is hidden from them.

// The small grey name at the top of a card, and its big number, as on the dashboard.
const LABEL = "text-small font-semibold text-muted";
const BIG =
  "mt-1 flex flex-wrap items-baseline gap-x-2 text-[28px] leading-tight font-bold tracking-[-.01em] tabular-nums min-[900px]:text-[34px]";
const TEXT_BUTTON = "text-small text-accent underline hover:text-accent-dark";

// A part of the comparison line, in a tone's color, such as "▲ $76 above usual". Plain words
// between the parts stay grey.
export type LinePart = string | { tone: StatusTone; text: string };

export type Headline = {
  // The big number, such as "$3,594".
  amount: string;
  // The small words after it, such as "a month on average".
  unit?: string;
  // The number is an estimate.
  estimated?: boolean;
  line?: readonly LinePart[];
};

function HeadlineLines(props: { headline: Headline }) {
  const { amount, unit, estimated, line } = props.headline;
  return (
    <>
      <p className={BIG} data-slot="report-headline">
        <span>{amount}</span>
        {unit === undefined ? null : (
          <span className="text-sm font-normal tracking-normal text-muted">{unit}</span>
        )}
        {estimated ? (
          <span className="self-center text-base">
            <Estimated />
          </span>
        ) : null}
      </p>
      {line === undefined || line.length === 0 ? null : (
        <p className="mt-0.5 text-small text-muted" data-slot="report-line">
          {line.map((part, at) =>
            typeof part === "string" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts never move.
              <span key={at}>{part}</span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts never move.
              <span key={at} className={TONE_COLOR[part.tone]}>
                {part.text}
              </span>
            ),
          )}
        </p>
      )}
    </>
  );
}

export function ReportFrame(props: {
  id: ReportSection;
  title: string;
  // The report's one filter, at the card's top right.
  filter?: ReactNode;
  headline?: Headline;
  chart: ReactNode;
  // The short words under the chart, such as what its marks mean.
  caption?: ReactNode;
  // A chart that says its own numbers to screen readers, such as a ranked list of links, is not
  // hidden from them.
  chartReads?: boolean;
  // Without a table there is no button.
  table?: ReactNode;
  // Whether the table shows when the page first draws.
  initialTable?: boolean;
  // What always shows under the chart, such as a report's totals.
  summary?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(props.initialTable ?? false);
  const headingId = `${props.id}-heading`;
  const tableId = `${props.id}-numbers`;
  const hidden = props.table !== undefined && props.chartReads !== true;
  return (
    <Card id={props.id} aria-labelledby={headingId} className="min-w-0 scroll-mt-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 id={headingId} className={LABEL}>
            {props.title}
          </h2>
          {props.headline === undefined ? null : <HeadlineLines headline={props.headline} />}
        </div>
        {props.filter}
      </div>
      <div aria-hidden={hidden ? true : undefined} className="mt-4" data-slot="report-chart">
        {props.chart}
      </div>
      {props.caption === undefined ? null : (
        <p className="mt-2.5 text-small text-muted" data-slot="report-caption">
          {props.caption}
        </p>
      )}
      {props.summary === undefined ? null : (
        <div className="mt-4" data-slot="report-summary">
          {props.summary}
        </div>
      )}
      {props.table === undefined ? null : (
        <>
          <div className="mt-4 border-t border-line-soft pt-3">
            <button
              type="button"
              aria-controls={tableId}
              aria-expanded={asTable}
              className={TEXT_BUTTON}
              data-slot="table-switch"
              onClick={() => setAsTable(!asTable)}
            >
              {asTable ? "Hide the numbers" : "Show the numbers"}
            </button>
          </div>
          <div id={tableId} className={asTable ? "mt-3" : "sr-only"} data-slot="report-table">
            {props.table}
          </div>
        </>
      )}
    </Card>
  );
}
