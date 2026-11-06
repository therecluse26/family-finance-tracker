import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  removeMember,
  storeHouseholdFacts,
  storeWeeklySummarySwitch,
  takeWeeklySummaries,
} from "../db/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import { createScheduler } from "../jobs/scheduler.ts";
import { smtpSettings, startNotify } from "../notify/index.ts";
import { StubSmtp, smtpError } from "../notify/testing.ts";
import {
  SUNDAY_MORNING,
  sendWeeklySummaries,
  startWeeklySummary,
  summaryWeek,
  WEEKLY_SUMMARY_STOPPED,
  WEEKLY_SUMMARY_TRIES_CAP,
  WeeklySummaryJob,
} from "./index.ts";

// The weekly summary email's job (spec 06, Weekly summary email), with a stubbed SMTP server: no
// test reaches a mail server. Members use example.test addresses. The Household is in New York,
// where Sunday, Nov 8, 2026 at 8:00 AM is 13:00 UTC.

const APP_URL = "http://nas.local:8080";
const NEW_YORK = "America/New_York";
const SUNDAY_8_AM = new Date("2026-11-08T13:00:00.000Z");

describe("the week and its schedule", () => {
  it("covers the 7 days from Sunday to Saturday that end the night before, all week long", () => {
    const week = {
      from: "2026-11-01",
      to: "2026-11-07",
      nextFrom: "2026-11-08",
      nextTo: "2026-11-14",
    };
    expect(summaryWeek(SUNDAY_8_AM, NEW_YORK)).toEqual(week);
    // Later that Sunday, and a late start on Tuesday or Saturday night, get the same week.
    expect(summaryWeek(new Date("2026-11-08T23:00:00.000Z"), NEW_YORK)).toEqual(week);
    expect(summaryWeek(new Date("2026-11-10T15:00:00.000Z"), NEW_YORK)).toEqual(week);
    expect(summaryWeek(new Date("2026-11-15T04:59:00.000Z"), NEW_YORK)).toEqual(week);
    // Before 8:00 AM on the next Sunday, still the same week; at 8:00 AM, the next one.
    expect(summaryWeek(new Date("2026-11-15T12:59:00.000Z"), NEW_YORK)).toEqual(week);
    expect(summaryWeek(new Date("2026-11-15T13:00:00.000Z"), NEW_YORK)).toMatchObject({
      from: "2026-11-08",
      to: "2026-11-14",
    });
    // Saturday night in New York is already Sunday in UTC: the Household's clock decides.
    expect(summaryWeek(new Date("2026-11-08T03:00:00.000Z"), NEW_YORK)).toMatchObject({
      from: "2026-10-25",
      to: "2026-10-31",
    });
  });

  it("runs on Sunday at 8:00 AM, Household time, across a clock change", () => {
    // Wednesday, Oct 28: the next Sunday is Nov 1, the day the clocks go back, so 8:00 AM is EST.
    expect(SUNDAY_MORNING.next(new Date("2026-10-28T12:00:00.000Z"), NEW_YORK)).toEqual(
      new Date("2026-11-01T13:00:00.000Z"),
    );
    expect(SUNDAY_MORNING.next(SUNDAY_8_AM, NEW_YORK)).toEqual(
      new Date("2026-11-15T13:00:00.000Z"),
    );
    expect(SUNDAY_MORNING.next(new Date("2026-11-08T12:59:00.000Z"), NEW_YORK)).toEqual(
      SUNDAY_8_AM,
    );
    expect(SUNDAY_MORNING.next(new Date("2026-11-08T07:00:00.000Z"), "UTC")).toEqual(
      new Date("2026-11-08T08:00:00.000Z"),
    );
  });

  it("starts only from its schedule: the scheduler starts it at Sunday 8:00 AM and at the next start after a missed one", async () => {
    const task = scheduledTasks.find((each) => each.name === "weekly summary");
    expect(task).toMatchObject({ schedule: SUNDAY_MORNING, job: WeeklySummaryJob });
    const test = await newTestAuth(APP_URL);
    try {
      let now = new Date("2026-11-07T15:00:00.000Z");
      const started: string[] = [];
      const scheduler = createScheduler({
        database: test.database,
        tasks: task === undefined ? [] : [task],
        timeZone: async () => NEW_YORK,
        now: () => now,
        startTask: async (each) => {
          started.push(each.name);
        },
      });
      await scheduler.tick();
      now = new Date("2026-11-08T12:59:00.000Z");
      await scheduler.tick();
      expect(started).toEqual([]);
      now = SUNDAY_8_AM;
      await scheduler.tick();
      await scheduler.tick();
      expect(started).toEqual(["weekly summary"]);
      // The app is off from Sunday, Nov 15 to Tuesday, Nov 24: it runs once, at the next start.
      now = new Date("2026-11-24T15:00:00.000Z");
      await scheduler.tick();
      await scheduler.tick();
      expect(started).toEqual(["weekly summary", "weekly summary"]);
    } finally {
      test.close();
    }
  });
});

