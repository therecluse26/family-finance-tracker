import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/index.ts";
import { addMember } from "../auth/testing.ts";
import { DEMO_BANKS } from "../bank/demo.ts";
import { closeDatabase, markSetupStep, openDatabase } from "../db/index.ts";
import { createLogger, log } from "../log.ts";
import { setupCodeOf, unlockSecrets } from "../secrets/index.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import {
  createDevApp,
  DevStartError,
  openDevDatabase,
  showSetupLink,
  withDevMasterKey,
} from "./dev-app.ts";
import { TestBrowser } from "./testing.ts";

// `pnpm dev` makes its own Master key in .dev/ when none is set, so local dev is one command.

describe("the dev Master key", () => {
  let root: string;
  let folder: string;
  const APP_URL = "http://localhost:5173";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fft-dev-"));
    folder = join(root, ".dev");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("is made in the dev folder with mode 0600 when no Master key is set", async () => {
    const env = await withDevMasterKey({ APP_URL }, folder);

    const file = join(folder, "master.key");
    expect(env.FFT_MASTER_KEY_FILE).toBe(file);
    expect(readFileSync(file, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o077).toBe(0);
  });

  it("is kept as it is when it already exists", async () => {
    const first = await withDevMasterKey({ APP_URL }, folder);
    const written = readFileSync(first.FFT_MASTER_KEY_FILE ?? "", "utf8");

    const second = await withDevMasterKey({ APP_URL }, folder);

    expect(second.FFT_MASTER_KEY_FILE).toBe(first.FFT_MASTER_KEY_FILE);
    expect(readFileSync(second.FFT_MASTER_KEY_FILE ?? "", "utf8")).toBe(written);
  });

  it("is not made when FFT_MASTER_KEY_FILE names a file", async () => {
    const own = join(root, "own.key");
    writeFileSync(own, `${newMasterKeyHex()}\n`, { mode: 0o600 });

    const env = await withDevMasterKey({ APP_URL, FFT_MASTER_KEY_FILE: own }, folder);

    expect(env.FFT_MASTER_KEY_FILE).toBe(own);
    expect(() => statSync(join(folder, "master.key"))).toThrow();
  });

  it("is not made when FFT_MASTER_KEY holds a key", async () => {
    const hex = newMasterKeyHex();

    const env = await withDevMasterKey({ APP_URL, FFT_MASTER_KEY: hex }, folder);

    expect(env).toEqual({ APP_URL, FFT_MASTER_KEY: hex });
    expect(() => statSync(join(folder, "master.key"))).toThrow();
  });
});

// The error a promise rejects with.
async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("It did not fail.");
    },
    (error: Error) => error,
  );
}

const badDevKey = (file: string) =>
  `${file} is not a usable dev Master key. Delete it and run \`pnpm dev\` again to make a new one.`;

// A bad .dev/master.key stops `pnpm dev` with one dev message: dev has no `fft setup` key to go
// back to, so the fix is to delete the file. The message never holds the file's content.
describe("the dev app.db", () => {
  let root: string;
  let folder: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fft-dev-"));
    folder = join(root, ".dev");
    file = join(folder, "master.key");
    mkdirSync(folder, { mode: 0o700 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each<[string, string]>([
    ["is 5 bytes", "q7w3x"],
    ["is not hexadecimal", `${newMasterKeyHex().slice(1)}g`],
    ["is empty", ""],
  ])("does not open, with a dev message, when .dev/master.key %s", async (_case, written) => {
    writeFileSync(file, written, { mode: 0o600 });
    const before = readFileSync(file);

    const error = await failure(openDevDatabase({}, folder));

    expect(error).toBeInstanceOf(DevStartError);
    expect(error.message).toBe(badDevKey(file));
    if (written !== "") expect(error.message).not.toContain(written);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(folder, "app.db"))).toBe(false);
  });

  it("does not open, with a dev message, when .dev/master.key is a dangling symlink", async () => {
    const gone = join(root, "gone.key");
    symlinkSync(gone, file);

    const error = await failure(openDevDatabase({}, folder));

    expect(error).toBeInstanceOf(DevStartError);
    expect(error.message).toBe(badDevKey(file));
    expect(readlinkSync(file)).toBe(gone);
    expect(existsSync(gone)).toBe(false);
  });

  it("keeps the production message for a bad key that FFT_MASTER_KEY_FILE names", async () => {
    const own = join(root, "own.key");
    writeFileSync(own, "q7w3x", { mode: 0o600 });

    const error = await failure(openDevDatabase({ FFT_MASTER_KEY_FILE: own }, folder));

    expect(error.name).toBe("MasterKeyError");
    expect(error.message).toBe(
      `The Master key in ${own} is not 32 bytes written as 64 hexadecimal characters. Use the key that \`fft setup\` made.`,
    );
  });

  it("does not open, with a dev message, when app.db was made with another Master key", async () => {
    const other = join(root, "other.key");
    writeFileSync(other, `${newMasterKeyHex()}\n`, { mode: 0o600 });
    const first = await openDevDatabase({ FFT_MASTER_KEY_FILE: other }, folder);
    await unlockSecrets(first.database, first.masterKey);
    closeDatabase(first.database);
    const appDb = join(folder, "app.db");
    const before = readFileSync(appDb);

    // As after deleting .dev/master.key alone: `pnpm dev` makes a new key for the old app.db.
    const error = await failure(openDevDatabase({}, folder));

    expect(error).toBeInstanceOf(DevStartError);
    expect(error.message).toBe(
      `${appDb} was made with another Master key. It holds dev data only: delete ${folder} to start over, and run \`pnpm dev\` again.`,
    );
    expect(error.message).not.toContain("fft restore");
    expect(error.message).not.toContain(readFileSync(file, "utf8").trim());
    expect(error.message).not.toContain(readFileSync(other, "utf8").trim());
    expect(readFileSync(appDb)).toEqual(before);
  });
});

