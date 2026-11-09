import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { REPORT_RANGES, type ReportRange } from "../../reports/range.ts";
import { Page, PageHeading } from "../components/Page.tsx";
import { RANGE_LABELS, rangeHref, rangeOf } from "../reports.ts";
import { BalancesReport } from "./reports/Balances.tsx";
import { CashFlowReport } from "./reports/CashFlow.tsx";
import { MerchantsReport } from "./reports/Merchants.tsx";
import { SpendingReport } from "./reports/Spending.tsx";

// The Reports page (spec 07, Reports): four reports, one under another, over one range. The range
// and each report's filter live in the address. The app draws every number; the AI writes nothing
// here.

const PRESET =
  "relative flex h-9 items-center border border-field bg-white px-3.5 text-sm text-ink not-first:-ml-px first:rounded-l-control last:rounded-r-control hover:bg-page focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[current=true]:z-10 aria-[current=true]:border-ink aria-[current=true]:bg-ink aria-[current=true]:text-white";

// The range presets, as links, so the address holds the range. Each keeps the other parameters.
export function RangeLinks(props: { params: URLSearchParams; range: ReportRange }) {
  return (
    <nav aria-label="Range" className="flex">
      {REPORT_RANGES.map((range) => (
        <Link
          key={range}
          aria-current={range === props.range ? "true" : undefined}
          className={PRESET}
          to={rangeHref(props.params, range)}
        >
          {RANGE_LABELS[range]}
        </Link>
      ))}
    </nav>
  );
}

export function Reports() {
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const range = rangeOf(params);

  // A link from the dashboard opens a report's section.
  useEffect(() => {
    if (hash.length > 1) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);

  return (
    <Page width="wide">
      <PageHeading title="Reports">
        <RangeLinks params={params} range={range} />
      </PageHeading>
      <SpendingReport range={range} params={params} />
      <CashFlowReport range={range} params={params} />
      <BalancesReport range={range} params={params} />
      <MerchantsReport range={range} params={params} />
    </Page>
  );
}
