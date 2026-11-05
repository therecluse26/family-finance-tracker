import { useEffect, useState } from "react";
import { Link } from "react-router";
import { wholeDollars } from "../../format.ts";
import {
  TOP_MERCHANT_PERIODS,
  type TopMerchantPeriod,
  type TopMerchantView,
} from "../../server/top-merchants-views.ts";
import { api } from "../api.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { transactionsPath } from "../transactions.ts";

// Top Merchants (spec 07, Top Merchants): a ranked list of Merchants by Spending, with a "This
// month" or "Last 12 months" switch. Tapping a row opens the Transactions page for that Merchant.

const LINK = "text-blue-700 underline";
const SWITCH =
  "rounded border border-gray-300 px-3 py-1 aria-pressed:bg-blue-700 aria-pressed:text-white";

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
    <fieldset className="mt-4 flex gap-2">
      <legend className="sr-only">Period</legend>
      {TOP_MERCHANT_PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          className={SWITCH}
          aria-pressed={period === props.period}
          onClick={() => props.onChange(period)}
        >
          {period}
        </button>
      ))}
    </fieldset>
  );
}

export function TopMerchantList(props: { merchants: readonly TopMerchantView[] }) {
  if (props.merchants.length === 0) return <p className="mt-4">No Spending yet.</p>;
  return (
    <ol className="mt-4">
      {props.merchants.map((merchant, index) => (
        <li
          key={merchant.id}
          className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4"
        >
          <span>
            {index + 1}.{" "}
            <Link className={LINK} to={transactionsPath({ merchant: merchant.merchantName })}>
              {merchant.merchantName}
            </Link>
            <span className="ml-2 text-sm text-gray-600">{merchantFacts(merchant)}</span>
          </span>
          <span>{wholeDollars(merchant.spending)}</span>
        </li>
      ))}
    </ol>
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
    <main>
      <h1 className="text-2xl font-semibold">Top Merchants</h1>
      <PeriodSwitch period={period} onChange={setPeriod} />
      <ErrorLine error={error} />
      {merchants === undefined ? null : <TopMerchantList merchants={merchants} />}
    </main>
  );
}
