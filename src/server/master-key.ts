import { FAILED_SIGN_IN_WINDOW_MS, FAILED_SIGN_INS_ALLOWED } from "../auth/index.ts";
import {
  addSignInTries,
  countSignInTries,
  type Database,
  markSetupStep,
  readLastMasterKeyCheck,
  readSetupSteps,
  recordMasterKeyCheck,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "../db/index.ts";
import type { Secrets } from "../secrets/index.ts";
import type { MasterKeyCheckResult, MasterKeyRoutes } from "./master-key-views.ts";

// The wizard's step 3 and "Check my master key" (spec 09, The Master key). Both use the secrets
// module's checkMasterKey. A pasted key is never stored, logged, or sent back.

// Wrong Master keys count per Member, as failed sign-ins do, in the same window.
export const WRONG_MASTER_KEYS_ALLOWED = FAILED_SIGN_INS_ALLOWED;
export const WRONG_MASTER_KEY_WINDOW_MS = FAILED_SIGN_IN_WINDOW_MS;
const triesKey = (memberId: string) => `master-key:${memberId}`;

export function masterKeyRoutes(database: Database, secrets: Secrets): MasterKeyRoutes {
  const saved = async () => (await readSetupSteps(database)).get("master key") === "done";

  // Counts the paste as wrong until it is checked; a right paste then counts as no try. Of pastes
  // at the same time, only the first ones in the window are checked.
  async function check(memberId: string, pasted: string): Promise<MasterKeyCheckResult> {
    const now = new Date();
    const since = new Date(now.getTime() - WRONG_MASTER_KEY_WINDOW_MS);
    await removeSignInTriesUpTo(database, since);
    const [added] = await addSignInTries(database, [triesKey(memberId)], now);
    if (added === undefined) throw new Error("The pasted Master key was not counted.");
    if (
      (await countSignInTries(database, added.key, since, added.id)) > WRONG_MASTER_KEYS_ALLOWED
    ) {
      return "too many tries";
    }
    const matched = secrets.checkMasterKey(pasted);
    if (matched) await removeSignInTries(database, [added.id]);
    await recordMasterKeyCheck(database, { memberId, at: now, matched });
    return matched ? "matches" : "wrong";
  }

  return {
    saved,

    async shown() {
      return (await saved()) ? undefined : secrets.showMasterKey();
    },

    async pasteBack(memberId, pasted) {
      if (await saved()) return "step done";
      const result = await check(memberId, pasted);
      if (result === "matches") await markSetupStep(database, "master key", "done");
      return result;
    },

    check,

    async lastCheck() {
      const last = await readLastMasterKeyCheck(database);
      if (last === undefined) return null;
      return { memberName: last.memberName, at: last.at.toISOString(), matched: last.matched };
    },
  };
}
