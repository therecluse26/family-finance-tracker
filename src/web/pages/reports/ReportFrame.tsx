import { type ReactNode, useState } from "react";
import { Card } from "../../components/Card.tsx";
import { SectionHeading } from "../../components/Page.tsx";
import type { ReportSection } from "../../reports.ts";

// One report's card on the Reports page (spec 07, Reports): its title and filter, its chart, and a
// "Show as table" switch under the chart. The table holds the chart's numbers. With the switch off
// it is still there for screen readers, and the chart, which says nothing to them, is hidden from
// them. With the switch on, the table shows in the chart's place.

export function ReportFrame(props: {
  id: ReportSection;
  title: string;
  // The report's one filter, beside the title.
  filter?: ReactNode;
  chart: ReactNode;
  // Without a table there is no switch.
  table?: ReactNode;
  // Whether the table shows when the page first draws.
  initialTable?: boolean;
  // What always shows under the chart and its table, such as a report's totals.
  summary?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(props.initialTable ?? false);
  const headingId = `${props.id}-heading`;
  return (
    <Card id={props.id} aria-labelledby={headingId} className="scroll-mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <SectionHeading id={headingId}>{props.title}</SectionHeading>
        </div>
        {props.filter}
      </div>
      {props.table !== undefined && asTable ? null : (
        <div
          aria-hidden={props.table === undefined ? undefined : true}
          className="mt-3"
          data-slot="report-chart"
        >
          {props.chart}
        </div>
      )}
      {props.table === undefined ? null : (
        <>
          <label className="mt-3 flex items-center gap-2 text-sm" data-slot="table-switch">
            <input
              type="checkbox"
              checked={asTable}
              onChange={(event) => setAsTable(event.target.checked)}
            />
            Show as table
          </label>
          <div className={asTable ? "mt-3" : "sr-only"} data-slot="report-table">
            {props.table}
          </div>
        </>
      )}
      {props.summary === undefined ? null : (
        <div className="mt-4" data-slot="report-summary">
          {props.summary}
        </div>
      )}
    </Card>
  );
}
