import {
  addConnection,
  listAccounts,
  listConnections,
  readConnection,
  readPlaidSettings,
  type StoredConnection,
  saveSyncState,
} from "../db/index.ts";
import { log } from "../log.ts";
import { BankDataError, type LinkedAccount, type NewConnection, type Provider } from "./adapter.ts";
import {
  type BankConnecting,
  CONFIRM_ITEMS_FROM,
  type ConnectionRepairing,
  type CoveringConnection,
  type ImportPreview,
  type LinkOptions,
  type LinkRefusal,
  type ProviderFailure,
  type UpdateModeFinish,
  type UpdateModeStart,
} from "./connect-view.ts";
import { connectionConditions } from "./health.ts";
import { startSync } from "./job.ts";
import { PLAID_ITEM_LIMIT } from "./plaid-view.ts";
import { connectionRemoving } from "./remove.ts";
import { adapterConnection, runningBank } from "./sync.ts";
import { HOUR_MS, STARTED_SYNC_GAP_MS, UPDATE_SYNC_GAP_MS } from "./sync-times.ts";

// Adding a Connection (spec 02, Linking a new bank, Connections, and The 10 lifetime Items). A bank
// has at most one Connection, which guards Plaid's 10 lifetime Items: the app checks for a
// duplicate bank before it spends anything. The credential is stored only encrypted, bound to the
// Connection's row and column, and goes nowhere else: not into a log line, an error, an answer, or
// a job's argument.

// N, in "at least N of 10 used": the Plaid Connections the app created or imported, removed ones
// included, plus the Items a Member said were spent outside the app.
async function plaidItemsUsed(): Promise<number> {
  const stored = await readPlaidSettings(runningBank().database);
  return stored.appItems + stored.outsideItems;
}

// The gates before linking spends an Item, or undefined when it may go on. N counts Plaid Items
// only. `replaces` must name a Broken Connection of the same provider that is not removed, and
// once Link names the bank, `bankId` must be that Connection's bank.
async function refusal(
  provider: Provider,
  options: LinkOptions,
  bankId?: string,
): Promise<LinkRefusal | undefined> {
  if (options.replaces !== undefined) {
    const replaced = await readConnection(runningBank().database, options.replaces);
    if (
      replaced?.provider !== provider ||
      replaced.health !== "broken" ||
      replaced.removedAt !== null
    ) {
      return { outcome: "not broken" };
    }
    if (bankId !== undefined && bankId !== replaced.bankId) return { outcome: "other bank" };
  }
  if (provider !== "plaid") return undefined;
  const itemsUsed = await plaidItemsUsed();
  return itemsUsed >= PLAID_ITEM_LIMIT ? { outcome: "item limit", itemsUsed } : undefined;
}

// The Connection that already covers the bank, or undefined (spec 02, Linking a new bank, step 5):
// a Connection at the same bank, or one with an Account of the same type and last 4 digits as an
// incoming Account. The block covers different Accounts at the same bank too. The Broken
// Connection that Link again replaces covers nothing, and nor does a removed one: a removed bank
// may be linked again (spec 02, Carrying Accounts over).
export async function coveringConnection(
  incoming: { bankId: string; accounts: readonly Pick<LinkedAccount, "type" | "mask">[] },
  replaces?: string,
): Promise<CoveringConnection | undefined> {
  const { database } = runningBank();
  const others = (await listConnections(database)).filter(
    (connection) => connection.id !== replaces && connection.removedAt === null,
  );
  const named = (connection: StoredConnection | undefined) =>
    connection && { connectionId: connection.id, bankName: connection.bankName };
  const atBank = others.find((connection) => connection.bankId === incoming.bankId);
  if (atBank !== undefined) return named(atBank);
  const byId = new Map(others.map((connection) => [connection.id, connection]));
  const accounts = await listAccounts(database);
  for (const account of incoming.accounts) {
    if (account.mask === null) continue;
    const match = accounts.find(
      (stored) =>
        stored.connectionId !== null &&
        byId.has(stored.connectionId) &&
        stored.kind === account.type &&
        stored.mask === account.mask,
    );
    if (match?.connectionId) return named(byId.get(match.connectionId));
  }
  return undefined;
}

