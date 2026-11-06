import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep, storeHouseholdFacts } from "../db/index.ts";
import { smtpSettings, startNotify } from "../notify/index.ts";
import { StubSmtp, smtpError } from "../notify/testing.ts";
import { createApp } from "../server/app.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import { sendWeeklySummaries, startWeeklySummary, type WeeklySummaryView } from "./index.ts";

// Settings → Alerts: each Member's own weekly summary email switch (spec 06, Weekly summary email),
// through the app's HTTP interface. Members use example.test addresses, and the SMTP server is a
// stub: no test reaches a mail server.

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-weekly-summary-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the weekly summary email switch", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubSmtp;
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;
  let password: string;

  const switches = async () =>
    (
      await test.database.$client.execute(
        "SELECT member_id AS memberId, push, email, weekly_summary AS weeklySummary FROM alert_channels ORDER BY rowid",
      )
    ).rows.map((row) => ({ ...row }));
  const viewOf = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/weekly-summary")).json()) as { weeklySummary: WeeklySummaryView })
      .weeklySummary;
  const turn = (tab: TestBrowser, on: boolean) => tab.send("PUT", "/api/weekly-summary", { on });
  const smtp = () =>
    smtpSettings({
      database: test.database,
      secrets: test.secrets,
      address: (path) => `${APP_URL}${path}`,
      makeTransport: stub.makeTransport,
    });

  async function signedIn(member: TestMember): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    return tab;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T15:00:00.000Z"));
    password = `pw-${crypto.randomUUID()}`;
    test = await newTestAuth(APP_URL);
    stub = new StubSmtp();
    const security = await loadSecurity({ APP_URL });
    app = createApp(webRoot, security, test.auth, test.database, test.secrets, { smtp: smtp() });
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.test" });
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  it("is off for a new Member, and turns on and off for the signed-in Member alone", async () => {
    const alicesTab = await signedIn(alice);
    const bobsTab = await signedIn(bob);
    const off = { on: false, emailSetUp: false, last: null };
    expect(await viewOf(alicesTab)).toEqual(off);

    const on = await turn(alicesTab, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ weeklySummary: { ...off, on: true } });
    expect(await viewOf(alicesTab)).toEqual({ ...off, on: true });
    // Bob's stays off, and Alice keeps both channels, as a new Member has them.
    expect(await viewOf(bobsTab)).toEqual(off);
    expect(await switches()).toEqual([{ memberId: alice.id, push: 1, email: 1, weeklySummary: 1 }]);

    // Bob's own channels and switch are his: Alice's change of hers leaves his as they are.
    expect(
      (await bobsTab.send("PUT", "/api/alert-channels", { push: false, email: true })).status,
    ).toBe(200);
    expect((await turn(bobsTab, true)).status).toBe(200);
    expect((await turn(alicesTab, false)).status).toBe(200);
    expect(await switches()).toEqual([
      { memberId: alice.id, push: 1, email: 1, weeklySummary: 0 },
      { memberId: bob.id, push: 0, email: 1, weeklySummary: 1 },
    ]);
    // Saving channels keeps the switch.
    expect(
      (await bobsTab.send("PUT", "/api/alert-channels", { push: true, email: true })).status,
    ).toBe(200);
    expect(await viewOf(bobsTab)).toMatchObject({ on: true });
  });

  it("refuses a body that names a Member or is not one switch, and changes nothing", async () => {
    const tab = await signedIn(alice);
    for (const body of [
      {},
      { on: "yes" },
      { on: true, memberId: bob.id },
      { weeklySummary: true },
    ]) {
      const res = await tab.send("PUT", "/api/weekly-summary", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Turn the weekly summary on or off." });
    }
    expect(await switches()).toEqual([]);
  });

  it("answers 401 with no session, 403 to another site or no Origin, and 415 to a body that is not JSON, and changes nothing", async () => {
    const tab = await signedIn(alice);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.250");
    const body = { on: true };
    expect((await signedOut.send("PUT", "/api/weekly-summary", body)).status).toBe(401);
    expect(
      (await tab.send("PUT", "/api/weekly-summary", body, { origin: "http://evil.example.test" }))
        .status,
    ).toBe(403);
    expect((await tab.send("PUT", "/api/weekly-summary", body, { origin: undefined })).status).toBe(
      403,
    );
    expect(
      (await tab.send("PUT", "/api/weekly-summary", body, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await signedOut.get("/api/weekly-summary")).status).toBe(401);
    expect(await switches()).toEqual([]);
    expect(await viewOf(tab)).toMatchObject({ on: false });
  });

  it("says when the email server is saved, and shows the Member's last summary: sent, or given up", async () => {
    const alicesTab = await signedIn(alice);
    const bobsTab = await signedIn(bob);
    expect((await turn(alicesTab, true)).status).toBe(200);
    expect((await turn(bobsTab, true)).status).toBe(200);
    expect(
      (
        await alicesTab.post("/api/smtp/settings", {
          host: "smtp.example.test",
          port: 587,
          username: "household@example.test",
          password,
          sender: "alerts@example.test",
        })
      ).status,
    ).toBe(200);
    expect(await viewOf(alicesTab)).toEqual({ on: true, emailSetUp: true, last: null });

    await storeHouseholdFacts(test.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    let now = new Date("2026-11-08T13:00:00.000Z");
    const stops = [
      startNotify({
        database: test.database,
        delivery: {
          secrets: test.secrets,
          address: (path) => `${APP_URL}${path}`,
          startJob: async () => {},
          makeTransport: stub.makeTransport,
        },
      }).stop,
      startWeeklySummary({ database: test.database, now: () => now }).stop,
    ];
    try {
      await sendWeeklySummaries();
      const sent = { from: "2026-11-01", to: "2026-11-07", state: "sent", on: "2026-11-08" };
      expect(await viewOf(alicesTab)).toMatchObject({ last: sent });

      // The next week every send fails, up to the cap.
      stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
      now = new Date("2026-11-15T13:00:00.000Z");
      await expect(sendWeeklySummaries()).rejects.toThrow();
      // A failed try with tries left shows the last summary that ended.
      expect(await viewOf(alicesTab)).toMatchObject({ last: sent });
      await expect(sendWeeklySummaries()).rejects.toThrow();
      await sendWeeklySummaries();
      const gaveUp = { from: "2026-11-08", to: "2026-11-14", state: "gave up", on: "2026-11-15" };
      expect(await viewOf(alicesTab)).toMatchObject({ last: gaveUp });
      expect(await viewOf(bobsTab)).toMatchObject({ last: gaveUp });
    } finally {
      for (const stop of stops) stop();
    }
  });
});
