import { randomBytes } from "node:crypto";
import { type MasterKey, parseMasterKey } from "./master-key.ts";

// Test support: new random Master keys, made when the test runs. No test key is ever committed.

// Written as 64 hexadecimal characters. The logger does not refuse it until the key is loaded.
export function newMasterKeyHex(): string {
  return randomBytes(32).toString("hex");
}

export function newMasterKey(): { hex: string; masterKey: MasterKey } {
  const hex = newMasterKeyHex();
  return { hex, masterKey: parseMasterKey(hex, "The test Master key") };
}
