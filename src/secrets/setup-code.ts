import { timingSafeEqual } from "node:crypto";
import { registerSecretValue } from "../log.ts";
import { deriveFrom } from "./derive.ts";
import type { MasterKey } from "./master-key.ts";

// The setup code (spec 12, fft setup): 12 Crockford base32 characters in 3 groups of 4, such as
// "7KQ2-M9XD-4TRF". It comes from the Master key, so the app stores no second secret.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const GROUP = 4;

// The first 60 bits of the derived value, 5 bits to a character.
function crockford(bytes: Buffer): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    let index = 0;
    for (let bit = i * 5; bit < i * 5 + 5; bit += 1) {
      const byte = bytes[bit >> 3] ?? 0;
      index = (index << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    code += CROCKFORD[index];
  }
  return code;
}

function grouped(code: string): string {
  return [0, GROUP, 2 * GROUP].map((start) => code.slice(start, start + GROUP)).join("-");
}

// The code without dashes, in upper case.
function bare(masterKey: MasterKey): string {
  const derived = deriveFrom(masterKey, "setup code");
  try {
    const code = crockford(derived);
    // The logger refuses the code as soon as it is made, with and without dashes, in either case.
    for (const form of [code, grouped(code)]) {
      registerSecretValue(form);
      registerSecretValue(form.toLowerCase());
    }
    return code;
  } finally {
    derived.fill(0);
  }
}

export function setupCodeOf(masterKey: MasterKey): string {
  return grouped(bare(masterKey));
}

// Entered codes ignore letter case and dashes, and the spaces around them. The comparison takes
// the same time wherever the first wrong character is.
export function isSetupCode(masterKey: MasterKey, entered: string): boolean {
  const given = Buffer.from(entered.trim().replace(/-/g, "").toUpperCase(), "utf8");
  const expected = Buffer.from(bare(masterKey), "utf8");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
