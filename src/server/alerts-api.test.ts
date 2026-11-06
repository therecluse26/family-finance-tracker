import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAlertSending, startAnomalyChecks, weeklyCap } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addConnection,
  deleteRemovedConnection,
  markConnectionRemoved,
  markSetupStep,
  storeAlertThread,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import type { AlertPartView, AlertSettingsView, AlertView } from "./alerts-views.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Alert list and Settings, Alerts through the app's HTTP interface, on Transactions the fake
// adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-alerts-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Alert list route", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let memberId: string;
  let connectionId: string;
  let stops: (() => void)[];
  let now: Date;
  const clock = () => now;

  beforeEach(async () => {
    now = new Date("2026-09-05T15:00:00.000Z");
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      // The follow-up job runs at once.
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp(clock) }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
      startRecurringCharges({ database: test.database, now: clock }).stop,
      startAnomalyChecks({ database: test.database, now: clock }).stop,
      startAlertSending({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    memberId = member.id;

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const shell = (id: string, postedDate: string) =>
      fakeTxn({ id, accountId: card.id, amount: -4_250, postedDate, merchantName: "Shell" });
    fake.addPages(BANK, {
      accounts: [card],
      added: [shell("h1", "2026-09-01"), shell("h2", "2026-09-02")],
      historyLoaded: true,
    });
    connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);

    // Two Duplicate charges on one day: one merged Alert, sent outside the weekly cap.
    now = new Date("2026-10-22T15:00:00.000Z");
    const cafe = (id: string, postedDate: string) =>
      fakeTxn({
        id,
        accountId: card.id,
        amount: -1_875,
        postedDate,
        merchantName: "Blue Door Cafe",
      });
    fake.addPages(BANK, {
      added: [
        shell("h3", "2026-10-20"),
        shell("h4", "2026-10-21"),
        cafe("c1", "2026-10-19"),
        cafe("c2", "2026-10-20"),
      ],
    });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  it("lists every Alert newest first, with its state, and a merged Alert's parts under one heading", async () => {
    const res = await browser.get("/api/alerts");
    expect(res.status).toBe(200);
    const { alerts } = (await res.json()) as { alerts: AlertView[] };
    expect(alerts).toEqual([
      {
        id: expect.any(String),
        kind: "Duplicate charge",
        createdAt: "2026-10-22T15:00:00.000Z",
        heading: "2 Duplicate charges",
        parts: [
          expect.objectContaining({
            text: expect.stringMatching(/^Possible duplicate charge: \$\d+\.\d\d at /),
            transactionIds: [expect.any(String), expect.any(String)],
            advice: null,
            notAProblem: [],
          }),
          expect.objectContaining({ text: expect.stringMatching(/^Possible duplicate charge: /) }),
        ],
        state: "sent",
      },
      expect.objectContaining({
        kind: "Duplicate charge",
        createdAt: "2026-09-05T15:00:00.000Z",
        heading: null,
        parts: [
          expect.objectContaining({ text: expect.stringMatching(/, on Sep 1 and Sep 2\.$/) }),
        ],
        state: "found in history",
      }),
    ]);
    const [merged] = alerts;
    expect(merged?.id).toBe(merged?.parts[0]?.id);
    expect(merged?.parts.map((part) => part.text).sort()).toEqual([
      expect.stringMatching(
        /^Possible duplicate charge: \$18\.75 at Blue Door Cafe on .+, on Oct 19 and Oct 20\.$/,
      ),
      expect.stringMatching(
        /^Possible duplicate charge: \$42\.50 at Shell on .+, on Oct 20 and Oct 21\.$/,
      ),
    ]);
  });

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await signedOut.get("/api/alerts")).status).toBe(401);
    expect((await signedOut.get("/api/alert-settings")).status).toBe(401);
  });

  describe('"Not a problem"', () => {
    const press = (id: string, headers: Record<string, string | undefined> = {}) =>
      browser.send("POST", `/api/alerts/${encodeURIComponent(id)}/not-a-problem`, {}, headers);
    const list = async () =>
      ((await (await browser.get("/api/alerts")).json()) as { alerts: AlertView[] }).alerts;
    const pressCount = async () =>
      (await test.database.$client.execute("SELECT count(*) AS n FROM alert_presses")).rows[0]?.n;

    it("records who pressed it and when on one part of an Alert, once per Member, with no AI call", async () => {
      const [merged] = await list();
      const [first, second] = merged?.parts ?? [];
      const before = Date.now();

      const res = await press(first?.id ?? "");
      expect(res.status).toBe(200);
      const { notAProblem } = (await res.json()) as { notAProblem: AlertPartView["notAProblem"] };
      expect(notAProblem).toEqual([{ memberId, pressedAt: expect.any(String) }]);
      const pressedAt = Date.parse(notAProblem[0]?.pressedAt ?? "");
      expect(pressedAt).toBeGreaterThanOrEqual(before);
      expect(pressedAt).toBeLessThanOrEqual(Date.now());

      // A second press by the same Member records nothing.
      expect(await (await press(first?.id ?? "")).json()).toEqual({ notAProblem });

      const [after] = await list();
      expect(after?.parts.map((part) => part.notAProblem)).toEqual([notAProblem, []]);
      expect(after?.parts[1]?.id).toBe(second?.id);
      expect(after?.state).toBe(merged?.state);
      const calls = await test.database.$client.execute("SELECT count(*) AS n FROM ai_calls");
      expect(calls.rows[0]?.n).toBe(0);
    });

    it("answers 404 to an ID no Alert has, and changes nothing", async () => {
      const res = await press("no-such-alert");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No Alert has this ID." });
      expect(await pressCount()).toBe(0);
    });

    it("answers 401 with no session, 403 from another origin or none, and 415 to a body that is not JSON, and changes nothing", async () => {
      const [merged] = await list();
      const id = merged?.id ?? "";
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
      expect((await signedOut.send("POST", `/api/alerts/${id}/not-a-problem`, {})).status).toBe(
        401,
      );
      for (const origin of WRONG_ORIGINS) {
        expect((await press(id, { origin })).status, `${origin}`).toBe(403);
      }
      expect((await press(id, { "content-type": "text/plain" })).status).toBe(415);
      expect(await pressCount()).toBe(0);
      expect(
        (await list()).flatMap((alert) => alert.parts.flatMap((part) => part.notAProblem)),
      ).toEqual([]);
    });
  });

  describe('"Ask the AI"', () => {
    const list = async () =>
      ((await (await browser.get("/api/alerts")).json()) as { alerts: AlertView[] }).alerts;
    // Every table but the sessions, which each request renews.
    const everyTable = async () => {
      const { sessions: _renewed, ...tables } = await readEveryTable(test.database);
      return tables;
    };

    it("with no AI provider, says why in Chat's words and starts nothing", async () => {
      const [merged] = await list();
      const before = await everyTable();

      const res = await browser.send("POST", `/api/alerts/${merged?.id}/ask-ai`, {});

      expect([res.status, await res.json()]).toEqual([
        409,
        { error: "Set up an AI provider in Settings, AI, to use Chat.", pause: "no AI provider" },
      ]);
      expect(await everyTable()).toEqual(before);
    });

    it("answers 401 with no session, 403 from another origin or none, and 415 to a body that is not JSON, and changes nothing", async () => {
      const [merged] = await list();
      const path = `/api/alerts/${merged?.id}/ask-ai`;
      const before = await everyTable();
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

      expect((await signedOut.send("POST", path, {})).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await browser.send("POST", path, {}, { origin })).status, `${origin}`).toBe(403);
      }
      expect((await browser.send("POST", path, {}, { "content-type": "text/plain" })).status).toBe(
        415,
      );
      expect(await everyTable()).toEqual(before);
    });

    it("loses its link to the Alert when Delete history deletes the Alert, and keeps the thread", async () => {
      const [merged, found] = await list();
      const note = { kind: "Alert", title: "2 Duplicate charges", lines: [], pieces: [] };
      const thread = { title: "About: 2 Duplicate charges", note };
      const asked = await storeAlertThread(
        test.database,
        thread,
        { alertId: merged?.id ?? "", memberId },
        now,
      );
      await storeAlertThread(test.database, thread, { alertId: found?.id ?? "", memberId }, now);
      const rows = async (table: string) =>
        (await test.database.$client.execute(`SELECT * FROM ${table}`)).rows.length;
      expect([await rows("chat_alert_threads"), await rows("chat_threads")]).toEqual([2, 2]);

      expect(await markConnectionRemoved(test.database, connectionId, now)).toMatchObject({
        removed: true,
      });
      expect(await deleteRemovedConnection(test.database, connectionId, now)).toBeDefined();

      expect(await list()).toEqual([]);
      expect([await rows("chat_alert_threads"), await rows("chat_threads")]).toEqual([0, 2]);
      const kept = await test.database.$client.execute({
        sql: "SELECT title FROM chat_threads WHERE id = ?",
        args: [asked.threadId],
      });
      expect(kept.rows[0]?.title).toBe("About: 2 Duplicate charges");
    });
  });

  describe("Settings, Alerts", () => {
    const setCap = (body: unknown, headers: Record<string, string | undefined> = {}) =>
      browser.send("PUT", "/api/alert-settings/weekly-cap", body, headers);
    const cap = async () =>
      ((await (await browser.get("/api/alert-settings")).json()) as AlertSettingsView).weeklyCap;

    it("shows the weekly cap, 3 until a Member changes it to any whole number from 0", async () => {
      expect(await cap()).toBe(3);

      const res = await setCap({ weeklyCap: 0 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ weeklyCap: 0 });
      expect(await cap()).toBe(0);
      expect(await weeklyCap(test.database)).toBe(0);

      expect((await setCap({ weeklyCap: 12 })).status).toBe(200);
      expect(await cap()).toBe(12);
    });

    it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad cap, and changes nothing", async () => {
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
      expect(
        (await signedOut.send("PUT", "/api/alert-settings/weekly-cap", { weeklyCap: 0 })).status,
      ).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await setCap({ weeklyCap: 0 }, { origin })).status, `${origin}`).toBe(403);
      }
      expect((await setCap({ weeklyCap: 0 }, { "content-type": "text/plain" })).status).toBe(415);
      for (const body of [
        {},
        { weeklyCap: -1 },
        { weeklyCap: 1.5 },
        { weeklyCap: "2" },
        { weeklyCap: null },
        { weeklyCap: 2 ** 53 },
        { weeklyCap: 2, extra: 1 },
        null,
      ]) {
        expect((await setCap(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await weeklyCap(test.database)).toBe(3);
      expect(await cap()).toBe(3);
    });
  });
});
