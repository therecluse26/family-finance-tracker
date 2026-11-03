import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../log.ts";
import { setupCodeOf } from "./index.ts";
import { isSetupCode } from "./setup-code.ts";
import { newMasterKey } from "./testing.ts";

// Spec 12, fft setup: the code comes from the Master key through HKDF-SHA256, and is 12 Crockford
// base32 characters in 3 groups of 4.

// Every call to timingSafeEqual, so a test can see that the check compares in constant time.
const compared = vi.hoisted(() => [] as [Buffer, Buffer][]);

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
  return {
    ...actual,
    timingSafeEqual: (a: Buffer, b: Buffer) => {
      compared.push([Buffer.from(a), Buffer.from(b)]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The code as spec 12 describes it, made here with node:crypto alone: the first 60 bits of
// HKDF-SHA256 with the label "family-finance-tracker setup code", 5 bits to a character.
function expectedCode(hex: string): string {
  const info = "family-finance-tracker setup code";
  const bytes = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(hex, "hex"), Buffer.alloc(0), info, 32),
  );
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  const characters = Array.from({ length: 12 }, (_, i) =>
    CROCKFORD.charAt(Number.parseInt(bits.slice(i * 5, i * 5 + 5), 2)),
  );
  return [0, 4, 8].map((start) => characters.slice(start, start + 4).join("")).join("-");
}

describe("the setup code", () => {
  it("is 12 Crockford base32 characters in 3 groups of 4", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(setupCodeOf(newMasterKey().masterKey)).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
    }
  });

  it("comes from the Master key through HKDF-SHA256, so it is the same each time", () => {
    const { hex, masterKey } = newMasterKey();

    expect(setupCodeOf(masterKey)).toBe(expectedCode(hex));
    expect(setupCodeOf(masterKey)).toBe(setupCodeOf(masterKey));
    expect(setupCodeOf(newMasterKey().masterKey)).not.toBe(setupCodeOf(masterKey));
  });

  it("matches an entered code whatever its letter case and dashes", () => {
    const { masterKey } = newMasterKey();
    const code = setupCodeOf(masterKey);
    const bare = code.replace(/-/g, "");

    for (const entered of [
      code,
      code.toLowerCase(),
      bare,
      bare.toLowerCase(),
      `${bare.slice(0, 6)}-${bare.slice(6)}`,
      `--${code}-`,
      `  ${code}\n`,
    ]) {
      expect(isSetupCode(masterKey, entered)).toBe(true);
    }
  });

  it("refuses any other code", () => {
    const { masterKey } = newMasterKey();
    const code = setupCodeOf(masterKey);
    const changed = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;

    for (const entered of [
      changed,
      code.slice(0, -1),
      `${code}0`,
      setupCodeOf(newMasterKey().masterKey),
      "",
      code.replace(/-/g, " "),
    ]) {
      expect(isSetupCode(masterKey, entered)).toBe(false);
    }
  });

  it("compares a code of the right length in constant time", () => {
    const { masterKey } = newMasterKey();
    const bare = setupCodeOf(masterKey).replace(/-/g, "");
    const firstWrong = `${bare.startsWith("0") ? "1" : "0"}${bare.slice(1)}`;
    const lastWrong = `${bare.slice(0, -1)}${bare.endsWith("0") ? "1" : "0"}`;
    compared.length = 0;

    expect(isSetupCode(masterKey, firstWrong)).toBe(false);
    expect(isSetupCode(masterKey, lastWrong)).toBe(false);
    expect(isSetupCode(masterKey, bare.toLowerCase())).toBe(true);

    expect(compared.map(([given]) => given.toString())).toEqual([firstWrong, lastWrong, bare]);
    for (const [, expected] of compared) expect(expected.toString()).toBe(bare);
  });

  it("makes the logger refuse the code as soon as it is made, in each way it is written", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: false });
    const code = setupCodeOf(newMasterKey().masterKey);
    const bare = code.replace(/-/g, "");
    const forms = [code, code.toLowerCase(), bare, bare.toLowerCase()];

    logger.info(`Opened https://money.example.com/setup#code=${code}`, {
      link: `https://money.example.com/setup#code=${bare.toLowerCase()}`,
      ...Object.fromEntries(forms.map((form, i) => [`note${i}`, form])),
    });

    for (const form of forms) expect(lines.join("")).not.toContain(form);
  });
});
