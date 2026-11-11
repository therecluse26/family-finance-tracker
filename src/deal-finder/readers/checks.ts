import type { ProductRead } from "../adapter.ts";

// Checks on the data a Price source sends (spec 15, Prices and Deals). Every field a reader keeps
// is untrusted: a Store's page, an Actor's output, or an API answer. A reader keeps only the fields
// these checks pass, and never the raw row.

// Text fields are cut to 200 characters.
export const MAX_TEXT_CHARACTERS = 200;
// A price must be above $0.00 and below $10,000.00.
export const MAX_PRICE_CENTS = 1_000_000;

// Each Store's own domain: a Product link opens only on it.
export const STORE_HOSTS: Readonly<Record<string, string>> = {
  kroger: "www.kroger.com",
  walmart: "www.walmart.com",
  target: "www.target.com",
  aldi: "www.aldi.us",
  costco: "www.costco.com",
  amazon: "www.amazon.com",
};

// A price in whole cents, from a number of dollars (7.29) or a dollar string ("$7.29", "7.29").
// Null when it does not parse to whole cents, or is not above $0.00 and below $10,000.00.
export function parseCents(value: unknown): number | null {
  let cents: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    cents = Math.round(value * 100);
    // 7.295 is not whole cents. The tolerance covers binary fractions, such as 7.29 * 100.
    if (Math.abs(value * 100 - cents) > 1e-6) return null;
  } else if (typeof value === "string") {
    const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (match === null) return null;
    cents = Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  } else {
    return null;
  }
  return cents > 0 && cents < MAX_PRICE_CENTS ? cents : null;
}

// A text field: control characters become spaces, runs of space become one, and it is cut to 200
// characters, never inside a character. Null when nothing is left, or it is not text.
export function cutText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const plain = String(value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it drops.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return null;
  return [...plain].slice(0, MAX_TEXT_CHARACTERS).join("").trim();
}

// A Product link, kept only when it is `https:`, its host is the Store's own domain, and it holds
// no user name, password or port. The check is on the exact string the app stores and sends: the
// string must equal its own normalized form, so a tab, a leading space, `%2e`, a full-width dot, or
// any other form that a parser rewrites is refused (K15).
export function storeLink(storeId: string, value: unknown): string | null {
  const host = STORE_HOSTS[storeId];
  if (host === undefined || typeof value !== "string") return null;
  if (value.length > MAX_TEXT_CHARACTERS * 4) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.href !== value) return null;
  if (parsed.protocol !== "https:" || parsed.host !== host) return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  return value;
}

// A date in the form YYYY-MM-DD, from a date or a date-time string. Null unless it is a real date.
export function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const same =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day);
  return same ? `${year}-${month}-${day}` : null;
}

// A key the reader sends back to the Store, such as an item number or an ASIN. Only the form the
// Store uses is kept, so a re-read never sends a value the Store did not give.
export function readKeyOf(value: unknown, form: RegExp): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && form.test(text) ? text : null;
}

// One Product as a reader parsed it, before the checks.
export type ProductFields = {
  readKey: string | null;
  name: unknown;
  brand?: unknown;
  size?: unknown;
  upc?: unknown;
  link?: unknown;
  regularPrice?: unknown;
  dealPrice?: unknown;
  dealEndsOn?: unknown;
  onlinePrice?: unknown;
};

// A field the Store left empty counts as not given.
const given = (value: unknown) => value !== null && value !== undefined && value !== "";

// The Product, or null when the checks drop it: it has no re-read key or name, a price it gives
// does not parse to whole cents in range, or it has no price at all. A Deal counts only below the
// regular price; else only the Deal is dropped.
export function checkedProduct(storeId: string, fields: ProductFields): ProductRead | null {
  const name = cutText(fields.name);
  if (fields.readKey === null || name === null) return null;
  const prices = [fields.regularPrice, fields.dealPrice, fields.onlinePrice];
  const parsed = prices.map((price) => (given(price) ? parseCents(price) : null));
  // A price that the Store gave and that fails a check drops the Product.
  if (parsed.some((cents, at) => cents === null && given(prices[at]))) return null;
  const [regularPrice = null, dealPrice = null, onlinePrice = null] = parsed;
  if (regularPrice === null && dealPrice === null && onlinePrice === null) return null;
  const deal =
    dealPrice !== null && (regularPrice === null || dealPrice < regularPrice) ? dealPrice : null;
  const upc = typeof fields.upc === "string" && /^\d{6,14}$/.test(fields.upc) ? fields.upc : null;
  return {
    readKey: fields.readKey,
    name,
    brand: cutText(fields.brand),
    size: cutText(fields.size),
    upc,
    link: storeLink(storeId, fields.link),
    regularPrice: regularPrice ?? (deal === null ? null : deal),
    dealPrice: regularPrice === null ? null : deal,
    dealEndsOn: deal === null || regularPrice === null ? null : calendarDate(fields.dealEndsOn),
    onlinePrice,
  };
}
