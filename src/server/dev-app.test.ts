import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { withDevMasterKey } from "./dev-app.ts";

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
