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
  type CoveringConnection,
  type ImportPreview,
  type LinkOptions,
  type LinkRefusal,
  type ProviderFailure,
} from "./connect-view.ts";
import { startSync } from "./job.ts";
import { PLAID_ITEM_LIMIT } from "./plaid-view.ts";
import { runningBank } from "./sync.ts";
import { STARTED_SYNC_GAP_MS } from "./sync-times.ts";

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
// only. `replaces` must name a Broken Connection of the same provider.
async function refusal(provider: Provider, options: LinkOptions): Promise<LinkRefusal | undefined> {
  if (options.replaces !== undefined) {
    const replaced = await readConnection(runningBank().database, options.replaces);
    if (replaced?.provider !== provider || replaced.health !== "broken") {
      return { outcome: "not broken" };
    }
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
// first sync. The sync's argument is the Connection's ID, never its credential.
async function storeConnection(
  provider: Provider,
  created: NewConnection,
  origin: "linked" | "imported",
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
    },
    now,
  );
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

    finishLink(result, options) {
      return oneAtATime(async () => {
        const refused = await refusal(provider, options);
        if (refused !== undefined) return refused;
        const coveredBy = await coveringConnection(result, options.replaces);
        if (coveredBy !== undefined) return { outcome: "duplicate", coveredBy };
        const created = await asked(() => adapter().finishLink(result));
        if (failed(created)) return created;
        const connectionId = await storeConnection(provider, created, "linked");
        log.info("Linked a new bank", { connectionId });
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
