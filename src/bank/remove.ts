import { deleteRemovedConnection, markConnectionRemoved, readConnection } from "../db/index.ts";
import { askForFollowUp } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { BankDataError } from "./adapter.ts";
import type { ConnectionRemoving } from "./connect-view.ts";
import { endConditions } from "./health.ts";
import { oneAtATimeFor, runningBank } from "./sync.ts";

// Removing a Connection, and deleting its history (spec 02, Removing a Connection).
//
// Remove asks the provider to end the Connection, such as Plaid's /item/remove, then deletes the
// credential and closes the Accounts in one database transaction. Their history stays, and N does
// not fall. Hand-made links that waited for the Connection's copies stop waiting in the same
// transaction, and a follow-up job ends them (spec 02, Link carry-over). When the provider's call
// fails:
// - a Gone error, such as ITEM_NOT_FOUND or INVALID_ACCESS_TOKEN, means the provider already ended
//   it, so the removal goes on;
// - any other error changes nothing. The credential stays, so the Member can try again, and the
//   answer says the provider did not answer.
// Removal waits for the Connection's running sync, so no sync stores a page after it.
//
// Delete history works only on a removed Connection. It deletes the Accounts and their Transactions
// in one database transaction, then starts a follow-up job, so matching runs again on what is left.

export function connectionRemoving(): ConnectionRemoving {
  return {
    remove(connectionId) {
      return oneAtATimeFor(connectionId, async () => {
        const { database, secrets, adapters } = runningBank();
        const stored = await readConnection(database, connectionId);
        if (stored === undefined) return { outcome: "not found" };
        if (stored.removedAt !== null) return { outcome: "removed" };
        const adapter = adapters.get(stored.provider);
        if (adapter === undefined) {
          throw new Error(`No adapter for the provider "${stored.provider}".`);
        }
        if (stored.credential !== null) {
          const credential = secrets.decrypt(stored.credential, {
            rowId: stored.id,
            column: "connections.credential",
          });
          try {
            await adapter.remove({
              id: stored.id,
              provider: stored.provider,
              bankId: stored.bankId,
              bankName: stored.bankName,
              credential,
            });
          } catch (error) {
            if (!(error instanceof BankDataError)) throw error;
            if (error.kind !== "gone") {
              log.warn("The provider did not remove a Connection", { connectionId, error });
              return { outcome: "provider error", message: error.message };
            }
            log.info("The provider had already ended a Connection", { connectionId });
          }
        }
        const { copiesNoLongerAwaited } = await markConnectionRemoved(database, connectionId);
        await endConditions(connectionId);
        log.info("Removed a Connection", { connectionId, copiesNoLongerAwaited });
        // Hand-made links that waited for this Connection's copies end in the follow-up job.
        if (copiesNoLongerAwaited > 0) await askForFollowUp();
        return { outcome: "removed" };
      });
    },

    deleteHistory(connectionId) {
      return oneAtATimeFor(connectionId, async () => {
        const { database } = runningBank();
        const stored = await readConnection(database, connectionId);
        if (stored === undefined) return { outcome: "not found" };
        if (stored.removedAt === null) return { outcome: "not removed" };
        const deleted = await deleteRemovedConnection(database, connectionId);
        if (deleted === undefined) return { outcome: "not found" };
        log.info("Deleted a removed Connection's history", { connectionId, ...deleted });
        await askForFollowUp();
        return { outcome: "deleted", ...deleted };
      });
    },
  };
}
