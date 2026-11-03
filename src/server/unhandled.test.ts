import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createLogger, registerSecretValue } from "../log.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { logUnhandledRejections } from "./unhandled.ts";

// A promise that rejects with no handler is logged through the shared logger, which refuses
// secrets, in place of Node's own print of the whole error.

describe("unhandled rejections", () => {
  function listen(throwOnSecretField: boolean) {
    const lines: string[] = [];
    const target = new EventEmitter();
    const stop = logUnhandledRejections(
      target,
      createLogger((line) => lines.push(line), { throwOnSecretField }),
    );
    return { lines, target, stop };
  }

  it("logs one line through the logger, and the app keeps running", () => {
    const { lines, target } = listen(false);

    target.emit("unhandledRejection", new Error("the sync job lost its connection"));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "error",
      msg: "A promise rejected with no handler",
    });
    expect(lines[0]).toContain("the sync job lost its connection");
  });

  it("never writes a secret the error holds", () => {
    const secret = `fake-secret-${newMasterKeyHex().slice(0, 24)}`;
    registerSecretValue(secret);
    for (const throwOnSecretField of [false, true]) {
      const { lines, target } = listen(throwOnSecretField);

      target.emit("unhandledRejection", Object.assign(new Error(`token ${secret}`), { secret }));

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain(secret);
    }
  });

  it("stops listening when asked", () => {
    const { lines, target, stop } = listen(false);
    stop();

    expect(target.listenerCount("unhandledRejection")).toBe(0);
    target.emit("unhandledRejection", new Error("ignored"));
    expect(lines).toHaveLength(0);
  });
});
