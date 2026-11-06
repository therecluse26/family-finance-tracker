import { claimCopyWaitEndTries, endCopyWaits } from "../db/index.ts";
import { askForFollowUp } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { runningBank } from "./sync.ts";
import { COPIES_WAIT_CAP_MS, COPIES_WAIT_END_TRIES } from "./sync-times.ts";

// The cap on the wait for new copies (spec 02, Link carry-over). After Link again or a new link of
// a removed bank, hand-made links on replaced Transactions wait for their copies until the new
// Connection's first history load ends, or it is removed. A Connection that stays Broken, needs a
// Member, or is held never loads, so the wait also ends COPIES_WAIT_CAP_DAYS after the carry-over.

// What the sync schedule's job did about the waits past the cap.
export type CopiesWaitOutcome = "none" | "ended" | "failed";

// Ends each wait for copies that passed the cap. The first try ends the wait, and makes the old
// Transactions whose hand-made links waited unhandled, once, so the follow-up job ends those links.
// A try that fails counts, and the next minute tries again, at most COPIES_WAIT_END_TRIES times;
// then it stops, and the links end when Matching next handles either side. The sync schedule's job
// calls this every minute.
export async function endLongCopyWaits(now = new Date()): Promise<CopiesWaitOutcome> {
  const { database } = runningBank();
  const before = new Date(now.getTime() - COPIES_WAIT_CAP_MS);
  const claimed = await claimCopyWaitEndTries(database, before, COPIES_WAIT_END_TRIES);
  if (claimed.length === 0) return "none";
  let unhandled: number;
  try {
    unhandled = await endCopyWaits(
      database,
      claimed.map((wait) => wait.connectionId),
      now,
    );
  } catch (error) {
    const stopped = claimed.filter((wait) => wait.tries >= COPIES_WAIT_END_TRIES).length;
    log.error("Could not end the wait for copies past the cap", {
      connections: claimed.length,
      stopped,
      error,
    });
    return "failed";
  }
  log.info("Ended the wait for copies past the cap", { connections: claimed.length, unhandled });
  if (unhandled > 0) await askForFollowUp();
  return "ended";
}
