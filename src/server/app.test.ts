import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validator } from "hono/validator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signedOutAuth } from "../auth/testing.ts";
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

    // The app, with one more route that throws this value.
    async function failingApp(thrown: unknown) {
      lines = [];
      const logger = createLogger((line) => lines.push(line), { throwOnSecretField });
      const app = createApp(webRoot, await loadSecurity({ APP_URL }, { logger }), signedOutAuth);
      app.post("/fail", () => {
        throw thrown;
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

    it.each<[string, unknown]>([
      ["a string", "The bank answered 502"],
      ["an object", { status: 502 }],
      ["undefined", undefined],
    ])("answers 500 and writes one line when a route throws %s", async (_kind, thrown) => {
      const res = await failingApp(thrown);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal error" });
      expect(failures()).toEqual([
        expect.objectContaining({
          level: "error",
          error: expect.objectContaining({
            name: "ThrownValueError",
            message: `A route threw a ${typeof thrown}, not an Error.`,
          }),
        }),
      ]);
      expect(stderr).toEqual([]);
    });

    it("writes no thrown value that is not an Error, since it can hold a secret", async () => {
      const value = newSecretValue();

      const res = await failingApp(`The bank refused ${value}`);

      expect(res.status).toBe(500);
      expect(lines.join("")).not.toContain(value);
    });

    it("keeps the 400 that Hono answers for malformed JSON, and logs no failure", async () => {
      lines = [];
      const logger = createLogger((line) => lines.push(line), { throwOnSecretField });
      const app = createApp(webRoot, await loadSecurity({ APP_URL }, { logger }), signedOutAuth);
      app.post(
        "/echo",
        validator("json", (value) => value),
        (c) => c.json(c.req.valid("json")),
      );

      const res = await app.request(
        `${APP_URL}/echo`,
        {
          method: "POST",
          headers: { host: "nas.local:8080", "content-type": "application/json" },
          body: '{"amount":',
        },
        { incoming: { socket: { remoteAddress: "192.168.1.30" } } },
      );

      expect(res.status).toBe(400);
      expect(failures()).toEqual([]);
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
