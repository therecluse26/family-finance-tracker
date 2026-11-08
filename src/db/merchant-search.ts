import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { transactions } from "./schema.ts";

// Merchant search (spec 07, Transactions page) on the Merchant name each row shows, through the
// FTS5 index in migration 0072. A Member's text never reaches FTS5 as it is: merchantTerms reads
// it, and merchantMatch writes each term in quotes.
//   - A word matches the start of a word, in any case and with or without accents: `bist` finds
//     "Corner Bistro".
//   - Quoted text matches those exact words in that order: `"shell"` finds "Shell", not
//     "Shellfish Shack". A quote with no end runs to the end of the text.
//   - A word that starts with * matches inside a word: `*istro` finds "Corner Bistro".
//   - A word with no letter or digit, such as `%` or `&`, matches only itself, inside a word.
// Every term must match.

export type MerchantTerms = { words: string[]; phrases: string[]; inside: string[] };

const hasLetterOrDigit = (text: string) => /[\p{L}\p{N}]/u.test(text);

export function merchantTerms(text: string): MerchantTerms {
  const terms: MerchantTerms = { words: [], phrases: [], inside: [] };
  for (const [, quoted, bare] of text.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (quoted !== undefined) {
      const phrase = quoted.trim();
      if (phrase === "") continue;
      (hasLetterOrDigit(phrase) ? terms.phrases : terms.inside).push(phrase);
      continue;
    }
    const word = bare ?? "";
    const core = word.replace(/^\*+|\*+$/g, "");
    if (core === "") continue;
    if (word.startsWith("*") || !hasLetterOrDigit(core)) terms.inside.push(core);
    else terms.words.push(core);
  }
  return terms;
}

// The FTS5 query for the words and phrases, or undefined with none. Each term is a string in
// double quotes, with its own quotes doubled, so no Member's text reads as FTS5 syntax.
export function merchantMatch(terms: MerchantTerms): string | undefined {
  const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
  const parts = [...terms.words.map((word) => `${quote(word)}*`), ...terms.phrases.map(quote)];
  return parts.length === 0 ? undefined : parts.join(" AND ");
}

// A match of any part of `text` in `value`, in any case. % and _ in the text match only
// themselves. Both sides go through SQLite's lower(), so they fold case alike (A to Z only).
export function containsText(value: SQLWrapper, text: string): SQL {
  const pattern = `%${text.replace(/[\\%_]/g, (mark) => `\\${mark}`)}%`;
  return sql`lower(${value}) LIKE lower(${pattern}) ESCAPE '\\'`;
}

// The Merchant name a Transaction's row shows: the Merchant's clean name, else the provider's
// name, else the bank's line. The index holds the same value.
export const shownMerchant = sql<string>`coalesce(${transactions.merchantCleanName}, ${transactions.merchantName}, ${transactions.description})`;

// The conditions on transactions for a Member's Merchant search: none when the text has no term.
export function merchantSearch(text: string): SQL[] {
  const terms = merchantTerms(text);
  const where = terms.inside.map((term) => containsText(shownMerchant, term));
  const match = merchantMatch(terms);
  if (match !== undefined) {
    where.push(
      sql`${transactions.id} IN (SELECT k.transaction_id FROM transaction_search JOIN transaction_search_keys k ON k.key = transaction_search.rowid WHERE transaction_search MATCH ${match})`,
    );
  }
  return where;
}
