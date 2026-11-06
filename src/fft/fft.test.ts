import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth } from "../auth/testing.ts";
import { setupCodeOf } from "../secrets/index.ts";
import { parseMasterKey } from "../secrets/master-key.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { runFft } from "./fft.ts";

// `fft setup` in each state of spec 12's table. Each test gets its own folder for the Master key
// file and app.db.

const APP_URL = "http://192.168.1.20:3000";
const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const LINK =
  /^ {2}(\S+\/setup#code=([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}))$/m;

const codeOf = (hex: string) => setupCodeOf(parseMasterKey(hex, "The test key"));

describe("fft setup", () => {
  let dir: string;
  let keyFile: string;
  let databaseFile: string;
  let out: string;
  let err: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-cli-"));
    keyFile = join(dir, "secrets", "master.key");
    databaseFile = join(dir, "data", "app.db");
    out = "";
    err = "";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fft(args: string[], env: Record<string, string | undefined> = {}) {
    return runFft(args, {
      env: { APP_URL, FFT_MASTER_KEY_FILE: keyFile, ...env },
      databaseFile,
      migrationsFolder: SHIPPED_FOLDER,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
  }

  function printedLink(): { link: string; code: string } {
    const [, link = "", code = ""] = LINK.exec(out) ?? [];
    return { link, code };
  }

  function writeKey(hex: string, mode = 0o600): void {
    mkdirSync(join(dir, "secrets"));
    writeFileSync(keyFile, `${hex}\n`, { mode });
    chmodSync(keyFile, mode);
  }

  async function addFirstMember(): Promise<void> {
    const test = await newTestAuth(APP_URL);
    await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    mkdirSync(join(dir, "data"));
    // app.db's rows may still sit in its write-ahead log.
    for (const suffix of ["", "-wal"]) {
      if (existsSync(`${test.path}${suffix}`)) {
        copyFileSync(`${test.path}${suffix}`, `${databaseFile}${suffix}`);
      }
    }
    test.close();
  }

  it("with no Master key and no Member, makes the key with mode 0600 and prints the link", async () => {
    expect(await fft(["setup"])).toBe(0);

    const hex = readFileSync(keyFile, "utf8").trim();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const { link, code } = printedLink();
    expect(link).toBe(`${APP_URL}/setup#code=${code}`);
    expect(code).toBe(codeOf(hex));
    // fft setup leaves app.db to the app's first start.
    expect(existsSync(databaseFile)).toBe(false);
    expect(err).toBe("");
  });

  it("tells the owner to keep the file private and a copy off the server", async () => {
    await fft(["setup"]);

    expect(out).toContain("readable only by the app's user (mode 0600)");
    expect(out).toContain("Keep a copy of the Master key off this server");
    expect(out).not.toContain(readFileSync(keyFile, "utf8").trim());
  });

  it("with a Master key and no Member, prints the same link again and changes nothing", async () => {
    await fft(["setup"]);
    const first = printedLink();
    const written = readFileSync(keyFile, "utf8");
    out = "";

    expect(await fft(["setup"])).toBe(0);

    expect(printedLink()).toEqual(first);
    expect(readFileSync(keyFile, "utf8")).toBe(written);
    expect(out).toContain("No Member exists yet");
  });

  it("warns when other users can read the Master key file", async () => {
    const hex = newMasterKeyHex();
    writeKey(hex, 0o644);

    expect(await fft(["setup"])).toBe(0);

    expect(out).toContain(`${keyFile} has mode 0644`);
    expect(out).toContain(`chmod 600 ${keyFile}`);
    expect(printedLink().code).toBe(codeOf(hex));
  });

  it("reads FFT_MASTER_KEY when the file is missing, and writes no file", async () => {
    const hex = newMasterKeyHex();
    const env: Record<string, string | undefined> = { FFT_MASTER_KEY: hex };

    expect(await fft(["setup"], env)).toBe(0);

    expect(printedLink().code).toBe(codeOf(hex));
    expect(existsSync(keyFile)).toBe(false);
  });

  it("with a Member, changes nothing and says setup is done", async () => {
    const hex = newMasterKeyHex();
    writeKey(hex);
    await addFirstMember();

    expect(await fft(["setup"])).toBe(0);

    expect(out).toContain("Setup is done");
    expect(out).not.toContain("/setup#code=");
    expect(readFileSync(keyFile, "utf8").trim()).toBe(hex);
  });

  it("with a Member and no Master key, points to the lost-key steps and makes no key", async () => {
    await addFirstMember();

    expect(await fft(["setup"])).toBe(0);

    expect(out).toContain("Setup is done");
    expect(out).toContain("steps for a lost Master key");
    expect(out).not.toContain("/setup#code=");
    expect(existsSync(keyFile)).toBe(false);
  });

  it("stops without APP_URL, and says that .env needs it", async () => {
    expect(await fft(["setup"], { APP_URL: undefined })).toBe(1);

    expect(err).toContain("APP_URL is not set");
    expect(err).toContain(".env");
    expect(existsSync(keyFile)).toBe(false);
  });

  it("stops on an APP_URL that cannot set a security mode", async () => {
    expect(await fft(["setup"], { APP_URL: "http://money.example.com" })).toBe(1);

    expect(err).toContain("fft setup failed");
    expect(existsSync(keyFile)).toBe(false);
  });
});

describe("fft setup --app-url", () => {
  it("prints a new Master key and the setup link for the URL, and writes no file", async () => {
    let out = "";
    const dir = mkdtempSync(join(tmpdir(), "fft-cli-"));
    const keyFile = join(dir, "master.key");
    try {
      const code = await runFft(["setup", "--app-url", "https://money.example.com"], {
        env: { FFT_MASTER_KEY_FILE: keyFile },
        databaseFile: join(dir, "app.db"),
        migrationsFolder: SHIPPED_FOLDER,
        out: (text) => {
          out += text;
        },
        err: () => {},
      });

      expect(code).toBe(0);
      const [, hex = ""] = /^ {2}([0-9a-f]{64})$/m.exec(out) ?? [];
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      const [, link = ""] = LINK.exec(out) ?? [];
      expect(link).toBe(`https://money.example.com/setup#code=${codeOf(hex)}`);
      expect(out).toContain("Keep a copy of the Master key off this server");
      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(join(dir, "app.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fft", () => {
  it("prints its usage for an unknown command", async () => {
    let err = "";
    const code = await runFft(["reset"], {
      env: {},
      databaseFile: "/nonexistent/app.db",
      migrationsFolder: SHIPPED_FOLDER,
      out: () => {},
      err: (text) => {
        err += text;
      },
    });

    expect(code).toBe(2);
    expect(err).toContain("Usage: fft <command>");
  });
});
