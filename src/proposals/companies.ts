// The companies a Proposal may never name (spec 08, Guardrails, rule 7): a hand-made list of US
// banks, card issuers, and lenders, shipped with the app. The Household's own banks and lenders are
// checked as well. A name that is also a common word, such as "Current" or "Upgrade", is left out,
// so an ordinary reason is not refused.
export const US_BANKS_AND_LENDERS: readonly string[] = Object.freeze([
  // Banks
  "Bank of America",
  "BMO",
  "Capital One",
  "Charles Schwab",
  "Chase",
  "Citibank",
  "Citi",
  "Citizens Bank",
  "Fifth Third",
  "First Citizens",
  "First Republic",
  "Goldman Sachs",
  "HSBC",
  "Huntington Bank",
  "JPMorgan",
  "KeyBank",
  "M&T Bank",
  "Morgan Stanley",
  "PNC",
  "Regions Bank",
  "Santander",
  "TD Bank",
  "Truist",
  "U.S. Bank",
  "Wells Fargo",
  // Online banks and credit unions
  "Ally",
  "Axos",
  "Chime",
  "Discover",
  "Marcus",
  "Navy Federal",
  "PenFed",
  "SoFi",
  "USAA",
  "Varo",
  // Card issuers
  "American Express",
  "Amex",
  "Apple Card",
  "Barclays",
  "Credit One",
  "Merrick Bank",
  "Mission Lane",
  "Synchrony",
  // Lenders
  "Affirm",
  "Afterpay",
  "Avant",
  "Best Egg",
  "Klarna",
  "LendingClub",
  "LendingTree",
  "Larkspur",
  "Mr. Cooper",
  "Navient",
  "Nelnet",
  "OneMain",
  "Quicken Loans",
  "Rocket Mortgage",
  "Sallie Mae",
  "Upstart",
]);

// Text as its words, for matching names (CLAUDE.md, K13): NFKC folds fullwidth and other compatible
// forms; format characters, such as a zero-width space, and combining marks, such as accents, are
// dropped; letters fold to lower case. Any run of characters that are not letters or digits is a
// gap between words.
function wordsOf(text: string): string[] {
  const plain = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  return plain.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
}

// The name of a company the text names, or undefined. A name matches whole words, with any gap
// between its words or none: "Wells Fargo", "WELLS-FARGO", "WellsFargo", and Wells Fargo with a
// zero-width space all name Wells Fargo, and "U.S. Bank" matches "US Bank". "Chase" does not
// match "purchased".
export function namedCompany(text: string, names: readonly string[]): string | undefined {
  const words = wordsOf(text);
  for (const name of names) {
    const glued = wordsOf(name).join("");
    if (glued === "") continue;
    for (let first = 0; first < words.length; first++) {
      let run = "";
      for (let last = first; last < words.length && run.length < glued.length; last++) {
        run += words[last];
        if (run === glued) return name;
        if (!glued.startsWith(run)) break;
      }
    }
  }
  return undefined;
}
