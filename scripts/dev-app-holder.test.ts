import { describe, expect, it } from "vitest";
import { devAppHolder } from "./dev-app-holder.ts";

// `pnpm dev`'s one dev app: started once, started again after a server file changes, and closed
// for good when Vite closes.

type FakeApp = { id: number; closed: boolean; close(): Promise<void> };

function counting(options: { closeWaits?: Promise<void>; failStart?: number } = {}) {
  const started: FakeApp[] = [];
  const start = async (): Promise<FakeApp> => {
    const id = started.length + 1;
    if (options.failStart === id) {
      started.push({ id, closed: true, close: async () => {} });
      throw new Error(`Start ${id} failed.`);
    }
    const app: FakeApp = {
      id,
      closed: false,
      close: async () => {
        await options.closeWaits;
        app.closed = true;
      },
    };
    started.push(app);
    return app;
  };
  return { started, start };
}

describe("the dev app holder", () => {
  it("starts the dev app once, however many requests come at once", async () => {
    const { started, start } = counting();
    const holder = devAppHolder(start);

    const apps = await Promise.all([holder.current(), holder.current(), holder.current()]);

    expect(started).toHaveLength(1);
    expect(apps.map((app) => app?.id)).toEqual([1, 1, 1]);
  });

  it("on a restart, closes the running app before it starts a new one", async () => {
    const { started, start } = counting();
    const holder = devAppHolder(start);
    const first = await holder.current();

    await holder.restart();

    expect(first?.closed).toBe(true);
    expect(started).toHaveLength(2);
    expect((await holder.current())?.id).toBe(2);
    expect(started[1]?.closed).toBe(false);
  });

  it("makes a request during a restart wait for the new app, never the closing one", async () => {
    let finishClose = () => {};
    const closeWaits = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const { started, start } = counting({ closeWaits });
    const holder = devAppHolder(start);
    await holder.current();

    const restarting = holder.restart();
    const during = holder.current();
    finishClose();
    await restarting;

    expect((await during)?.id).toBe(2);
    expect(started).toHaveLength(2);
  });

  it("runs restarts one at a time, so two apps never run together", async () => {
    const { started, start } = counting();
    const holder = devAppHolder(start);
    await holder.current();

    await Promise.all([holder.restart(), holder.restart()]);

    expect(started).toHaveLength(3);
    expect(started.filter((app) => !app.closed).map((app) => app.id)).toEqual([3]);
  });

  it("starts no new app for a request that comes while Vite closes, or after", async () => {
    let finishClose = () => {};
    const closeWaits = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const { started, start } = counting({ closeWaits });
    const holder = devAppHolder(start);
    const first = await holder.current();

    const closing = holder.shutdown();
    const during = holder.current();
    finishClose();
    await closing;

    expect(await during).toBeUndefined();
    expect(await holder.current()).toBeUndefined();
    await holder.restart();
    expect(started).toHaveLength(1);
    expect(first?.closed).toBe(true);
  });

  it("starts again on the next restart after a start that failed, such as for a syntax error", async () => {
    const { started, start } = counting({ failStart: 2 });
    const holder = devAppHolder(start);
    await holder.current();

    await holder.restart();
    await expect(holder.current()).rejects.toThrow("Start 2 failed.");
    await holder.restart();

    expect((await holder.current())?.id).toBe(3);
    expect(started).toHaveLength(3);
  });
});
