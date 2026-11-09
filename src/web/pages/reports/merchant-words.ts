import { drillDownHref } from "./drill-down.ts";

// The Merchants and Recurring charges reports' drill-down (spec 07, Reports): a Merchant's month
// opens the Transactions page with its Merchant and month set. A Merchant group with the
// provider's Merchant ID sets that ID, which lists exactly the group's Transactions whatever their
// clean names. One with no ID, grouped by clean name, falls back to a search for its name's words.

// The Transactions page's Merchant search for a Merchant name: the name in quotes, so it matches
// those exact words in that order (src/db/merchant-search.ts), and "Bluebird Books" does not find
// "Bluebird Bookshop Cafe". A quote inside the name becomes a space. Null when no word is left,
// since an empty search would list every Merchant.
export function merchantWords(merchantName: string): string | null {
  const words = merchantName.replaceAll('"', " ").trim();
  return words === "" ? null : `"${words}"`;
}

// The drill-down of one Merchant's month, or null when no filter names the Merchant alone.
export function merchantMonthHref(
  merchant: { merchantId: string | null; merchantName: string },
  month: string,
): string | null {
  if (merchant.merchantId !== null)
    return drillDownHref({ merchantId: merchant.merchantId, month });
  const words = merchantWords(merchant.merchantName);
  return words === null ? null : drillDownHref({ merchant: words, month });
}
