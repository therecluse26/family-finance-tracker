import type { Merchant } from "./names.ts";

// Masked Merchants (spec 04, Identity). A card service such as Privacy.com can show its own name on
// the bank line in place of the shop's, so one Merchant hides many shops. A correction on one makes
// no Category rule, Merchant history and the Web lookup skip it, the AI is told, and its
// Recurring charges match only exact cents (spec 06, A masked Merchant's series).

export const MASKED_MERCHANTS = ["Privacy.com"] as const;
export type MaskedMerchant = (typeof MASKED_MERCHANTS)[number];

// Each masked Merchant's name in text, as whole words, in any case: "PRIVACY.COM",
// "PWP*PRIVACY.COM", and "PRIVACYCOM*SHOP" all name Privacy.com.
const MASKED_NAMES: readonly (readonly [MaskedMerchant, RegExp])[] = [
  ["Privacy.com", /\bprivacy\s?\.?\s?com\b/i],
];

// The masked Merchant a provider Merchant name or a bank description names, or undefined.
export function maskedMerchantIn(text: string): MaskedMerchant | undefined {
  return MASKED_NAMES.find(([, name]) => name.test(text))?.[0];
}

// Whether the Merchant is a masked one, by its clean name.
export function isMaskedMerchant(merchant: Merchant): boolean {
  return maskedMerchantIn(merchant.name) !== undefined;
}