// The setup link goes to the terminal, never through `log`, and shows until the first Member is
// made. It holds the setup code, never the Master key (spec 12, The `fft` command).
describe("the dev setup link", () => {
  let root: string;
  let folder: string;
  let written: string[];
  const SETUP = "http://localhost:5173/setup";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fft-dev-"));
    folder = join(root, ".dev");
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  // Watches `log` and the terminal from here on.
  function watchOutput() {
    written.length = 0;
    return [vi.spyOn(log, "info"), vi.spyOn(log, "warn"), vi.spyOn(log, "error")];
  }

  it("prints to the terminal when no Member exists, and never prints the Master key", async () => {
    const { masterKey, database } = await openDevDatabase({}, folder);
    const hex = readFileSync(join(folder, "master.key"), "utf8").trim();
    const logged = watchOutput();

    await showSetupLink(database, SETUP, masterKey);
    closeDatabase(database);

    expect(written).toEqual([
      `\nOpen this setup link to make the first Member:\n  ${SETUP}#code=${setupCodeOf(masterKey)}\n\n`,
    ]);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    for (const form of [hex, hex.toUpperCase()]) expect(written.join("")).not.toContain(form);
  });

  it("prints nothing once a Member exists", async () => {
    const { masterKey, database } = await openDevDatabase({}, folder);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    const secrets = await unlockSecrets(database, masterKey, { logger: quiet });
    const auth = createAuth({
      database,
      secrets,
      appOrigin: "http://localhost:5173",
      logger: quiet,
    });
    await addMember(auth, { name: "Alice", email: "alice@example.test" });
    const logged = watchOutput();

    await showSetupLink(database, SETUP, masterKey);
    closeDatabase(database);

    expect(written).toEqual([]);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});

// createDevApp runs the services `pnpm start` runs, on the dev folder, plus the fake adapter and
// its fake bank route. No test uses a real Bank-data provider or real bank data, and no scheduled
// task runs, so nothing calls out.
describe("the dev app", () => {
  let root: string;
  let folder: string;
  let webRoot: string;
  let running: { close(): Promise<void> }[];
  const APP_URL = "http://localhost:5173";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fft-dev-"));
    folder = join(root, ".dev");
    webRoot = join(root, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    running = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await Promise.all(running.map((app) => app.close()));
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function start() {
    const dev = await createDevApp(webRoot, { APP_URL }, { folder, tasks: [] });
    running.push(dev);
    return dev;
  }

  async function stop(dev: { close(): Promise<void> }) {
    running.splice(running.indexOf(dev), 1);
    await dev.close();
  }

  // The first Member, made in the dev app.db before the dev app starts, past the wizard's step 3.
  async function firstMember() {
    const { masterKey, database } = await openDevDatabase({}, folder);
    try {
      const quiet = createLogger(() => {}, { throwOnSecretField: true });
      const secrets = await unlockSecrets(database, masterKey, { logger: quiet });
      const auth = createAuth({ database, secrets, appOrigin: APP_URL, logger: quiet });
      const member = await addMember(auth, { name: "Alice", email: "alice@example.test" });
      await markSetupStep(database, "master key", "done");
      return member;
    } finally {
      closeDatabase(database);
    }
  }

  async function historyLoaded(): Promise<unknown[]> {
    const database = await openDatabase(`file:${join(folder, "app.db")}`);
    try {
      const { rows } = await database.$client.execute("SELECT history_loaded FROM connections");
      return rows.map((row) => row.history_loaded);
    } finally {
      closeDatabase(database);
    }
  }

  it("links a demo bank through the fake adapter, and its first sync loads the whole history", async () => {
    const member = await firstMember();
    const dev = await start();
    const tab = new TestBrowser(dev.app, APP_URL, "192.168.1.1");
    await tab.signIn(member);

    const list = await tab.get("/api/connections");
    expect(((await list.json()) as { fakeBank: boolean }).fakeBank).toBe(true);
    const linked = await tab.post("/api/dev/fake-bank", {});

    expect(linked.status).toBe(200);
    const body = (await linked.json()) as { connection: { bankName: string } };
    expect(body.connection.bankName).toBe(DEMO_BANKS[0]?.bankName);
    // The first sync runs as a background job, through the fake adapter's script.
    const deadline = Date.now() + 10_000;
    while ((await historyLoaded())[0] !== 1) {
      if (Date.now() > deadline) throw new Error("The first sync never loaded the history.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it("stops its jobs and closes app.db on close, so it starts again, as after an edit under `pnpm dev`", async () => {
    const member = await firstMember();
    await stop(await start());

    const again = await start();
    const tab = new TestBrowser(again.app, APP_URL, "192.168.1.2");
    await tab.signIn(member);

    expect((await tab.post("/api/dev/fake-bank", {})).status).toBe(200);
  });
});
