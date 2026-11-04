import { Configuration, CountryCode, PlaidApi, PlaidEnvironments } from "plaid";
import {
  type Database,
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  storeItemsUsed,
  storePlaidKeys,
} from "../db/index.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import {
  PLAID_ITEM_LIMIT,
  type PlaidKeys,
  type PlaidKeysCheck,
  type PlaidSettings,
  type PlaidView,
} from "./plaid-view.ts";

// The Plaid keys (spec 02, Plaid keys) and the count of Plaid Items (The 10 lifetime Items). The
// secret is a Master-key secret: the app encrypts it, and never shows or logs it again.

// The secret's place. Its ciphertext decrypts only in plaid_settings' one row, in this column.
const SECRET_PLACE: SecretPlace = { rowId: PLAID_SETTINGS_ROW, column: "plaid_settings.secret" };

const PLAID_TIMEOUT_MS = 15_000;

// The part of Plaid's client that the keys check uses. Tests give a stub.
export type PlaidKeysClient = Pick<PlaidApi, "institutionsGet">;
export type PlaidClientMaker = (keys: PlaidKeys) => PlaidKeysClient;

// Plaid's Production environment, and no other in the built app. The app never asks for a sandbox
// secret. For manual checks with sandbox keys, a developer may set FFT_DEV_PLAID_ENV=sandbox. Only
// unbuilt code, under `pnpm dev` or the tests, reads it: the build sets import.meta.env.DEV to
// false and drops the branch, so the built image has no sandbox. No screen offers it. Plain Node
// has no import.meta.env.
export function plaidBasePath(
  env: { FFT_DEV_PLAID_ENV?: string } = process.env,
): string | undefined {
  if (import.meta.env?.DEV && env.FFT_DEV_PLAID_ENV === "sandbox") {
    return PlaidEnvironments.sandbox;
  }
  return PlaidEnvironments.production;
}

// Plaid's API never redirects, and a redirect to another host would carry the PLAID-SECRET header,
// so the client follows none.
export function plaidConfiguration(keys: PlaidKeys): Configuration {
  return new Configuration({
    basePath: plaidBasePath(),
    baseOptions: {
      timeout: PLAID_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { "PLAID-CLIENT-ID": keys.clientId, "PLAID-SECRET": keys.secret },
    },
  });
}

export const productionPlaidClient: PlaidClientMaker = (keys) =>
  new PlaidApi(plaidConfiguration(keys));

// Plaid's error from a failed request, such as { error_type: "INVALID_INPUT", error_code:
// "INVALID_API_KEYS" }. Only these two fields are read: the error also holds the request, with the
// keys in its headers.
export function plaidError(error: unknown): { type: unknown; code: unknown; status: unknown } {
  const response =
    typeof error === "object" && error !== null && "response" in error
      ? (error.response as {
          status?: unknown;
          data?: { error_type?: unknown; error_code?: unknown };
        })
      : undefined;
  return {
    type: response?.data?.error_type,
    code: response?.data?.error_code,
    status: response?.status,
  };
}

// /institutions/get spends no Item. Its request is fixed and valid, so an INVALID_INPUT error from
// it, such as INVALID_API_KEYS, is about the keys.
async function checkKeys(client: PlaidKeysClient, logger: Logger): Promise<PlaidKeysCheck> {
  try {
    await client.institutionsGet({ count: 1, offset: 0, country_codes: [CountryCode.Us] });
    return "saved";
  } catch (error) {
    const found = plaidError(error);
    if (found.type === "INVALID_INPUT") return "refused";
    logger.warn("Plaid did not answer the keys check", {
      status: typeof found.status === "number" ? found.status : null,
      plaidError: typeof found.code === "string" ? found.code : null,
    });
    return "no answer";
  }
}

export function plaidSettings(options: {
  database: Database;
  secrets: Secrets;
  makeClient?: PlaidClientMaker;
  logger?: Logger;
}): PlaidSettings {
  const { database, secrets, makeClient = productionPlaidClient, logger = log } = options;

  async function view(): Promise<PlaidView> {
    const stored = await readPlaidSettings(database);
    return {
      clientId: stored.clientId,
      secretSet: stored.secret !== null,
      itemsUsed: stored.appItems + stored.outsideItems,
      appItems: stored.appItems,
      itemLimit: PLAID_ITEM_LIMIT,
    };
  }

  return {
    view,

    async saveKeys(keys) {
      // Before Plaid sees it, so no log line can hold it.
      registerSecretValue(keys.secret);
      const checked = await checkKeys(makeClient(keys), logger);
      if (checked !== "saved") return checked;
      await storePlaidKeys(database, {
        clientId: keys.clientId,
        secret: secrets.encrypt(keys.secret, SECRET_PLACE),
      });
      return "saved";
    },

    async setItemsUsed(itemsUsed) {
      if (!Number.isSafeInteger(itemsUsed) || itemsUsed < 0 || itemsUsed > PLAID_ITEM_LIMIT) {
        throw new RangeError(`N is a whole number from 0 to ${PLAID_ITEM_LIMIT}.`);
      }
      return (await storeItemsUsed(database, itemsUsed)) ? view() : undefined;
    },
  };
}

// The saved keys, decrypted, for the Plaid adapter. Decrypting registers the secret with the
// logger, which refuses it from then on.
export async function readPlaidKeys(
  database: Database,
  secrets: Secrets,
): Promise<PlaidKeys | undefined> {
  const stored = await readPlaidSettings(database);
  if (stored.clientId === null || stored.secret === null) return undefined;
  return { clientId: stored.clientId, secret: secrets.decrypt(stored.secret, SECRET_PLACE) };
}
