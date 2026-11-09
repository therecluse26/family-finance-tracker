import type { ReactNode } from "react";

// Every table on the Reports page (spec 07, Reports), drawn as the dashboard's "Due in the next 14
// days" table: a small grey head, light lines between rows, the first column at the left and every
// amount at the right in even-width digits. A column with no words in any row is left out, such
// as "Change from the range before" with no whole range before. A table wider than its card
// scrolls sideways inside the card, with its first column kept in view.

const HEAD =
  "border-b border-line px-1.5 py-2 text-xs font-semibold text-muted first:pl-0 last:pr-0";
const CELL = "border-b border-line-soft px-1.5 py-[9px] tabular-nums first:pl-0 last:pr-0";
// The first column stays in view while the rest scrolls, on the card's white.
const FIRST = "sticky left-0 z-[1] bg-white text-left";

export type ReportTableColumn = {
  key: string;
  name: ReactNode;
  // Words, such as "Price changes", sit at the left; amounts, the default, at the right.
  align?: "left" | "right";
};

export type ReportTableRow = {
  key: string;
  // The row's name in the first column, such as its month.
  head: ReactNode;
  // One per column, in order.
  cells: readonly ReactNode[];
  bold?: boolean;
};

const isEmpty = (cell: ReactNode) =>
  cell === null || cell === undefined || cell === "" || cell === false;

// The columns, by place, that have words in at least one row.
export function shownColumns(
  columns: readonly ReportTableColumn[],
  rows: readonly ReportTableRow[],
): number[] {
  return columns.flatMap((_, at) => (rows.some((row) => !isEmpty(row.cells[at])) ? [at] : []));
}

export function ReportTable(props: {
  // The table's name for screen readers.
  label: string;
  // A short line above the table, such as its title.
  caption?: ReactNode;
  // The first column's head. Without one, the head is a name for screen readers only.
  head: ReactNode;
  columns: readonly ReportTableColumn[];
  rows: readonly ReportTableRow[];
  // Rows under the body, such as a usual month.
  foot?: readonly ReportTableRow[];
  slot?: string;
}) {
  const shown = shownColumns(props.columns, [...props.rows, ...(props.foot ?? [])]);
  const line = (row: ReportTableRow) => (
    <tr key={row.key} className={row.bold ? "font-semibold" : undefined}>
      <th scope="row" className={`${CELL} ${FIRST} ${row.bold ? "" : "font-normal"}`}>
        {row.head}
      </th>
      {shown.map((at) => {
        const column = props.columns[at];
        return (
          <td
            key={column?.key ?? at}
            className={`${CELL} ${column?.align === "left" ? "text-left" : "text-right whitespace-nowrap"}`}
          >
            {row.cells[at]}
          </td>
        );
      })}
    </tr>
  );
  return (
    <div className="max-w-full overflow-x-auto" data-slot="report-table-scroll">
      <table aria-label={props.label} className="w-full text-sm" data-slot={props.slot}>
        {props.caption === undefined ? null : (
          <caption className="pb-1 text-left text-small font-semibold text-ink">
            {props.caption}
          </caption>
        )}
        <thead>
          <tr>
            <th scope="col" className={`${HEAD} ${FIRST}`}>
              {props.head}
            </th>
            {shown.map((at) => {
              const column = props.columns[at];
              return (
                <th
                  key={column?.key ?? at}
                  scope="col"
                  className={`${HEAD} ${column?.align === "left" ? "text-left" : "text-right"}`}
                >
                  {column?.name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{props.rows.map(line)}</tbody>
        {props.foot === undefined || props.foot.length === 0 ? null : (
          <tfoot>{props.foot.map(line)}</tfoot>
        )}
      </table>
    </div>
  );
}
