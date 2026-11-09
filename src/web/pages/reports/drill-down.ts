import { lastDayOf } from "../../../server/usual.ts";
import { filterQuery, type TransactionFilters } from "../../transactions.ts";

// A report's drill-down (spec 07, Reports): a tap on a bar or a point opens the Transactions page
// with the filters that match it. A bar of one month sets `month`; a point that sums a span of
// months, oldest first, sets `from` and `to`, the span's first and last days.
export type DrillDown = TransactionFilters & { months?: readonly string[] };

export function drillDownHref(filters: DrillDown): string {
  const { months, ...rest } = filters;
  const first = months?.[0];
  const last = months?.at(-1);
  const span =
    first === undefined || last === undefined ? {} : { from: `${first}-01`, to: lastDayOf(last) };
  const query = new URLSearchParams(filterQuery({ ...rest, ...span })).toString();
  return query === "" ? "/transactions" : `/transactions?${query}`;
}
