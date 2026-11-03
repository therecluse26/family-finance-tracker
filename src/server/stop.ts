import { log } from "../log.ts";

// How long the app waits for the running job after SIGTERM.
export const STOP_TIMEOUT_MS = 10_000;

type Signals = {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
};

// On SIGTERM or SIGINT, closes the app, which stops taking requests and starting jobs and waits
// for the running job. The app exits when that is done, or after 10 seconds. A job cut off by the
// exit runs again after the next start.
export function exitOnSignal(
  app: { close: () => Promise<void> },
  exit: (code: number) => void = (code) => process.exit(code),
  signals: Signals = process,
): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info("Stopping", { signal });
    const timeout = setTimeout(() => {
      log.warn("Exiting before the app finished stopping", { waitedMs: STOP_TIMEOUT_MS });
      exit(0);
    }, STOP_TIMEOUT_MS).unref();
    app
      .close()
      .catch((error: unknown) => log.error("The app could not stop cleanly", { error }))
      .finally(() => {
        clearTimeout(timeout);
        exit(0);
      });
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
}