// Linking and import run one at a time, so two at once cannot both pass the duplicate check and
// spend two Items on one bank.
let adding: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = adding.catch(() => {}).then(work);
  adding = run.catch(() => {});
  return run;
}

// Stores the new Connection with its credential encrypted, which counts it in N, then starts its
// first sync. The sync's argument is the Connection's ID, never its credential. For Link again, the
// same transaction removes the Broken Connection it replaces, closes its Accounts, and ends its
// System notice conditions, so the first sync carries the Accounts over and no banner stays.
async function storeConnection(
  provider: Provider,
  created: NewConnection,
  origin: "linked" | "imported",
  replaces?: string,
  now = new Date(),
): Promise<string> {
  const { database, secrets } = runningBank();
  const connectionId = await addConnection(
    database,
    {
      provider,
      bankId: created.bankId,
      bankName: created.bankName,
      origin,
      sealCredential: (rowId) =>
        secrets.encrypt(created.credential, { rowId, column: "connections.credential" }),
      ...(replaces === undefined
        ? {}
        : { replaces, endsConditions: connectionConditions(replaces) }),
    },
    now,
  );
  if (replaces !== undefined) {
    log.info("Linked a bank again in place of a Broken Connection", {
      connectionId,
      replacedConnectionId: replaces,
    });
  }
  // As the sync schedule does for a due sync, so its next tick does not start a second one.
  await saveSyncState(database, connectionId, {
    nextSyncAt: new Date(now.getTime() + STARTED_SYNC_GAP_MS),
  });
  try {
    await (runningBank().startSync ?? startSync)(connectionId);
  } catch (error) {
    // The schedule tries again within the hour.
    log.warn("Could not start a new Connection's first sync", { connectionId, error });
  }
  return connectionId;
}

// The adapter's call, or its sorted error as an answer. Any other error is a bug, and throws.
async function asked<T>(call: () => Promise<T>): Promise<T | ProviderFailure> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BankDataError)
      return { outcome: "provider error", message: error.message };
    throw error;
  }
}

const failed = <T>(answer: T | ProviderFailure): answer is ProviderFailure =>
  typeof answer === "object" &&
  answer !== null &&
  "outcome" in answer &&
  answer.outcome === "provider error";

