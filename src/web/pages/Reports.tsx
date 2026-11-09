import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { REPORT_RANGES, type ReportRange } from "../../reports/range.ts";
import { Page, PageHeading } from "../components/Page.tsx";
import { RANGE_LABELS, REPORT_SECTIONS, REPORT_TITLES, rangeHref, rangeOf } from "../reports.ts";
import { BalancesReport } from "./reports/Balances.tsx";
import { CashFlowReport } from "./reports/CashFlow.tsx";
import { MerchantsReport } from "./reports/Merchants.tsx";
import { RecurringReport } from "./reports/Recurring.tsx";
import { SpendingReport } from "./reports/Spending.tsx";

// The Reports page (spec 07, Reports): five reports, one under another, over one range, with a
// row of links that jump to each. The range and each report's filter live in the address. The app
// draws every number; the AI writes nothing here.

// A pill, as the dashboard's "Finish setup" links. The chosen range takes the main menu's chosen
// look: a blue tint.
const PILL =
  "inline-flex h-9 shrink-0 items-center rounded-full border border-field bg-white px-3.5 text-sm whitespace-nowrap text-ink hover:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const PRESET = `${PILL} aria-[current=true]:border-nav-current aria-[current=true]:bg-nav-current aria-[current=true]:font-semibold`;

// The range presets, as links, so the address holds the range. Each keeps the other parameters.
export function RangeLinks(props: { params: URLSearchParams; range: ReportRange }) {
  return (
    <nav aria-label="Range" className="flex flex-wrap gap-2">
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

// The jump links, one to each report's section. On a phone the row scrolls sideways inside
// itself; the page never does.
export function JumpLinks() {
  return (
    <nav aria-label="Reports on this page" className="-mt-1 min-w-0">
      <ul className="flex gap-2 overflow-x-auto pb-1" data-slot="jump-links">
        {REPORT_SECTIONS.map((section) => (
          <li key={section} className="shrink-0">
            <a className={`${PILL} text-small`} href={`#${section}`}>
              {REPORT_TITLES[section]}
            </a>
          </li>
        ))}
      </ul>
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
      <JumpLinks />
      <SpendingReport range={range} params={params} />
      <CashFlowReport range={range} params={params} />
      <BalancesReport range={range} params={params} />
      <MerchantsReport range={range} params={params} />
      <RecurringReport range={range} params={params} />
    </Page>
  );
}
