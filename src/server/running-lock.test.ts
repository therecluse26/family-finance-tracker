import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LockHeldError,
  type LockToken,
  lockText,
  REFRESH_EVERY_MS,
  type RunningLock,
  STALE_AFTER_MS,
  takeAppLock,
  takeRunningLock,
} from "./running-lock.ts";

// The running lock in /data (spec 11, Restore). Two containers that share /data see one file, so
// a test stands for the other container by writing the file itself, with the time it would have.

// A file system without hard links, such as some network shares, when a test turns it on.
const fileSystem = vi.hoisted(() => ({ hardLinks: true }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (fileSystem.hardLinks) return actual.link(from, to);
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    },
  };
});

describe("the running lock", () => {
  let dir: string;
  let file: string;
  let held: RunningLock[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-lock-"));
    file = join(dir, "app.lock");
    held = [];
    fileSystem.hardLinks = true;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const lock of held) await lock.release();
    rmSync(dir, { recursive: true, force: true });
  });

  // Another process's lock, written `ageMs` ago and not refreshed since.
  function lockOf(token: Partial<LockToken> & Pick<LockToken, "holder">, ageMs: number): string {
    const text = lockText({ id: "other", host: "other-container", pid: 1, ...token });
    writeFileSync(file, text);
    setAge(ageMs);
    return text;
  }

  function setAge(ageMs: number, now = Date.now()) {
    const at = new Date(now - ageMs);
    utimesSync(file, at, at);
  }

  async function take(holder: "app" | "restore") {
    const result = await takeRunningLock(file, holder);
    if (result.taken) held.push(result.lock);
    return result;
  }

  // An app start on a clock the test moves: each wait moves it on, and `onWait` stands for what the
  // other process does meanwhile.
  function appStart(onWait: (now: number) => void = () => {}) {
    let clock = Date.now();
    let waits = 0;
    const lock = takeAppLock(file, {
      now: () => clock,
      sleep: async (ms) => {
        waits += 1;
        clock += ms;
        onWait(clock);
      },
    });
    return { lock, waits: () => waits };
  }

  it("refuses a restore while an app's lock is fresh, and while another restore's is", async () => {
    lockOf({ holder: "app" }, STALE_AFTER_MS - 5_000);
    expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "app" } });

    const restore = lockOf({ holder: "restore" }, 1_000);
    expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "restore" } });
    expect(readFileSync(file, "utf8")).toBe(restore);
  });

  it("takes a stale lock, whoever held it, as after a crash", async () => {
    lockOf({ holder: "app" }, STALE_AFTER_MS + 1_000);
    const restore = await takeRunningLock(file, "restore");
    expect(restore.taken).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      holder: "restore",
      host: hostname(),
      pid: process.pid,
    });
    if (restore.taken) await restore.lock.release();
    expect(existsSync(file)).toBe(false);

    lockOf({ holder: "restore" }, STALE_AFTER_MS + 1_000);
    const app = await takeAppLock(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ holder: "app" });
    await app.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("counts a time far ahead of the clock as stale", async () => {
    lockOf({ holder: "app" }, -10 * 60_000);
    expect((await take("restore")).taken).toBe(true);
  });

  it("lets only one of two processes take one stale lock", async () => {
    lockOf({ holder: "app" }, STALE_AFTER_MS + 1_000);
    const results = await Promise.all([take("restore"), take("restore"), take("restore")]);
    expect(results.filter((result) => result.taken)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["app.lock"]);
  });

  it("never removes a lock another process took between its look and its takeover", async () => {
    lockOf({ holder: "app" }, STALE_AFTER_MS + 1_000);
    const other = lockText({ holder: "restore", id: "racer", host: "other-container", pid: 1 });
    let looks = 0;
    const result = await takeRunningLock(file, "restore", {
      now: () => {
        looks += 1;
        // Just after this process saw the stale lock, another took it and wrote its own.
        if (looks === 2) writeFileSync(file, other);
        return Date.now();
      },
    });
    expect(result).toEqual({ taken: false, refusal: { holder: "restore" } });
    expect(readFileSync(file, "utf8")).toBe(other);
    expect(readdirSync(dir)).toEqual(["app.lock"]);
  });

  it("without hard links, still never removes a lock another process took in between", async () => {
    fileSystem.hardLinks = false;
    lockOf({ holder: "app" }, STALE_AFTER_MS + 1_000);
    const other = lockText({ holder: "restore", id: "racer", host: "other-container", pid: 5 });
    let looks = 0;
    const result = await takeRunningLock(file, "app", {
      now: () => {
        looks += 1;
        if (looks === 2) writeFileSync(file, other);
        return Date.now();
      },
    });
    expect(result).toEqual({ taken: false, refusal: { holder: "restore" } });
    expect(readFileSync(file, "utf8")).toBe(other);
    expect(readdirSync(dir)).toEqual(["app.lock"]);

    // And it still takes a stale lock, and deletes only its own.
    setAge(STALE_AFTER_MS + 1_000);
    const taken = await take("restore");
    expect(taken.taken).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ holder: "restore" });
    await held.pop()?.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops the app's start at once while a restore's lock is fresh", async () => {
    const restore = lockOf({ holder: "restore" }, 1_000);
    const start = appStart();
    await expect(start.lock).rejects.toThrow(LockHeldError);
    await expect(takeAppLock(file)).rejects.toThrow("fft restore is running");
    expect(start.waits()).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(restore);
  });

  describe("two apps on one /data", () => {
    it("refuses the second app while the first keeps its lock fresh, and a restore still refuses", async () => {
      const first = await take("app");
      if (!first.taken) throw new Error("The first app's lock was not taken");
      const firstLock = readFileSync(file, "utf8");

      // In this process, as two app containers that share a host name and process ID would be.
      expect(await take("app")).toEqual({ taken: false, refusal: { holder: "app" } });
      const second = appStart((now) => setAge(0, now));
      await expect(second.lock).rejects.toThrow("Another app process on this data folder");
      expect(second.waits()).toBeGreaterThan(30);

      expect(readFileSync(file, "utf8")).toBe(firstLock);
      // The first app refreshed it just now, on the real clock.
      setAge(0);
      expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "app" } });
    });

    it("waits for another container's app lock to go stale, then takes it", async () => {
      const other = lockOf({ holder: "app" }, 1_000);
      const start = appStart();
      const lock = await start.lock;
      held.push(lock);
      expect(start.waits()).toBeGreaterThan(25);
      expect(readFileSync(file, "utf8")).not.toBe(other);
    });

    // Two containers can share a host name (network_mode: host, or hostname: in Compose), and the
    // app is process 1 in each, so a lock that names this host and this process ID may be a live
    // app's in another container.
    it("never takes over a fresh lock that names this host, with this process ID or one not visible here", async () => {
      for (const pid of [process.pid, 4_000_000]) {
        const live = lockOf({ holder: "app", host: hostname(), pid }, 1_000);
        expect(await take("app")).toEqual({ taken: false, refusal: { holder: "app" } });
        const start = appStart((now) => setAge(0, now));
        await expect(start.lock).rejects.toThrow("Another app process on this data folder");
        expect(readFileSync(file, "utf8")).toBe(live);
        setAge(0);
        expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "app" } });
      }
    });

    it("after a crash, starts once its old lock is stale", async () => {
      // The killed app refreshed its lock 1 second before it stopped.
      const old = lockOf({ holder: "app", host: hostname(), pid: process.pid }, 1_000);
      const restarted = appStart();
      held.push(await restarted.lock);
      expect(restarted.waits()).toBeGreaterThanOrEqual(28);
      expect(restarted.waits()).toBeLessThanOrEqual(30);
      expect(readFileSync(file, "utf8")).not.toBe(old);
    });

    it("on release, deletes only its own lock", async () => {
      const first = await take("app");
      if (!first.taken) throw new Error("The first app's lock was not taken");
      // Another app took the lock over after this one went stale.
      const other = lockText({ holder: "app", id: "other", host: "other-container", pid: 1 });
      writeFileSync(file, other);
      await first.lock.release();
      expect(readFileSync(file, "utf8")).toBe(other);
    });
  });

  it("holds anything at the path that is not a plain file, and never writes through it", async () => {
    const target = join(dir, "elsewhere");
    const appLock = lockText({ holder: "app", id: "other", host: "other-container", pid: 1 });
    writeFileSync(target, appLock);
    symlinkSync(target, file);
    expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "unknown" } });
    const start = appStart();
    await expect(start.lock).rejects.toThrow("is not a lock file the app wrote");
    expect(start.waits()).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(appLock);

    rmSync(file);
    mkdirSync(file);
    expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "unknown" } });
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it("refuses a fresh file it cannot read as a lock", async () => {
    writeFileSync(file, "app\n");
    expect(await take("restore")).toEqual({ taken: false, refusal: { holder: "unknown" } });
  });

  describe("refreshes", () => {
    it("its time every 10 seconds, so it stays fresh while its holder runs", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const taken = await take("restore");
      if (!taken.taken) throw new Error("The lock was not taken");
      vi.setSystemTime(Date.now() + 3 * REFRESH_EVERY_MS);
      await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
      await vi.waitFor(() => {
        expect(Math.abs(statSync(file).mtimeMs - Date.now())).toBeLessThan(1_000);
      });
      // 40 seconds after it was taken, the refreshed lock still stops the app.
      await expect(takeAppLock(file)).rejects.toThrow(LockHeldError);
    });

    it("writes its lock again when it is gone, and never over another process's lock", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const warnings: string[] = [];
      const taken = await takeRunningLock(file, "app", { warn: (line) => warnings.push(line) });
      if (!taken.taken) throw new Error("The lock was not taken");
      held.push(taken.lock);
      const own = readFileSync(file, "utf8");

      rmSync(file);
      await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
      await vi.waitFor(() => expect(existsSync(file)).toBe(true));
      expect(readFileSync(file, "utf8")).toBe(own);

      const other = lockText({ holder: "app", id: "other", host: "other-container", pid: 1 });
      writeFileSync(file, other);
      await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
      await vi.advanceTimersByTimeAsync(REFRESH_EVERY_MS);
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(readFileSync(file, "utf8")).toBe(other);
      expect(warnings).toEqual([
        "The running lock was gone, so it was written again",
        "Another process holds the running lock",
      ]);
    });
  });
});
