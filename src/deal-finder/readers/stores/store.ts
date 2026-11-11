import type { ProductRead } from "../../adapter.ts";

// What each Store's Apify reader maps (spec 15, Stores and their readers): the adapter's search and
// re-read calls, to its Actor's input, and its Actor's rows, to Products. The Actor for each Store
// is fixed here, in code, not a setting.

// Where a call reads. With the ZIP code switch off, the ZIP code is null, and a reader sends no
// location at all: no ZIP code, and no Home store ID, since one names a place too (spec 15, Data
// and privacy).
export type Place = { homeStoreId: string | null; zipCode: string | null };

export type StoreSearch = Place & {
  // One run's search words. Each Actor that takes a list gets every List item's words in one run.
  words: string[];
  productCount: number;
  brand: string | null;
  dealsOnly: boolean;
};

export type ActorCall = {
  actor: string;
  input: Record<string, unknown>;
};

export type ApifyStore = {
  id: string;
  actor: string;
  // The run that searches for the words. Null when the Store gives no price without the ZIP code.
  searchInput(search: StoreSearch): ActorCall | null;
  // One search row as a Product, or null when the checks drop it.
  product(row: Record<string, unknown>): ProductRead | null;
  // The run that reads one Product again by its re-read key, and how to find it in the rows. Null
  // when the key is not in this Store's form, or the Store needs the ZIP code.
  readInput(
    readKey: string,
    place: Place,
  ): (ActorCall & { product(row: Record<string, unknown>): ProductRead | null }) | null;
};

// The words with a brand lock: the brand goes into the search words at every Store, unless they
// already hold it.
export function withBrand(words: string, brand: string | null): string {
  if (brand === null || brand.trim() === "") return words;
  return words.toLowerCase().includes(brand.trim().toLowerCase())
    ? words
    : `${brand.trim()} ${words}`;
}
