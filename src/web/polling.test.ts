import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerOrder, createPoller, startPolling } from "./polling.ts";

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

// What a page's poll does as the page tells it whether work runs: what usePolling does after each
// render, and what Settings → Banks does after each read.
describe("a page's poller", () => {
  const start = (read: () => Promise<boolean>) => {
    const states: string[] = [];
    const poller = createPoller(read, (state) => states.push(state));
    return { poller, states };
  };

  it("never reads while no work runs, and starts reading when work starts", async () => {
    const read = vi.fn(async () => true);
    const { poller, states } = start(read);

    poller.update(false, PLAN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    expect(states).toEqual(["ended"]);

    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["ended", "polling"]);
  });

  it("stops for good when the page leaves", async () => {
    const read = vi.fn(async () => true);
    const { poller } = start(read);

    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops reading when the work ends, and starts again when the page mounts again", async () => {
    const read = vi.fn(async () => true);
    const { poller } = start(read);

    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(1_000);
    poller.update(false, PLAN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);

    // Strict Mode: mount, leave, mount again with the same values. The second mount reads.
    poller.update(true, PLAN);
    poller.stop();
    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("leaves a running poll alone on the same values, and keeps a give-up until a new round", async () => {
    const read = vi.fn(async () => true);
    const { poller, states } = start(read);

    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(500);
    // Another render half-way through the wait does not restart the wait or the count.
    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(states.at(-1)).toBe("gave up");

    poller.update(true, PLAN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(5);

    // The next bank linked: a fresh count of reads.
    poller.update(true, PLAN, 1);
    expect(states.at(-1)).toBe("polling");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(10);
    expect(states.at(-1)).toBe("gave up");
  });
});

describe("overlapping reads", () => {
  it("drops an older answer that lands after a newer one", () => {
    const order = answerOrder();
    const poll = order.begin();
    const memberAction = order.begin();

    expect(memberAction()).toBe(true);
    expect(poll()).toBe(false);
  });

  it("shows answers that land in order, and an older one when the newer read failed", () => {
    const order = answerOrder();
    const first = order.begin();
    const second = order.begin();
    expect(first()).toBe(true);
    expect(second()).toBe(true);

    const older = order.begin();
    order.begin(); // A newer read that fails never shows.
    expect(older()).toBe(true);
  });
});
