import type { EventEmitter } from "node:events";
import { type Logger, log } from "../log.ts";

// A promise that rejects with no handler, such as one a job starts but never awaits, would make
// Node print its error, with every property, to stderr. An error can hold a secret value, so this
// writes one line through the logger instead, which refuses secrets. The app keeps running.
export function logUnhandledRejections(
  target: Pick<EventEmitter, "on" | "off"> = process,
  logger: Logger = log,
): () => void {
  const onRejection = (reason: unknown) => {
    try {
      logger.error("A promise rejected with no handler", { error: reason });
    } catch {
      // Only in tests and development, where the logger throws on a secret instead of refusing it.
      logger.error("A promise rejected with no handler, and its error held a secret");
    }
  };
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("unhandledRejection", onRejection);
  };
}
