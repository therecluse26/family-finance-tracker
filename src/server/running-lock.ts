import { link, lstat, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";

// The running lock (spec 11, Restore): a file in /data that says the app, or `fft restore`, is
// running. It works across containers that share /data, such as `docker compose run --rm app fft
// restore` beside the app's own container. Its holder refreshes the file's time every 10 seconds
// and deletes it as it stops. A lock not refreshed for 30 seconds is stale: its holder stopped
// without deleting it, as in a crash, and the next process takes it.
// - Each lock names its holder, a random ID for this one hold, the host name and the process ID.
//   A holder deletes or refreshes only a lock with its own ID. The host name and process ID only
//   help a person who reads the file: they never decide anything, since two containers can share
//   a host name, and the app is process 1 in each.
// - No process ever takes over a fresh lock, not even one that names its own host and process ID.
// - `fft restore` refuses to run while any fresh lock is there.
// - The app refuses to start while a restore holds a fresh lock. It waits for an app lock to go
//   stale, and refuses to start while another app keeps it fresh. So an app restarted after a
//   crash starts once its old lock is stale, up to about 30 seconds later.

export const RUNNING_LOCK_FILE = "/data/app.lock";

export const REFRESH_EVERY_MS = 10_000;
export const STALE_AFTER_MS = 30_000;
// How often a waiting app start looks at the lock again.
const WAIT_STEP_MS = 1_000;

export type LockHolder = "app" | "restore";

export type LockToken = { holder: LockHolder; id: string; host: string; pid: number };

export type RunningLock = { release(): Promise<void> };

export type LockRefusal = { holder: LockHolder | "unknown" };

export type LockOptions = {
  now?: () => number;
  // A line for the log, through src/log.ts, when a refresh fails or the lock is lost.
  warn?: (message: string) => void;
};

export function lockText(token: LockToken): string {
  return `${JSON.stringify(token)}\n`;
}

function tokenOf(text: string): LockToken | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const { holder, id, host, pid } = value as Record<string, unknown>;
    if (holder !== "app" && holder !== "restore") return undefined;
    if (typeof id !== "string" || typeof host !== "string") return undefined;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return { holder, id, host, pid };
  } catch {
    return undefined;
  }
}

type FoundLock =
  | { plain: false }
  | { plain: true; text: string; token: LockToken | undefined; fresh: boolean };

// The lock at `file`, or undefined when there is none. A time far ahead of the clock counts as
// stale, so a wrong time never holds the lock for good. Anything at the path that is not a plain
// file, such as a link, holds it, as a lock the app did not write.
async function readLock(file: string, now: number): Promise<FoundLock | undefined> {
  const found = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (found === undefined) return undefined;
  if (!found.isFile()) return { plain: false };
  const text = await readFile(file, "utf8").catch(() => "");
  const fresh = Math.abs(now - found.mtimeMs) < STALE_AFTER_MS;
  return { plain: true, text, token: tokenOf(text), fresh };
}

