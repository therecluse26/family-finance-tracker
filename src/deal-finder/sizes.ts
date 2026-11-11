// Package sizes and packages to buy (spec 15, Matching List items to Products). App code reads a
// Product's size from its size field, else from its name. The AI reads it only when code cannot,
// in the Product match call. Packages to buy = the List item's quantity divided by the package
// size, rounded up.

export type ListItemUnit = "each" | "oz" | "lb" | "fl oz" | "gal" | "ct" | "pack";

// A size in its kind's base unit: ounces for weight and volume, and a count for count. A fluid
// ounce counts as an ounce, as for water, so "16 oz" of milk and "16 fl oz" are one size.
export type PackageSize = { kind: "amount" | "count"; base: number };

// Each unit's size in ounces, by its name with no dots or spaces.
const AMOUNT_UNITS: Record<string, number> = {
  oz: 1,
  ounce: 1,
  ounces: 1,
  floz: 1,
  lb: 16,
  lbs: 16,
  pound: 16,
  pounds: 16,
  g: 1 / 28.349523125,
  gram: 1 / 28.349523125,
  grams: 1 / 28.349523125,
  kg: 1000 / 28.349523125,
  gal: 128,
  gallon: 128,
  gallons: 128,
  qt: 32,
  quart: 32,
  quarts: 32,
  pt: 16,
  pint: 16,
  pints: 16,
  l: 33.814022702,
  liter: 33.814022702,
  liters: 33.814022702,
  litre: 33.814022702,
  ml: 0.033814022702,
};

const COUNT_UNITS = new Set([
  "ct",
  "count",
  "pk",
  "pack",
  "ea",
  "each",
  "pc",
  "pcs",
  "piece",
  "pieces",
  "roll",
  "rolls",
]);

// Every unit as text may write it, longest first, so "fl oz" wins over "oz".
const UNIT_WORDS = [
  String.raw`fl\.?\s*oz\.?`,
  ...[...Object.keys(AMOUNT_UNITS), ...COUNT_UNITS]
    .filter((unit) => unit !== "floz")
    .sort((a, b) => b.length - a.length),
].join("|");

const NUMBER = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
// "2 x 40 oz", "2 × 40 oz": packs of a size.
const MULTI = new RegExp(String.raw`${NUMBER}\s*[x×]\s*${NUMBER}\s*(${UNIT_WORDS})(?![a-z])`, "i");
// "16 oz", "1.5 lb", "12-ct".
const SINGLE = new RegExp(String.raw`${NUMBER}\s*-?\s*(${UNIT_WORDS})(?![a-z])`, "i");
// "per lb", as a weekly ad prices meat: one unit.
const PER = /\bper\s+(lb|oz|kg)\b/i;
const DOZEN = /\b(\d+(?:\.\d+)?\s+)?dozen\b/i;

function unitSize(amount: number, unitText: string): PackageSize | null {
  const unit = unitText.toLowerCase().replace(/[.\s]/g, "");
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (COUNT_UNITS.has(unit)) return { kind: "count", base: amount };
  const factor = AMOUNT_UNITS[unit];
  return factor === undefined ? null : { kind: "amount", base: amount * factor };
}

// The size one text gives, or null when it names none.
export function readSize(text: string | null | undefined): PackageSize | null {
  if (text === null || text === undefined) return null;
  const multi = MULTI.exec(text);
  if (multi !== null) {
    const each = unitSize(Number(multi[2]), multi[3] as string);
    const packs = Number(multi[1]);
    if (each !== null && Number.isInteger(packs) && packs > 0) {
      return { kind: each.kind, base: each.base * packs };
    }
  }
  const single = SINGLE.exec(text);
  if (single !== null) {
    const size = unitSize(Number(single[1]), single[2] as string);
    if (size !== null) return size;
  }
  const dozen = DOZEN.exec(text);
  if (dozen !== null) return { kind: "count", base: 12 * Number(dozen[1] ?? 1) };
  const per = PER.exec(text);
  if (per !== null) return unitSize(1, per[1] as string);
  return null;
}

// A Product's size: from its size field, else from its name. Null when code cannot read it, and the
// AI reads it.
export function productSize(product: { size: string | null; name: string }): PackageSize | null {
  return readSize(product.size) ?? readSize(product.name);
}

// The List item's quantity in its kind's base unit, as a size.
function wanted(quantity: number, unit: ListItemUnit): PackageSize | null {
  if (unit === "each" || unit === "pack") return null;
  return unitSize(quantity, unit);
}

// Packages to buy: the quantity divided by the package size, rounded up. A List item in `each`
// with a Product in a count counts one per count; otherwise `each` and `pack` mean one package
// each. Null when the two sizes cannot be compared, such as pounds against a count, or the size is
// not known.
export function packagesToBuy(
  item: { quantity: number; unit: ListItemUnit },
  size: PackageSize | null,
): number | null {
  if (!Number.isFinite(item.quantity) || item.quantity <= 0) return null;
  if (item.unit === "pack") return Math.ceil(item.quantity - 1e-9);
  if (item.unit === "each") {
    if (size?.kind === "count") return Math.max(1, Math.ceil(item.quantity / size.base - 1e-9));
    return Math.ceil(item.quantity - 1e-9);
  }
  const need = wanted(item.quantity, item.unit);
  if (need === null || size === null || size.kind !== need.kind) return null;
  return Math.max(1, Math.ceil(need.base / size.base - 1e-9));
}

// The unit price in cents for one of the List item's unit: price divided by package size. For
// `each` and `pack`, the price of one package, or of one count when the Product has a count. Null
// when the sizes cannot be compared.
export function unitPrice(
  priceCents: number,
  item: { unit: ListItemUnit },
  size: PackageSize | null,
): number | null {
  if (item.unit === "pack") return priceCents;
  if (item.unit === "each") return size?.kind === "count" ? priceCents / size.base : priceCents;
  const one = wanted(1, item.unit);
  if (one === null || size === null || size.kind !== one.kind) return null;
  return (priceCents / size.base) * one.base;
}
