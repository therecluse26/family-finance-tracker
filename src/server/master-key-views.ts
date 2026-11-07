// What the Master key routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

// The answer to a pasted Master key. "too many tries" refuses the paste unchecked.
export type MasterKeyCheckResult = "matches" | "wrong" | "too many tries";

export type LastMasterKeyCheckView = {
  // Null once the Member who checked is removed.
  memberName: string | null;
  at: string;
  matched: boolean;
};

export type MasterKeyRoutes = {
  // True once the wizard's step 3 is done. Until then, the API stores no Master-key secret.
  saved(): Promise<boolean>;
  // The Master key, until the wizard's step 3 is done. Undefined after that.
  shown(): Promise<string | undefined>;
  // The wizard's "I saved it": marks step 3 done, so the key is never shown again.
  confirmSaved(): Promise<void>;
  // "Check my Master key" in Settings.
  check(memberId: string, pasted: string): Promise<MasterKeyCheckResult>;
  lastCheck(): Promise<LastMasterKeyCheckView | null>;
};
