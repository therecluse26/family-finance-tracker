import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { newMasterKeyHex } from "../secrets/testing.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "fft-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Runs the real entry point, the way the image starts it, with only these settings. Its Master
// key file is missing unless a test names another.
function start(settings: Record<string, string>) {
  const {
    APP_URL: _appUrl,
    TRUSTED_PROXIES: _trustedProxies,
    FFT_MASTER_KEY: _masterKey,
    FFT_MASTER_KEY_FILE: _masterKeyFile,
    ...env
  } = process.env;
  const run = spawnSync(process.execPath, [MAIN], {
    env: { ...env, FFT_MASTER_KEY_FILE: join(dir, "missing.key"), ...settings },
    encoding: "utf8",
    timeout: 10_000,
  });
  const lines = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  return { status: run.status, lines, output: run.stdout + run.stderr };
}

describe("the app at start", () => {
  it.each<[string, Record<string, string>, string]>([
    ["APP_URL is missing", {}, "APP_URL is missing."],
    ["APP_URL is empty", { APP_URL: "" }, "APP_URL is missing."],
    [
      "APP_URL is ftp://",
      { APP_URL: "ftp://nas.local" },
      "APP_URL must start with https:// or http://.",
    ],
    ["APP_URL has no scheme", { APP_URL: "nas.local:3000" }, "APP_URL must start with https://"],
    [
      "APP_URL is http:// with a public host",
      { APP_URL: "http://money.example.com" },
      'not "money.example.com"',
    ],
    [
      "APP_URL is http:// with a public IP",
      { APP_URL: "http://203.0.113.5:3000" },
      'not "203.0.113.5"',
    ],
    [
      "TRUSTED_PROXIES has an entry it cannot read",
      { APP_URL: "https://money.example.com", TRUSTED_PROXIES: "10.0.0.0/33" },
      'TRUSTED_PROXIES holds "10.0.0.0/33"',
    ],
    [
      "TRUSTED_PROXIES is * with an http:// APP_URL",
      { APP_URL: "http://nas.local:3000", TRUSTED_PROXIES: "*" },
      "list the proxy's own address instead",
    ],
    [
      "TRUSTED_PROXIES covers every address with an http:// APP_URL",
      { APP_URL: "http://nas.local:3000", TRUSTED_PROXIES: "0.0.0.0/0" },
      "TRUSTED_PROXIES covers every IPv4 or every IPv6 address",
    ],
  ])("logs the reason and exits when %s", (_case, settings, reason) => {
    const { status, lines } = start({ PORT: "1", ...settings });

    expect(status).toBe(1);
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "The app could not start",
        error: expect.objectContaining({ message: expect.stringContaining(reason) }),
      }),
    ]);
  });
});

describe("the app at start, before it opens app.db", () => {
  const ready = { PORT: "1", APP_URL: "http://nas.local:3000" };

  const errors = (lines: { level: string }[]) => lines.filter((line) => line.level === "error");

  it("logs that `fft setup` must run first, and exits, when there is no Master key", () => {
    const { status, lines } = start(ready);

    expect(status).toBe(1);
    expect(errors(lines)).toEqual([
      expect.objectContaining({
        msg: "The app could not start",
        error: expect.objectContaining({
          name: "MasterKeyError",
          message: expect.stringContaining("Run `fft setup` first."),
        }),
      }),
    ]);
  });

  it.each<[string, (hex: string) => string]>([
    ["is one character short", (hex) => hex.slice(1)],
    ["is one character long", (hex) => `${hex}0`],
    ["holds a letter that is not hexadecimal", (hex) => `g${hex.slice(1)}`],
    ["is the 32 bytes in base64", (hex) => Buffer.from(hex, "hex").toString("base64")],
  ])("logs the reason and exits when FFT_MASTER_KEY %s, and never logs it", (_case, written) => {
    const value = written(newMasterKeyHex());

    const { status, lines, output } = start({ ...ready, FFT_MASTER_KEY: value });

    expect(status).toBe(1);
    expect(errors(lines)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          name: "MasterKeyError",
          message: expect.stringContaining("is not 32 bytes written as 64 hexadecimal characters"),
        }),
      }),
    ]);
    expect(output).not.toContain(value);
  });
});
