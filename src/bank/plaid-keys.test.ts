import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CountryCode, PlaidApi, PlaidEnvironments } from "plaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConnection } from "../db/index.ts";
import { createLogger, holdsSecretValue } from "../log.ts";
import { SecretDecryptError } from "../secrets/index.ts";
import {
  type PlaidSettings,
  plaidSettings,
  productionPlaidClient,
  readPlaidKeys,
} from "./index.ts";
import { plaidBasePath, plaidConfiguration } from "./plaid-keys.ts";
import { newPlaidKeys, newTestBank, StubPlaid, type TestBank } from "./testing.ts";

// The Plaid keys and the count of Plaid Items (spec 02, Plaid keys and The 10 lifetime Items), on a
// stubbed Plaid client with made-up keys.

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise((resolve) => server.close(resolve));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe("the Plaid keys", () => {
  let test: TestBank;
  let stub: StubPlaid;
  let lines: string[];
  let plaid: PlaidSettings;

  beforeEach(async () => {
    test = await newTestBank();
    stub = new StubPlaid();
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    plaid = plaidSettings({
      database: test.database,
      secrets: test.secrets,
      makeClient: stub.makeClient,
      logger,
    });
  });

  afterEach(() => {
    test.close();
  });

  const storedRow = async () =>
    (await test.database.$client.execute("SELECT id, client_id, secret FROM plaid_settings")).rows;

  it("follows no redirect, so the secret never goes to another host", async () => {
    const keys = newPlaidKeys();
    const secretsElsewhere: unknown[] = [];
    const elsewhere = createServer((req, res) => {
      secretsElsewhere.push(req.headers["plaid-secret"]);
      res.end("{}");
    });
    const redirecting = createServer((_req, res) => {
      res.writeHead(307, { location: `${origin(elsewhere)}/institutions/get` });
      res.end();
    });
    await Promise.all([elsewhere, redirecting].map(listen));
    try {
      const configuration = plaidConfiguration(keys);
      // Only here: a local server in place of Plaid, so the test stays offline.
      configuration.basePath = origin(redirecting);

      const request = new PlaidApi(configuration).institutionsGet({
        count: 1,
        offset: 0,
        country_codes: [CountryCode.Us],
      });

      await expect(request).rejects.toThrow();
      expect(secretsElsewhere).toEqual([]);
    } finally {
      await Promise.all([elsewhere, redirecting].map(close));
    }
  });

  it("uses Plaid's Production environment, and no other", () => {
    const keys = newPlaidKeys();

    const configuration = plaidConfiguration(keys);
    const client = productionPlaidClient(keys) as unknown as { basePath: string };

    expect(PlaidEnvironments.production).toBe("https://production.plaid.com");
    expect(configuration.basePath).toBe(PlaidEnvironments.production);
    expect(client.basePath).toBe(PlaidEnvironments.production);
    expect(configuration.baseOptions.headers).toMatchObject({
      "PLAID-CLIENT-ID": keys.clientId,
      "PLAID-SECRET": keys.secret,
    });
  });

  it("uses Plaid's sandbox only when unbuilt code is given FFT_DEV_PLAID_ENV=sandbox", () => {
    const sandbox = { FFT_DEV_PLAID_ENV: "sandbox" };

    // The tests run unbuilt, as `pnpm dev` does.
    expect(plaidBasePath(sandbox)).toBe(PlaidEnvironments.sandbox);
    expect(plaidBasePath({})).toBe(PlaidEnvironments.production);
    expect(plaidBasePath({ FFT_DEV_PLAID_ENV: "development" })).toBe(PlaidEnvironments.production);
    // The build sets import.meta.env.DEV to false, so the built image ignores it.
    vi.stubEnv("DEV", false);
    try {
      expect(plaidBasePath(sandbox)).toBe(PlaidEnvironments.production);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tests the keys with /institutions/get, then saves the secret encrypted", async () => {
    const keys = newPlaidKeys();
    stub.accepted = keys;

    expect(await plaid.saveKeys(keys)).toBe("saved");

    expect(stub.calls).toEqual([{ keys, request: { count: 1, offset: 0, country_codes: ["US"] } }]);
    const [row] = await storedRow();
    expect(row?.client_id).toBe(keys.clientId);
    expect(String(row?.secret)).not.toContain(keys.secret);
    expect(await readPlaidKeys(test.database, test.secrets)).toEqual(keys);
  });

  it("binds the secret's ciphertext to its row and column", async () => {
    const keys = newPlaidKeys();
    stub.accepted = keys;
    await plaid.saveKeys(keys);
    const ciphertext = String((await storedRow())[0]?.secret);

    expect(() =>
      test.secrets.decrypt(ciphertext, { rowId: 2, column: "plaid_settings.secret" }),
    ).toThrow(SecretDecryptError);
    expect(() =>
      test.secrets.decrypt(ciphertext, { rowId: 1, column: "connections.credential" }),
    ).toThrow(SecretDecryptError);
    expect(test.secrets.decrypt(ciphertext, { rowId: 1, column: "plaid_settings.secret" })).toBe(
      keys.secret,
    );
  });

  it("shows that the secret is set, and never the secret", async () => {
    const keys = newPlaidKeys();
    stub.accepted = keys;
    expect(await plaid.view()).toMatchObject({ clientId: null, secretSet: false });

    await plaid.saveKeys(keys);

    const view = await plaid.view();
    expect(view).toMatchObject({ clientId: keys.clientId, secretSet: true });
    expect(JSON.stringify(view)).not.toContain(keys.secret);
  });

  it("saves nothing when Plaid refuses the keys, and keeps the keys saved before", async () => {
    const good = newPlaidKeys();
    stub.accepted = good;
    await plaid.saveKeys(good);

    const bad = newPlaidKeys();
    expect(await plaid.saveKeys(bad)).toBe("refused");
    expect(await plaid.saveKeys({ clientId: good.clientId, secret: bad.secret })).toBe("refused");

    expect(await readPlaidKeys(test.database, test.secrets)).toEqual(good);
  });

  it("saves nothing when Plaid does not answer, and logs no key", async () => {
    const keys = newPlaidKeys();
    stub.accepted = keys;
    stub.down = true;

    expect(await plaid.saveKeys(keys)).toBe("no answer");

    expect(await storedRow()).toEqual([]);
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
      "Plaid did not answer the keys check",
    ]);
    expect(lines.join("")).not.toContain(keys.secret);
  });

  it("makes the logger refuse the secret as soon as it is given, even when Plaid refuses it", async () => {
    const keys = newPlaidKeys();
    expect(holdsSecretValue(keys.secret)).toBe(false);

    await plaid.saveKeys(keys);

    expect(holdsSecretValue(`Plaid said ${keys.secret}`)).toBe(true);
  });
});

