import { hkdfSync } from "node:crypto";
import { registerSecretValue } from "../log.ts";
import type { MasterKey } from "./master-key.ts";

// One label for each use of a value derived from the Master key (spec 09, The Master key).
export type DerivedUse = "setup code" | "login signing secret";

const DERIVED_BYTES = 32;

// HKDF-SHA256 from the Master key, with one label for each use. Made again on each call, and never
// stored. It needs no data key, so `fft setup` can use it before app.db exists.
export function deriveFrom(masterKey: MasterKey, use: DerivedUse): Buffer {
  const info = `family-finance-tracker ${use}`;
  const value = Buffer.from(
    hkdfSync("sha256", masterKey.key, Buffer.alloc(0), info, DERIVED_BYTES),
  );
  // The logger refuses the value as soon as it is made, in each way a caller may write it.
  const hex = value.toString("hex");
  const forms = [hex, hex.toUpperCase(), value.toString("base64"), value.toString("base64url")];
  for (const form of forms) registerSecretValue(form);
  return value;
}
