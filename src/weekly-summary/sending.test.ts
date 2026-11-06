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
  WEEKLY_SUMMARY_RETRY_DELAYS_MS,
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
  // Each retry a run started: its week, and when it runs.
  let retries: { weekStart: string; at: Date }[];
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
    retries = [];
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
      startWeeklySummary({
        database: test.database,
        now: () => now,
        startRetry: async (weekStart, at) => {
          retries.push({ weekStart, at });
        },
      }).stop,
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

  // Runs the latest retry a run started, at its time, as Sidequest would.
  const runRetry = () => {
    const retry = retries.at(-1);
    if (retry === undefined) throw new Error("No retry was started.");
    now = retry.at;
    return sendWeeklySummaries(retry.weekStart);
  };
  const minutesAfter = (start: Date, minutes: number) =>
    new Date(start.getTime() + minutes * 60_000);

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

    // The first try, then a retry 5 minutes later, then one 30 minutes after that.
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 0, failed: 2, gaveUp: 0 });
    for (let attempt = 1; attempt < WEEKLY_SUMMARY_TRIES_CAP; attempt += 1) {
      expect((await sends()).map((row) => [row.state, row.tries])).toEqual([
        ["failed", attempt],
        ["failed", attempt],
      ]);
      expect(await stoppedNotices()).toEqual([]);
      expect(retries).toHaveLength(attempt);
      expect(retries.at(-1)).toEqual({
        weekStart: "2026-11-01",
        at: new Date(now.getTime() + (WEEKLY_SUMMARY_RETRY_DELAYS_MS[attempt - 1] ?? 0)),
      });
      if (attempt < WEEKLY_SUMMARY_TRIES_CAP - 1) {
        expect(await runRetry()).toMatchObject({ sent: 0, failed: 2, gaveUp: 0 });
      }
    }
    expect(retries.map((retry) => retry.at)).toEqual([
      minutesAfter(SUNDAY_8_AM, 5),
      minutesAfter(SUNDAY_8_AM, 35),
    ]);
    // The last try gives up, raises one notice, and starts no retry.
    expect(await runRetry()).toMatchObject({ sent: 0, failed: 0, gaveUp: 2 });
    expect(retries).toHaveLength(WEEKLY_SUMMARY_TRIES_CAP - 1);
    expect((await sends()).map((row) => [row.state, row.tries])).toEqual([
      ["gave up", WEEKLY_SUMMARY_TRIES_CAP],
      ["gave up", WEEKLY_SUMMARY_TRIES_CAP],
    ]);
    expect(await stoppedNotices()).toEqual([{ closed: 0 }]);
    // A run after the give-up takes nothing and sends nothing, so it stops for good.
    expect(await sendWeeklySummaries("2026-11-01")).toMatchObject({
      sent: 0,
      skipped: "all taken",
    });
    expect(retries).toHaveLength(WEEKLY_SUMMARY_TRIES_CAP - 1);
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

    expect(await sendWeeklySummaries()).toMatchObject({ failed: 1 });
    for (let attempt = 2; attempt < WEEKLY_SUMMARY_TRIES_CAP; attempt += 1) {
      expect(await runRetry()).toMatchObject({ failed: 1 });
    }
    expect(await runRetry()).toMatchObject({ gaveUp: 1 });
    expect(retries).toHaveLength(WEEKLY_SUMMARY_TRIES_CAP - 1);
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
    expect(await sendWeeklySummaries()).toMatchObject({
      failed: 1,
      retryAt: minutesAfter(SUNDAY_8_AM, 5),
    });
    // The SMTP server is back 5 minutes later.
    stub.failWith = undefined;
    expect(await runRetry()).toMatchObject({ sent: 1 });
    expect(await sendWeeklySummaries()).toMatchObject({ skipped: "all taken" });
    expect(stub.emails).toHaveLength(1);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 1 },
    ]);
    expect(retries).toHaveLength(1);
  });

  it("sends a retry only while its week is the current one", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
    // The app was off for most of the week: its start at 7:58 AM on the next Sunday sends that
    // week's summary, and the send fails.
    now = new Date("2026-11-15T12:58:00.000Z");
    expect(await sendWeeklySummaries()).toMatchObject({ failed: 1 });
    stub.failWith = undefined;
    // The retry comes at 8:03 AM, after the next week's summary time: it sends nothing.
    expect(await runRetry()).toMatchObject({ sent: 0, skipped: "week over" });
    expect(stub.emails).toEqual([]);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "failed", tries: 1 },
    ]);
  });

  it("marks only the Member whose send worked as sent, and retries only the Member whose send failed", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    await storeWeeklySummarySwitch(test.database, bob.id, true);
    stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
    stub.failRecipients = new Set(["bob@example.test"]);

    expect(await sendWeeklySummaries()).toMatchObject({ sent: 1, failed: 1, gaveUp: 0 });
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
      { memberId: bob.id, weekStart: "2026-11-01", state: "failed", tries: 1 },
    ]);
    stub.failWith = undefined;
    expect(await runRetry()).toMatchObject({ sent: 1, failed: 0 });
    expect(stub.emails.map((email) => email.bcc[0])).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
      { memberId: bob.id, weekStart: "2026-11-01", state: "sent", tries: 1 },
    ]);
  });

  it("leaves a week taken by a stopped send as it is when another Member's send works or fails", async () => {
    await saveSmtp();
    // A stop during Carol's send this week, and during Alice's last week.
    await storeWeeklySummarySwitch(test.database, carol.id, true);
    expect(await takeWeeklySummaries(test.database, [carol.id], "2026-11-01", now)).toEqual([
      carol.id,
    ]);
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    expect(await takeWeeklySummaries(test.database, [alice.id], "2026-10-25", now)).toEqual([
      alice.id,
    ]);
    await storeWeeklySummarySwitch(test.database, bob.id, true);

    // Alice's send fails, and Bob's works.
    stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
    stub.failRecipients = new Set(["alice@example.test"]);
    expect(await sendWeeklySummaries()).toMatchObject({ sent: 1, failed: 1 });
    stub.failWith = undefined;
    expect(await runRetry()).toMatchObject({ sent: 1, failed: 0 });
    expect(await sendWeeklySummaries()).toMatchObject({ skipped: "all taken" });

    // Carol gets no copy, and neither stopped week changes.
    expect(stub.emails.map((email) => email.bcc[0])).toEqual([
      "bob@example.test",
      "alice@example.test",
    ]);
    expect(await sends()).toEqual([
      { memberId: alice.id, weekStart: "2026-10-25", state: "sending", tries: 0 },
      { memberId: carol.id, weekStart: "2026-11-01", state: "sending", tries: 0 },
      { memberId: alice.id, weekStart: "2026-11-01", state: "sent", tries: 1 },
      { memberId: bob.id, weekStart: "2026-11-01", state: "sent", tries: 0 },
    ]);
  });

  it("takes a Member who turns it on during a retry for that week", async () => {
    await saveSmtp();
    await storeWeeklySummarySwitch(test.database, alice.id, true);
    stub.failWith = smtpError("ECONNECTION", 0, "connect ECONNREFUSED");
    expect(await sendWeeklySummaries()).toMatchObject({ failed: 1 });
    stub.failWith = undefined;
    await storeWeeklySummarySwitch(test.database, bob.id, true);
    expect(await runRetry()).toMatchObject({ sent: 2 });
    expect(stub.emails.map((email) => [email.bcc[0], email.subject])).toEqual([
      ["alice@example.test", "Weekly summary: Nov 1 to Nov 7"],
      ["bob@example.test", "Weekly summary: Nov 1 to Nov 7"],
    ]);
  });

  it("refuses a job argument that is not a week's first date", async () => {
    await expect(new WeeklySummaryJob().run(7)).rejects.toThrow(
      "WeeklySummaryJob takes a week's first date, or nothing.",
    );
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