describe("the count of Plaid Items", () => {
  let test: TestBank;
  let plaid: PlaidSettings;

  beforeEach(async () => {
    test = await newTestBank();
    plaid = plaidSettings({
      database: test.database,
      secrets: test.secrets,
      makeClient: new StubPlaid().makeClient,
    });
  });

  afterEach(() => {
    test.close();
  });

  const addPlaidConnection = (bankId: string, origin: "linked" | "imported" = "linked") =>
    addConnection(test.database, {
      provider: "plaid",
      bankId,
      bankName: `Bank ${bankId}`,
      origin,
      syncMinute: 7,
    });

  it("starts at 0 of 10", async () => {
    expect(await plaid.view()).toMatchObject({ itemsUsed: 0, appItems: 0, itemLimit: 10 });
  });

  it("counts every Plaid Connection the app created or imported, and no fake one", async () => {
    await addPlaidConnection("ins_1");
    await addPlaidConnection("ins_2", "imported");
    await test.connect("fake-bank");

    expect(await plaid.view()).toMatchObject({ itemsUsed: 2, appItems: 2 });
  });

  it("keeps counting a removed Connection, even when its row is gone", async () => {
    const removed = await addPlaidConnection("ins_1");
    await addPlaidConnection("ins_2");

    await test.database.$client.execute({
      sql: "DELETE FROM connections WHERE id = ?",
      args: [removed],
    });

    expect(await plaid.view()).toMatchObject({ itemsUsed: 2, appItems: 2 });
  });

  it("lets a Member raise N for Items spent outside the app", async () => {
    await addPlaidConnection("ins_1");

    expect(await plaid.setItemsUsed(4)).toMatchObject({ itemsUsed: 4, appItems: 1 });
    expect(await plaid.view()).toMatchObject({ itemsUsed: 4 });
  });

  it("never lets N fall below the app's own count", async () => {
    await addPlaidConnection("ins_1");
    await addPlaidConnection("ins_2");
    await plaid.setItemsUsed(5);

    expect(await plaid.setItemsUsed(1)).toBeUndefined();
    expect(await plaid.view()).toMatchObject({ itemsUsed: 5 });
    expect(await plaid.setItemsUsed(2)).toMatchObject({ itemsUsed: 2 });
  });

  it("adds each Plaid Connection made after a raise to N", async () => {
    await addPlaidConnection("ins_1");
    await plaid.setItemsUsed(6);

    await addPlaidConnection("ins_2");

    expect(await plaid.view()).toMatchObject({ itemsUsed: 7, appItems: 2 });
    for (const bankId of ["ins_3", "ins_4", "ins_5"]) await addPlaidConnection(bankId);
    expect(await plaid.view()).toMatchObject({ itemsUsed: 10, appItems: 5 });
  });

  it("keeps the Items spent outside the app when the app's count passes the Member's N", async () => {
    await plaid.setItemsUsed(1);
    await addPlaidConnection("ins_1");
    await addPlaidConnection("ins_2");

    expect(await plaid.view()).toMatchObject({ itemsUsed: 3, appItems: 2 });
  });

  it("goes back to the app's own count when a Member sets N to it", async () => {
    await addPlaidConnection("ins_1");
    await plaid.setItemsUsed(4);

    expect(await plaid.setItemsUsed(1)).toMatchObject({ itemsUsed: 1, appItems: 1 });
    await addPlaidConnection("ins_2");
    expect(await plaid.view()).toMatchObject({ itemsUsed: 2, appItems: 2 });
  });

  it("refuses an N that is not a whole number from 0 to 10", async () => {
    for (const itemsUsed of [-1, 11, 2.5, Number.NaN]) {
      await expect(plaid.setItemsUsed(itemsUsed)).rejects.toThrow(RangeError);
    }
  });
});
