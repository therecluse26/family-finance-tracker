import { useEffect, useState } from "react";
import { Link } from "react-router";
import { wholeDollars } from "../../format.ts";
import {
  TOP_MERCHANT_PERIODS,
  type TopMerchantPeriod,
  type TopMerchantView,
} from "../../server/top-merchants-views.ts";
import { api } from "../api.ts";
import { SEGMENTS, Segment } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Meter } from "../components/Meter.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { transactionsPath } from "../transactions.ts";

// Top Merchants (spec 07, Top Merchants): a ranked list of Merchants by Spending, with a "This
// month" or "Last 12 months" switch. Tapping a row opens the Transactions page for that Merchant.

// "142 Transactions · Groceries".
export function merchantFacts(merchant: TopMerchantView): string {
  const count = `${merchant.transactions} ${merchant.transactions === 1 ? "Transaction" : "Transactions"}`;
  return [count, ...(merchant.category === null ? [] : [merchant.category])].join(" · ");
}

export function PeriodSwitch(props: {
  period: TopMerchantPeriod;
  onChange(period: TopMerchantPeriod): void;
}) {
  return (
    <fieldset className={SEGMENTS}>
      <legend className="sr-only">Period</legend>
      {TOP_MERCHANT_PERIODS.map((period) => (
        <Segment
          key={period}
          pressed={period === props.period}
          onClick={() => props.onChange(period)}
        >
          {period}
        </Segment>
      ))}
    </fieldset>
  );
}

// Each row: the rank, the Merchant with its facts, a bar of its Spending against the top
// Merchant's, and its Spending. On a phone the bar sits under the Merchant.
export function TopMerchantList(props: { merchants: readonly TopMerchantView[] }) {
  if (props.merchants.length === 0) {
    return (
      <Card>
        <p className="text-muted">No Spending yet.</p>
      </Card>
    );
  }
  const top = Math.max(...props.merchants.map((merchant) => merchant.spending));
  return (
    <>
      <Card padding="list">
        <ol>
          {props.merchants.map((merchant, index) => (
            <li
              key={merchant.id}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-line-soft py-[11px] text-sm first:border-t-0 sm:grid-cols-[1.75rem_minmax(0,1.3fr)_minmax(0,2fr)_6rem]"
            >
              <span className="text-muted tabular-nums">{index + 1}</span>
              <span className="min-w-0">
                <Link
                  className="font-semibold text-ink hover:text-accent hover:underline"
                  to={transactionsPath({ merchant: merchant.merchantName })}
                >
                  {merchant.merchantName}
                </Link>
                <span className="block text-small text-muted">{merchantFacts(merchant)}</span>
              </span>
              <Meter
                share={top > 0 ? merchant.spending / top : 0}
                track={false}
                size="large"
                className="col-span-2 col-start-2 sm:col-span-1 sm:col-start-3"
              />
              <span className="col-start-3 row-start-1 text-right tabular-nums sm:col-start-4">
                {wholeDollars(merchant.spending)}
              </span>
            </li>
          ))}
        </ol>
      </Card>
      <p className="text-small text-muted">Choose a Merchant to see its Transactions.</p>
    </>
  );
}

export const topMerchantRequests = {
  view: (period: TopMerchantPeriod) => {
    const query = { period };
    return api["top-merchants"].$get({ query });
  },
};

export function TopMerchants() {
  const [period, setPeriod] = useState<TopMerchantPeriod>("This month");
  const [merchants, setMerchants] = useState<TopMerchantView[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let current = true;
    setMerchants(undefined);
    void (async () => {
      try {
        const res = await topMerchantRequests.view(period);
        if (!current) return;
        if (!res.ok) return setError("That did not work.");
        const found = ((await res.json()) as { merchants: TopMerchantView[] }).merchants;
        if (!current) return;
        setMerchants(found);
        setError(undefined);
      } catch {
        if (current) setError("The server did not answer.");
      }
    })();
    return () => {
      current = false;
    };
  }, [period]);

  return (
    <Page>
      <PageHeading title="Top Merchants">
        <PeriodSwitch period={period} onChange={setPeriod} />
      </PageHeading>
      <ErrorLine error={error} />
      {merchants === undefined ? null : <TopMerchantList merchants={merchants} />}
    </Page>
  );
}
