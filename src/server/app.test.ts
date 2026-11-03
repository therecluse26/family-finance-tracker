import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, registerSecretValue } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";

const APP_URL = "http://nas.local:8080";

let values = 0;

function newSecretValue(): string {
  values += 1;
  const value = `route-secret-${values}-${Date.now().toString(36)}`;
  registerSecretValue(value);
  return value;
}

describe.each([true, false])(
  "an error in a route, throwOnSecretField: %s",
  (throwOnSecretField) => {
    let webRoot: string;
    let lines: string[];
    let stderr: unknown[];

    beforeAll(() => {
      webRoot = mkdtempSync(join(tmpdir(), "fft-app-"));
      writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    });

    afterAll(() => {
      rmSync(webRoot, { recursive: true, force: true });
    });

    // Anything written to stderr or console.error, as Hono's default error handler does with the
    // error and its stack trace.
    beforeEach(() => {
      stderr = [];
      vi.spyOn(console, "error").mockImplementation((...args) => stderr.push(args));
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(chunk) > 0);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The app, with one more route that throws this error.
    async function failingApp(error: Error) {
      lines = [];
      const logger = createLogger((line) => lines.push(line), { throwOnSecretField });
      const app = createApp(webRoot, await loadSecurity({ APP_URL }, { logger }));
      app.post("/fail", () => {
        throw error;
      });
      return app.request(
        `${APP_URL}/fail`,
        { method: "POST", headers: { host: "nas.local:8080" } },
        { incoming: { socket: { remoteAddress: "192.168.1.30" } } },
      );
    }

    const failures = () =>
      lines
        .map((line) => JSON.parse(line))
        .filter((line) => line.msg.startsWith("A request failed"));

    it("answers 500 with no details, writes one line through the logger, and nothing to stderr", async () => {
      const error = new Error("The bank answered 502");

      const res = await failingApp(error);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal error" });
      expect(failures()).toEqual([
        expect.objectContaining({
          level: "error",
          msg: "A request failed",
          error: { name: "Error", message: "The bank answered 502", stack: error.stack },
        }),
      ]);
      expect(stderr).toEqual([]);
    });

    it("writes no secret value from the error anywhere", async () => {
      const value = newSecretValue();

      const res = await failingApp(new Error(`The bank refused ${value}`));

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(value);
      expect(failures()).toEqual([expect.objectContaining({ level: "error" })]);
      expect(lines.join("")).not.toContain(value);
      expect(stderr).toEqual([]);
    });
  },
);
