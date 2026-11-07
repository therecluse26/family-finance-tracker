// `pnpm dev` only: holds the one dev app that Vite hands /api and /healthz, and its restarts.
//
// Sidequest imports the job list again for every job. After an edit to a server file, Vite hands
// that import new copies of the edited modules, which hold none of the running app's state, so
// every job would fail until the dev app starts again on the same copies. A restart therefore
// closes the dev app, which stops its jobs and closes app.db, then starts it again. A request
// during a restart waits for the new app. Once Vite closes, no request starts a new one. A burst of
// saves, such as `pnpm format` across many files, makes one restart.

type Closable = { close(): Promise<void> };

export type DevAppHolder<App extends Closable> = {
  // The running dev app, started when none runs; undefined once Vite has closed. It rejects when
  // the app could not start.
  current(): Promise<App | undefined>;
  // Closes the running dev app and starts it again. Restarts run one at a time.
  restart(): Promise<void>;
  // Restarts once, `debounceMs` after the last of a burst of calls. Each call in the burst gets the
  // same promise, which settles when that restart has ended.
  restartSoon(): Promise<void>;
  // Closes the running dev app for good: Vite is closing.
  shutdown(): Promise<void>;
};

// How long a restart waits for more saves.
export const RESTART_DEBOUNCE_MS = 100;

export function devAppHolder<App extends Closable>(
  start: () => Promise<App>,
  {
    debounceMs = RESTART_DEBOUNCE_MS,
    onRestart = () => {},
  }: {
    debounceMs?: number;
    // Called as a restart from restartSoon begins, once for each burst.
    onRestart?: () => void;
  } = {},
): DevAppHolder<App> {
  let app: Promise<App> | undefined;
  let closed = false;
  // The burst of restartSoon calls that waits for its timer, if any.
  let soon: { timer: NodeJS.Timeout; done: PromiseWithResolvers<void> } | undefined;
  // The restart or shutdown in progress, if any. It never rejects.
  let changing: Promise<void> = Promise.resolve();

  const stop = async () => {
    const running = app;
    app = undefined;
    // An app that failed to start has nothing to close. A failed close leaves nothing to retry.
    await running?.then(
      (started) => started.close(),
      () => undefined,
    );
  };

  const change = (work: () => Promise<void>) => {
    changing = changing.then(work).catch(() => undefined);
    return changing;
  };

  const holder: DevAppHolder<App> = {
    async current() {
      await changing;
      if (closed) return undefined;
      app ??= start();
      return app;
    },

    restart() {
      return change(async () => {
        if (closed) return;
        await stop();
        if (closed) return;
        app = start();
        await app;
      });
    },

    restartSoon() {
      const done = soon?.done ?? Promise.withResolvers<void>();
      if (soon) clearTimeout(soon.timer);
      const timer = setTimeout(() => {
        soon = undefined;
        if (!closed) onRestart();
        void holder.restart().then(() => done.resolve());
      }, debounceMs);
      soon = { timer, done };
      return done.promise;
    },

    shutdown() {
      closed = true;
      if (soon) {
        clearTimeout(soon.timer);
        soon.done.resolve();
        soon = undefined;
      }
      return change(stop);
    },
  };
  return holder;
}
