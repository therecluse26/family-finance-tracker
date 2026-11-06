import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "./polling.ts";

// Reading a view again on a timer while work runs on the server: every poll has a cap and an end
// state, never reads twice at once, and stops for good when the page leaves.

const PLAN = { everyMs: 1_000, maxReads: 5 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("polling", () => {
  it("reads after each wait until a read says the work is over, then ends", async () => {
    const answers = [true, true, false];
    const read = vi.fn(async () => answers.shift() ?? false);
    const onEnd = vi.fn();
    startPolling(read, PLAN, onEnd);

    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onEnd).toHaveBeenCalledWith("ended");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("gives up after its cap of reads while the work still runs", async () => {
    const read = vi.fn(async () => true);
    const onEnd = vi.fn();
    startPolling(read, PLAN, onEnd);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(onEnd).toHaveBeenCalledWith("gave up");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("counts a read that throws, so a server that never answers hits the cap", async () => {
    const read = vi.fn(async (): Promise<boolean> => {
      throw new Error("The server did not answer.");
    });
    const onEnd = vi.fn();
    startPolling(read, PLAN, onEnd);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(onEnd).toHaveBeenCalledWith("gave up");
  });

  it("never starts a read while the one before is still out", async () => {
    let finish: (running: boolean) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    startPolling(read, PLAN, () => {});

    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops for good when the page leaves, and ignores the answer of a read still out", async () => {
    let finish: (running: boolean) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const onEnd = vi.fn();
    const stop = startPolling(read, PLAN, onEnd);

    await vi.advanceTimersByTimeAsync(1_000);
    stop();
    finish(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();

    // Stopped before its first read, it never reads.
    const unread = vi.fn(async () => true);
    startPolling(unread, PLAN, onEnd)();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unread).not.toHaveBeenCalled();
  });
});