// Linking a new bank through one provider's adapter.
export function bankConnecting(provider: Provider): BankConnecting {
  const adapter = () => {
    const found = runningBank().adapters.get(provider);
    if (found === undefined) throw new Error(`No adapter for the provider "${provider}".`);
    return found;
  };

  // The Broken Connection that Link again replaces, once the provider has named the bank it
  // linked: undefined unless it is still Broken, not removed, and at that same bank.
  async function stillReplaced(replaces: string | undefined, bankId: string) {
    if (replaces === undefined) return undefined;
    const replaced = await readConnection(runningBank().database, replaces);
    const same =
      replaced?.provider === provider &&
      replaced.health === "broken" &&
      replaced.removedAt === null &&
      replaced.bankId === bankId;
    return same ? replaces : undefined;
  }

  // The provider named a bank that another Connection covers, after the exchange spent an Item.
  // The new Connection is stored held, in the same insert, so it counts in N, its credential is
  // kept only encrypted, and no path ever syncs it. It is removed at once as Remove does: the
  // provider ends it, then the credential goes. If the provider does not end it, it stays held,
  // for the Member to Remove.
  async function spentOnDuplicate(created: NewConnection, coveredBy: CoveringConnection) {
    const { database, secrets } = runningBank();
    const connectionId = await addConnection(database, {
      provider,
      bankId: created.bankId,
      bankName: created.bankName,
      origin: "linked",
      sealCredential: (rowId) =>
        secrets.encrypt(created.credential, { rowId, column: "connections.credential" }),
      syncHeld: true,
    });
    const removed = (await connectionRemoving().remove(connectionId)).outcome === "removed";
    log.warn("The provider linked a bank that another Connection covers", {
      connectionId,
      coveringConnectionId: coveredBy.connectionId,
      removed,
    });
    return { outcome: "duplicate after link" as const, coveredBy, connectionId, removed };
  }

  // The bank behind a credential made outside the app, checked with the provider, or why not.
  async function imported(credential: string) {
    const found = adapter();
    if (found.importExisting === undefined) {
      throw new Error(`The provider "${provider}" has no import.`);
    }
    const importExisting = found.importExisting.bind(found);
    const created = await asked(() => importExisting(credential));
    if (failed(created)) return created;
    const coveredBy = await coveringConnection(created);
    if (coveredBy !== undefined) return { outcome: "duplicate" as const, coveredBy };
    return created;
  }

  return {
    async startLink(options) {
      const refused = await refusal(provider, options);
      if (refused !== undefined) return refused;
      const itemsUsed = provider === "plaid" ? await plaidItemsUsed() : 0;
      if (itemsUsed >= CONFIRM_ITEMS_FROM && options.confirmed !== true) {
        return { outcome: "confirm", itemsUsed };
      }
      const session = await asked(() => adapter().startLink());
      if (failed(session)) return session;
      return { outcome: "ready", linkToken: session.linkToken, itemsUsed };
    },

    // The browser's bank and Accounts decide only the gates before the exchange. After it, the
    // provider's own answer decides again which Connection is replaced and whether the bank is a
    // duplicate, since the browser's word can be altered. When the provider does not confirm the
    // bank, nothing is decided on the browser's word: the bank is added, and nothing is replaced.
    finishLink(result, options) {
      return oneAtATime(async () => {
        const refused = await refusal(provider, options, result.bankId);
        if (refused !== undefined) return refused;
        const coveredBy = await coveringConnection(result, options.replaces);
        if (coveredBy !== undefined) return { outcome: "duplicate", coveredBy };
        const created = await asked(() => adapter().finishLink(result));
        if (failed(created)) return created;
        if (!created.bankConfirmed) {
          const connectionId = await storeConnection(provider, created, "linked");
          log.warn("Added a bank the provider did not confirm; it replaced nothing", {
            connectionId,
          });
          return {
            outcome: "added unconfirmed",
            connectionId,
            bankName: created.bankName,
            replacedNothing: options.replaces !== undefined,
          };
        }
        const replaces = await stillReplaced(options.replaces, created.bankId);
        const coveredAfter = await coveringConnection(created, replaces);
        if (coveredAfter !== undefined) return spentOnDuplicate(created, coveredAfter);
        const connectionId = await storeConnection(provider, created, "linked", replaces);
        log.info("Linked a new bank", { connectionId });
        if (options.replaces !== undefined && replaces === undefined) {
          log.warn("Link again linked another bank than the Broken Connection's", {
            connectionId,
            brokenConnectionId: options.replaces,
          });
          return { outcome: "added other bank", connectionId, bankName: created.bankName };
        }
        return { outcome: "linked", connectionId, bankName: created.bankName };
      });
    },

    async previewImport(credential): Promise<ImportPreview> {
      const created = await imported(credential);
      if ("outcome" in created) return created;
      return {
        outcome: "preview",
        bankName: created.bankName,
        accounts: created.accounts.map(({ name, type, subtype, mask }) => ({
          name,
          type,
          subtype,
          mask,
        })),
      };
    },

    // Import spends no Item, so N's gates do not apply, but the Connection counts in N.
    importConnection(credential) {
      return oneAtATime(async () => {
        const created = await imported(credential);
        if ("outcome" in created) return created;
        const connectionId = await storeConnection(provider, created, "imported");
        log.info("Imported a Connection", { connectionId });
        return { outcome: "imported", connectionId, bankName: created.bankName };
      });
    },
  };
}

