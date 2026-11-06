import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitOnSignal } from "./stop.ts";

describe("stopping on SIGTERM", () => {
  let signals: EventEmitter;
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let finishClose: () => void;
  let close: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    signals = new EventEmitter();
    exit = vi.fn<(code: number) => void>();
    close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    exitOnSignal({ close }, exit, signals);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the app at once, and exits after 10 s if the running job has not ended", async () => {
    signals.emit("SIGTERM", "SIGTERM");
    expect(close).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits as soon as the running job ends", async () => {
    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(2_000);

    finishClose();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("stops on SIGINT too, and closes the app once for several signals", async () => {
    signals.emit("SIGINT", "SIGINT");
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");

    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledOnce();
  });
});

describe("stopping on SIGTERM during the start", () => {
  let signals: EventEmitter;
  let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let close: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    signals = new EventEmitter();
    exit = vi.fn<(code: number) => void>();
    close = vi.fn(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the start to end, then closes the app, which releases the running lock", async () => {
    let finishStart: (app: { close: typeof close }) => void = () => {};
    exitOnSignal(
      new Promise((resolve) => {
        finishStart = resolve;
      }),
      exit,
      signals,
    );

    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finishStart({ close });
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits after 10 s when the start has not ended", async () => {
    exitOnSignal(new Promise(() => {}), exit, signals);

    signals.emit("SIGINT", "SIGINT");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("leaves the exit to main when the start fails, as the failed start released the lock", async () => {
    const failed = Promise.reject(new Error("The start failed"));
    failed.catch(() => {});
    exitOnSignal(failed, exit, signals);

    signals.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(exit).not.toHaveBeenCalled();
  });
});