// Writes a new lock with its whole text in one step: a file of its own, then a hard link at the
// lock's path, which fails when the path is taken. False when another lock is there.
async function createLock(file: string, text: string, id: string): Promise<boolean> {
  const own = `${file}.${id}.new`;
  await writeFile(own, text, { flag: "wx", mode: 0o600 });
  try {
    await link(own, file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    // A file system without hard links: "wx" still refuses a path that is taken.
    try {
      await writeFile(file, text, { flag: "wx", mode: 0o600 });
      return true;
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fallback;
    }
  } finally {
    await unlink(own).catch(() => {});
  }
}

// Removes the lock at `file` only while it is still the one read as `seen`, and, for a stale one,
// still stale. It moves the lock aside in one step and looks at what it moved: a lock another
// process wrote or refreshed in between goes back.
async function removeIfStill(
  file: string,
  seen: string,
  id: string,
  staleAt: number | undefined,
): Promise<void> {
  const aside = `${file}.${id}.old`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = await lstat(aside).catch(() => undefined);
  const text = moved?.isFile() ? await readFile(aside, "utf8").catch(() => undefined) : undefined;
  const same =
    text === seen &&
    (staleAt === undefined ||
      (moved !== undefined && Math.abs(staleAt - moved.mtimeMs) >= STALE_AFTER_MS));
  if (same) {
    await unlink(aside).catch(() => {});
    return;
  }
  // Another process's lock: back to its path. A hard link puts it back only while the path is free.
  // On a file system without hard links, a rename puts it back. A third lock made in that small
  // window would be replaced, so the lock that is still live, the one moved aside, is never lost.
  try {
    await link(aside, file);
    await unlink(aside).catch(() => {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A third process made its lock at the path: it holds it now, and the moved one is gone.
      await unlink(aside).catch(() => {});
      return;
    }
    await rename(aside, file);
  }
}

function held(
  file: string,
  text: string,
  id: string,
  warn: (message: string) => void,
): RunningLock {
  let lost = false;
  let refreshing = false;
  const refresh = async () => {
    const now = await readFile(file, "utf8").catch(() => undefined);
    if (now === text) {
      lost = false;
      const at = new Date();
      await utimes(file, at, at).catch(() => warn("Could not refresh the running lock"));
      return;
    }
    // Deleted, or replaced by another process: write it again only when the path is free.
    if (now === undefined && (await createLock(file, text, id).catch(() => false))) {
      warn("The running lock was gone, so it was written again");
      return;
    }
    if (!lost) warn("Another process holds the running lock");
    lost = true;
  };
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    refresh()
      .catch(() => warn("Could not refresh the running lock"))
      .finally(() => {
        refreshing = false;
      });
  }, REFRESH_EVERY_MS);
  timer.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Deletes only its own lock: one another process took over stays.
      if ((await readFile(file, "utf8").catch(() => undefined)) !== text) return;
      await removeIfStill(file, text, id, undefined);
    },
  };
}

// Takes the running lock for `holder`, or returns who holds it. A stale lock is taken; a fresh one
// never is.
export async function takeRunningLock(
  file: string,
  holder: LockHolder,
  options: LockOptions = {},
): Promise<{ taken: true; lock: RunningLock } | { taken: false; refusal: LockRefusal }> {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? (() => {});
  const id = crypto.randomUUID();
  const text = lockText({ holder, id, host: hostname(), pid: process.pid });
  // A few tries: each one that finds a stale lock removes it, and the next takes the path.
  for (let tries = 0; tries < 3; tries += 1) {
    if (await createLock(file, text, id)) return { taken: true, lock: held(file, text, id, warn) };
    const found = await readLock(file, now());
    if (found === undefined) continue;
    if (!found.plain) return { taken: false, refusal: { holder: "unknown" } };
    if (found.fresh) return { taken: false, refusal: { holder: found.token?.holder ?? "unknown" } };
    await removeIfStill(file, found.text, id, now());
  }
  const found = await readLock(file, now());
  const holderNow = found?.plain === true ? (found.token?.holder ?? "unknown") : "unknown";
  return { taken: false, refusal: { holder: holderNow } };
}

export class LockHeldError extends Error {
  override name = "LockHeldError";
}

// The app's lock, taken at start before app.db opens. It throws while `fft restore` runs, while
// another app keeps its lock fresh, or while something the app did not write sits at the lock's
// path. It waits for an app lock to go stale, at most 40 seconds: the stale time and one refresh.
// That covers its own lock from before a crash, which goes stale at most 30 seconds after the
// crash.
export async function takeAppLock(
  file: string,
  options: LockOptions & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunningLock> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const until = now() + STALE_AFTER_MS + REFRESH_EVERY_MS;
  for (;;) {
    const result = await takeRunningLock(file, "app", options);
    if (result.taken) return result.lock;
    const { holder } = result.refusal;
    if (holder === "restore") {
      throw new LockHeldError(
        "fft restore is running, so the app did not start. Start it once the restore ends.",
      );
    }
    if (holder === "unknown") {
      throw new LockHeldError(
        `${file} is not a lock file the app wrote, so the app did not start. Delete it, then ` +
          "start the app again.",
      );
    }
    if (now() >= until) {
      throw new LockHeldError(
        "Another app process on this data folder keeps the running lock fresh, so this one did " +
          "not start. Two apps must never share one app.db: stop the other one first.",
      );
    }
    await sleep(WAIT_STEP_MS);
  }
}