// Repair and Add accounts (spec 02, Repair and New accounts at a bank). Both open the provider's
// link screen in update mode for the same Connection and credential, so neither makes a new
// Connection or spends an Item. The app never repairs a Connection that needs a Member by linking
// the bank as new; a Broken one gets Link again instead, since its credential no longer works.
// Only the browser's link screen gets the link token. When the link screen finishes, the
// Connection's sync job starts at once, and a successful sync makes it Healthy.
export function connectionRepairing(): ConnectionRepairing {
  async function start(connectionId: string, addAccounts: boolean): Promise<UpdateModeStart> {
    // One at a time with linking, so Link again cannot replace the Connection meanwhile.
    return oneAtATime(async () => {
      const { database, adapters } = runningBank();
      const stored = await readConnection(database, connectionId);
      if (stored === undefined || stored.removedAt !== null) return { outcome: "not found" };
      if (stored.syncHeld) return { outcome: "held" };
      if (stored.health === "broken") return { outcome: "link again" };
      if (!addAccounts && stored.health !== "needs a member") return { outcome: "not needed" };
      const adapter = adapters.get(stored.provider);
      if (adapter?.startRepair === undefined || !adapter.actions.repairInApp) {
        return { outcome: "no repair" };
      }
      const startRepair = adapter.startRepair.bind(adapter);
      const connection = adapterConnection(stored);
      const session = await asked(() => startRepair(connection, { addAccounts }));
      if (failed(session)) return session;
      log.info(addAccounts ? "Opened Add accounts" : "Opened Repair", { connectionId });
      return { outcome: "ready", linkToken: session.linkToken };
    });
  }

  return {
    startRepair: (connectionId) => start(connectionId, false),
    startAddAccounts: (connectionId) => start(connectionId, true),

    // A Connection that needs a Member runs its check before the sync, as its daily check does.
    // One at a time with linking, so Link again cannot remove the Connection between this check
    // and the sync's start. No sync starts sooner than the gap after the last one started; then
    // the sync schedule starts it when the gap has passed.
    finishUpdate(connectionId, now = new Date()) {
      return oneAtATime(async (): Promise<UpdateModeFinish> => {
        const { database, adapters } = runningBank();
        const stored = await readConnection(database, connectionId);
        if (stored === undefined || stored.removedAt !== null) return { outcome: "not found" };
        if (stored.syncHeld) return { outcome: "held" };
        if (stored.health === "broken") return { outcome: "link again" };
        const minGapMs = (adapters.get(stored.provider)?.minSyncGapHours ?? 0) * HOUR_MS;
        const last = stored.lastSyncAttemptAt?.getTime();
        const earliest = last === undefined ? 0 : last + Math.max(minGapMs, UPDATE_SYNC_GAP_MS);
        if (now.getTime() < earliest) {
          const due = stored.nextSyncAt?.getTime();
          if (due === undefined || due > earliest) {
            await saveSyncState(database, connectionId, { nextSyncAt: new Date(earliest) });
          }
          log.info("Set the sync after update mode for when the gap has passed", { connectionId });
          return { outcome: "sync soon" };
        }
        // As the sync schedule does for a due sync, so its next tick does not start a second one.
        // The attempt counts from now, so another call cannot start a second sync at once.
        await saveSyncState(database, connectionId, {
          lastSyncAttemptAt: now,
          nextSyncAt: new Date(now.getTime() + STARTED_SYNC_GAP_MS),
        });
        await (runningBank().startSync ?? startSync)(connectionId);
        log.info("Started a sync after update mode", { connectionId });
        return { outcome: "syncing" };
      });
    },
  };
}