describe("the weekly summary job", () => {
  let test: TestAuth;
  let stub: StubSmtp;
  let stops: (() => void)[];
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let carol: TestMember;
  let now: Date;
  // A password made when the test runs.
  let password: string;

  const address = (path: string) => `${APP_URL}${path}`;
  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;
  const sends = () =>
    query(
      "SELECT member_id AS memberId, week_start AS weekStart, state, tries FROM weekly_summary_sends ORDER BY week_start, rowid",
    );
  const stoppedNotices = () =>
    query(
      `SELECT closed_at IS NOT NULL AS closed FROM system_notices WHERE condition = '${WEEKLY_SUMMARY_STOPPED}'`,
    );
  const saveSmtp = async () => {
    const saved = await smtpSettings({
      database: test.database,
      secrets: test.secrets,
      address,
      makeTransport: stub.makeTransport,
    }).save({
      host: "smtp.example.test",
      port: 587,
      username: "household@example.test",
      password,
      sender: "alerts@example.test",
    });
    expect(saved.saved).toBe(true);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lines = [];
    password = `pw-${crypto.randomUUID()}`;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    test = await newTestAuth(APP_URL);
    stub = new StubSmtp();
    now = SUNDAY_8_AM;
    stops = [
      startNotify({
        database: test.database,
        delivery: {
          secrets: test.secrets,
          address,
          startJob: async () => {},
          makeTransport: stub.makeTransport,
        },
      }).stop,
      startWeeklySummary({ database: test.database, now: () => now }).stop,
    ];
    await storeHouseholdFacts(test.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: NEW_YORK,
      ages: [41],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    // Members join a second apart, in this order.
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const join = async (name: string) => {
      vi.setSystemTime(Date.now() + 1000);
      return addMember(test.auth, { name, email: `${name.toLowerCase()}@example.test` });
    };
    alice = await join("Alice");
    bob = await join("Bob");
    carol = await join("Carol");
    vi.setSystemTime(SUNDAY_8_AM);
  });

  afterEach(() => {
    for (const stop of stops) stop();
    test.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends the week's summary to each Member who turned it on, to their own address alone, and logs no address", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    await storeWeeklySummarySwitch(test.database, carol.id, true);
    // Bob turned it on, then off again.
    await storeWeeklySummarySwitch(test.database, bob.id, true);
    await storeWeeklySummarySwitch(test.database, bob.id, false);

    const run = await sendWeeklySummaries();
    expect(run).toMatchObject({ sent: 2, failed: 0, gaveUp: 0 });
    expect(stub.emails.map((email) => email.bcc)).toEqual([
      ["alice@example.test"],
      ["carol@example.test"],
    ]);
    for (const email of stub.emails) {
      // Each Member is a Bcc recipient: no header names another Member.
      expect(email.to).toEqual(["alerts@example.test"]);
      expect(email.raw).not.toMatch(/alice@|bob@|carol@/);
      expect(email.subject).toBe("Weekly summary: Nov 1 to Nov 7");
      expect(email.text).toContain("Your weekly summary for Sunday, Nov 1 to Saturday, Nov 7.");
      expect(email.text).toContain(
        `${APP_URL}/transactions?type=Spending&from=2026-11-01&to=2026-11-07`,
      );
      expect(email.text).toContain(
        `Turn this email off in Settings, Alerts: ${APP_URL}/settings/alerts`,
      );
    }
    // Every Member who gets it gets the same text.
    expect(new Set(stub.emails.map((email) => email.text)).size).toBe(1);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
      { memberId: carol.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
    ]);
    const log = lines.join("");
    expect(log).toContain("Sent the weekly summary");
    expect(log).not.toMatch(/@example\.test|Your weekly summary/);
  });

  it("sends nothing to a Member who never turned it on: it is off for a new Member", async () => {
    await saveSmtp();
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "no Member" });
    expect(stub.emails).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("sends at most one summary per Member per week: again, at once, and after a stop during a send", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    await storeWeeklySummarySwitch(test.database, bob.id, true);

    // Two runs at once send one email to each Member.
    const runs = await Promise.all([sendWeeklySummaries(), sendWeeklySummaries()]);
    expect(runs.map((run) => run.sent).sort()).toEqual([0, 2]);
    expect(stub.emails.map((email) => email.bcc[0])).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);
    // A run later that week, as after a restart, sends nothing more.
    now = new Date("2026-11-10T15:00:00.000Z");
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "all taken" });
    expect(stub.emails).toHaveLength(2);

    // A stop during a send leaves Carol's week taken: no run sends it again.
    await storeWeeklySummarySwitch(test.database, carol.id, true);
    expect(await takeWeeklySummaries(test.database, [carol.id], "2026-11-01", now)).toEqual([
      carol.id,
    ]);
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "all taken" });
    expect(stub.emails).toHaveLength(2);

    // The next week, each Member gets one again.
    now = new Date("2026-11-15T13:00:00.000Z");
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 3 });
    expect(stub.emails.slice(2).map((email) => email.subject)).toEqual([
      "Weekly summary: Nov 8 to Nov 14",
      "Weekly summary: Nov 8 to Nov 14",
      "Weekly summary: Nov 8 to Nov 14",
    ]);
  });

  it("sends nothing, and records nothing, with no SMTP server or a password it cannot read", async () => {
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "not set up" });
    expect(await sends()).toEqual([]);

    await saveSmtp();
    await test.database.$client.execute("UPDATE smtp_settings SET password = 'unreadable'");
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "password unreadable" });
    expect(await sends()).toEqual([]);
    expect(stub.emails).toEqual([]);
    expect(lines.join("")).toContain("Skipped the weekly summary");
  });

  it("stops after its cap when every send fails, with one System notice, and the next summary that sends ends it", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    await storeWeeklySummarySwitch(test.database, bob.id, true);
    // The server's reply quotes an address, which must reach no log line.
    stub.failWith = smtpError("EENVELOPE", 550, "550 No such user: alice@example.test");

    for (let attempt = 1; attempt < WEEKLY_SUMMARY_TRIES_CAP; attempt += 1) {
      await expect(sendWeeklySummaries()).rejects.toThrow(
        "Some weekly summary emails did not send. The job tries again.",
      );
      expect((await sends()).map((row) => [row.state, row.tries])).toEqual([
        ["failed", attempt],
        ["failed", attempt],
      ]);
      expect(await stoppedNotices()).toEqual([]);
    }
    // The last try gives up, raises one notice, and ends the job.
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, failed: 0, gaveUp: 2 });
    expect((await sends()).map((row) => [row.state, row.tries])).toEqual([
      ["gave up", WEEKLY_SUMMARY_TRIES_CAP],
      ["gave up", WEEKLY_SUMMARY_TRIES_CAP],
    ]);
    expect(await stoppedNotices()).toEqual([{ closed: 0 }]);
    // A run after the give-up takes nothing and sends nothing, so it stops for good.
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, skipped: "all taken" });
    expect(await stoppedNotices()).toEqual([{ closed: 0 }]);
    expect(stub.emails).toEqual([]);
    const log = lines.join("");
    expect(log).toContain("A weekly summary email did not send");
    expect(log).toContain('"errorCode":"EENVELOPE"');
    expect(log).not.toMatch(/@example\.test|No such user/);

    // The next week's summary sends, and ends the notice.
    stub.failWith = undefined;
    now = new Date("2026-11-15T13:00:00.000Z");
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 2 });
    expect(await stoppedNotices()).toEqual([{ closed: 1 }]);
  });

  it("counts a try for each Member when the summary does not build, and stops at the same cap", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    // The Review list count cannot be read, so every build throws.
    await test.database.$client.execute("ALTER TABLE review_items RENAME TO review_items_gone");

    for (let attempt = 1; attempt < WEEKLY_SUMMARY_TRIES_CAP; attempt += 1) {
      await expect(sendWeeklySummaries()).rejects.toThrow(
        "Some weekly summary emails did not send.",
      );
    }
    expect(await sendWeeklySummaries()).toMatchObject({ gaveUp: 1 });
    expect(await sendWeeklySummaries()).toMatchObject({ skipped: "all taken" });
    expect(await sends()).toEqual([
      {
        memberId: alice.id,
        weekStart: "2026-11-01",
        state: "gave up",
        tries: WEEKLY_SUMMARY_TRIES_CAP,
      },
    ]);
    expect(await stoppedNotices()).toEqual([{ closed: 0 }]);
    expect(stub.emails).toEqual([]);
    expect(lines.join("")).toContain('"errorName":"Error"');
    await test.database.$client.execute("ALTER TABLE review_items_gone RENAME TO review_items");
  });

  it("takes a failed week again on the next run, and sends it once", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
    await expect(sendWeeklySummaries()).rejects.toThrow();
    stub.failWith = undefined;
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 1 });
    expect(await sendWeeklySummaries()).toMatchObject({ skipped: "all taken" });
    expect(stub.emails).toHaveLength(1);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 1 },
    ]);
  });

  it("deletes a removed Member's switch and sends with them, and sends the rest as before", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    await storeWeeklySummarySwitch(test.database, bob.id, true);
    await sendWeeklySummaries();
    expect(await sends()).toHaveLength(2);

    expect(await removeMember(test.database, bob.id, now)).toBe("removed");
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
    ]);
    expect(await query(`SELECT * FROM alert_channels WHERE member_id = '${bob.id}'`)).toEqual([]);
    now = new Date("2026-11-15T13:00:00.000Z");
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 1 });
    expect(stub.emails.at(-1)?.bcc).toEqual(["alice@example.test"]);
  });
});
