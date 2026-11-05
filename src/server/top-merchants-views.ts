// What the Top Merchants route answers. This file imports nothing, so the web app's type check can
// follow it through api.ts.

// The switch on Top Merchants (spec 07, Top Merchants).
export const TOP_MERCHANT_PERIODS = ["This month", "Last 12 months"] as const;
export type TopMerchantPeriod = (typeof TOP_MERCHANT_PERIODS)[number];

// One Merchant in the ranked list.
export type TopMerchantView = {
  // Which Merchant, as identity knows it (spec 04, Identity): one per row.
  id: string;
  // The Merchant's clean name.
  merchantName: string;
  // Its Spending in the period, net of Refunds and Reimbursements, in whole cents spent.
  spending: number;
  // How many Spending Transactions it has in the period.
  transactions: number;
  // The Category that holds most of its Spending in the period.
  category: string | null;
};

export type TopMerchantsView = {
  period: TopMerchantPeriod;
  // The first day of the period, YYYY-MM-DD, Household time.
  from: string;
  // Most Spending first.
  merchants: TopMerchantView[];
};

export type TopMerchantRoutes = {
  view(period: TopMerchantPeriod, now?: Date): Promise<TopMerchantsView>;
};
