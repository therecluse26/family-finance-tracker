import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideAlerts, setWeeklyCap } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { type AlertKind, storeAlerts, storeHouseholdFacts } from "../db/index.ts";
import {
  channelSettings,
  deliverWaiting,
  EMAIL_STOPPED,
  EMAIL_TRIES_CAP,
  endCondition,
  raiseNotice,
  SMTP_PASSWORD_UNREADABLE,
  smtpSettings,
  startNotify,
} from "./index.ts";
import { StubSmtp, smtpError } from "./testing.ts";

// The Delivery job (spec 06, Recipients and channels; Quiet hours; System notices), through the
// notify module's interface, with a stubbed SMTP server. Alerts are decided as the Alerts step
// decides them. Members use example.test addresses.

const APP_URL = "http://nas.local:8080";

describe("the Delivery job", () => {
  let test: TestAuth;
  let stub: StubSmtp;
  let stopNotify: () => void;
  let asked: number;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let carol: TestMember;
  let dave: TestMember;
  // A password made when the test runs.
  let password: string;
  let made = 0;

  const address = (path: string) => `${APP_URL}${path}`;
  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;
  const channels = () => channelSettings(test.database);
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
  // Stores a new Alert and decides it, as the checks and the Alerts step do.
  const sendAlert = async (kind: AlertKind, text: string, advice: string | null = null) => {
    made += 1;
    const id = `alert-${made}`;
    await storeAlerts(test.database, [
      {
        id,
        kind,
        createdAt: new Date(),
        facts: { kind },
        text,
        category: null,
        state: null,
        transactionIds: [],
      },
    ]);
    if (advice !== null) {
      await test.database.$client.execute({
        sql: "UPDATE alerts SET advice = ? WHERE id = ?",
        args: [advice, id],
      });
    }
    return decideAlerts(test.database);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    asked = 0;
    lines = [];
    password = `pw-${crypto.randomUUID()}`;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    test = await newTestAuth(APP_URL);
    stub = new StubSmtp();
    stopNotify = startNotify({
      database: test.database,
      delivery: {
        secrets: test.secrets,
        address,
        startJob: async () => {
          asked += 1;
        },
        makeTransport: stub.makeTransport,
      },
    }).stop;
    // Members join a second apart, in this order.
    const join = async (name: string) => {
      vi.setSystemTime(Date.now() + 1000);
      return addMember(test.auth, { name, email: `${name.toLowerCase()}@example.test` });
    };
    alice = await join("Alice");
    bob = await join("Bob");
    carol = await join("Carol");
    dave = await join("Dave");
  });

  afterEach(() => {
    stopNotify();
    test.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emails a sent Alert at once, even in quiet hours, to each Member who chose email, with its text, the AI's advice, and a link to the Alert list", async () => {
    await storeHouseholdFacts(test.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    // 11:30 PM in New York: push would wait until 8 AM, email does not.
    vi.setSystemTime(new Date("2026-11-04T04:30:00.000Z"));
    await saveSmtp();
    // Alice keeps both, as every new Member starts. Bob picks push, Carol none, Dave email.
    await channels().set(bob.id, { push: true, email: false });
    await channels().set(carol.id, { push: false, email: false });
    await channels().set(dave.id, { push: false, email: true });

    const { sentIds } = await sendAlert(
      "Over Budget",
      "Restaurants is over Budget for Nov 2026: $620 of $500.",
      "Cook at home twice this week.",
    );
    expect(sentIds).toEqual(["alert-1"]);
    await deliverWaiting();

    // Each Member who chose email is a Bcc recipient. The email is to the sender address, so no
    // header names a Member.
    expect(stub.emails).toEqual([
      {
        from: "alerts@example.test",
        to: ["alerts@example.test"],
        bcc: ["alice@example.test", "dave@example.test"],
        envelope: ["alerts@example.test", "alice@example.test", "dave@example.test"],
        subject: "Over Budget",
        text: [
          "Restaurants is over Budget for Nov 2026: $620 of $500.",
          "Cook at home twice this week.",
          "See it in the Alert list: http://nas.local:8080/alert-list",
        ].join("\n\n"),
        raw: expect.stringContaining("From: Family Finance Tracker <alerts@example.test>"),
      },
    ]);
    const raw = stub.emails[0]?.raw ?? "";
    expect(raw).toContain("To: Family Finance Tracker <alerts@example.test>");
    expect(raw).not.toMatch(/^bcc:/im);
    expect(raw).not.toContain("alice@example.test");
    expect(raw).not.toContain("dave@example.test");
    // The transport was made for the saved server, with the decrypted password.
    expect(stub.servers).toEqual([
      {
        host: "smtp.example.test",
        port: 587,
        username: "household@example.test",
        password,
        sender: "alerts@example.test",
      },
    ]);
    // An Alert with no advice has the template only.
    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();
    expect(stub.emails[1]?.text).toBe(
      "Two charges of $12.99 at Streamflix on Nov 3.\n\nSee it in the Alert list: http://nas.local:8080/alert-list",
    );
    expect(lines.join("")).not.toContain(password);
  });

  it("sends each message once: running the job twice sends no second email", async () => {
    await saveSmtp();
    const before = asked;
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    expect(asked).toBe(before + 1);

    await deliverWaiting();
    await deliverWaiting();
    expect(stub.emails.map((email) => [email.subject, email.text])).toEqual([
      ["System notice", "Your history is ready\n\nOpen the app: http://nas.local:8080/"],
    ]);

    // A later message sends only itself.
    await sendAlert("Large purchase", "Large purchase: $1,240.00 at Best Buy on Nov 3.");
    await deliverWaiting();
    await deliverWaiting();
    expect(stub.emails.map((email) => email.subject)).toEqual(["System notice", "Large purchase"]);
    expect(stub.emails[0]?.bcc).toEqual([
      "alice@example.test",
      "bob@example.test",
      "carol@example.test",
      "dave@example.test",
    ]);
  });

  it("sends System notices by each Member's channels, outside the weekly cap", async () => {
    await saveSmtp();
    await setWeeklyCap(test.database, 0);
    await channels().set(alice.id, { push: true, email: false });

    // With a cap of 0, a Large purchase is held back and sends nothing.
    expect((await sendAlert("Large purchase", "Large purchase at Best Buy")).sentIds).toEqual([]);
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await deliverWaiting();

    expect(stub.emails.map((email) => [email.subject, email.bcc])).toEqual([
      ["System notice", ["bob@example.test", "carol@example.test", "dave@example.test"]],
    ]);
  });

  it("skips a condition notice whose condition ended before its email went out", async () => {
    await saveSmtp();
    await raiseNotice({ kind: "condition", text: "Backups are failing", condition: "backup" });
    await endCondition("backup");

    await deliverWaiting();
    expect(stub.emails).toEqual([]);
    expect(await query("SELECT email_done_at IS NOT NULL AS done FROM notice_deliveries")).toEqual([
      { done: 1 },
    ]);

    // An event notice that one Member closed still goes to the others.
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await test.database.$client.execute({
      sql: "UPDATE system_notices SET closed_at = ?, closed_by = ? WHERE condition IS NULL",
      args: [new Date().toISOString(), alice.id],
    });
    await deliverWaiting();
    expect(stub.emails.map((email) => email.text)).toEqual([
      "Your history is ready\n\nOpen the app: http://nas.local:8080/",
    ]);
  });

  it("skips email while no SMTP server is saved, or no Member chose email, and never sends it later", async () => {
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await deliverWaiting();
    expect(stub.servers).toEqual([]);

    await saveSmtp();
    await deliverWaiting();
    expect(stub.emails).toEqual([]);

    for (const member of [alice, bob, carol, dave]) {
      await channels().set(member.id, { push: true, email: false });
    }
    await sendAlert("Over Budget", "Gas is over Budget");
    await deliverWaiting();
    await channels().set(alice.id, { push: true, email: true });
    await deliverWaiting();
    expect(stub.emails).toEqual([]);
  });

  it("tries a failed email again, sends the others once, and at its cap gives up with one System notice that the next sent email ends", async () => {
    await saveSmtp();
    // The server refuses only the notice. Its reply names the sign-in name.
    stub.failSubjects = new Set(["System notice"]);
    stub.failWith = smtpError("EAUTH", 535, "Invalid login: 535 household@example.test");
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await sendAlert("Over Budget", "Gas is over Budget");
    const stopped = async () =>
      (await query(`SELECT id FROM system_notices WHERE condition = '${EMAIL_STOPPED}'`)).length;

    for (let run = 1; run < EMAIL_TRIES_CAP; run += 1) {
      await expect(deliverWaiting()).rejects.toThrow("Some emails did not send.");
    }
    // The Alert went out once, on the first run.
    expect(stub.emails.map((email) => email.subject)).toEqual(["Over Budget"]);
    expect(await stopped()).toBe(0);

    // The run at the cap gives up on the notice, raises one System notice, and ends.
    await expect(deliverWaiting()).resolves.toBeUndefined();
    expect(await stopped()).toBe(1);
    expect(await query("SELECT email_tries FROM notice_deliveries ORDER BY id")).toEqual([
      { email_tries: EMAIL_TRIES_CAP },
      { email_tries: 0 },
    ]);
    const askedAtCap = asked;
    // The new notice's email fails too, and gives up at its own cap with no second notice.
    stub.failSubjects = undefined;
    for (let run = 1; run < EMAIL_TRIES_CAP; run += 1) {
      await expect(deliverWaiting()).rejects.toThrow();
    }
    await expect(deliverWaiting()).resolves.toBeUndefined();
    expect(await stopped()).toBe(1);
    expect(asked).toBe(askedAtCap);

    // The next email that sends ends the notice.
    stub.failWith = undefined;
    await raiseNotice({ kind: "event", text: "Backups are working again" });
    await deliverWaiting();
    expect(
      await query(
        `SELECT closed_at IS NOT NULL AS closed FROM system_notices WHERE condition = '${EMAIL_STOPPED}'`,
      ),
    ).toEqual([{ closed: 1 }]);

    // No log line holds the server's reply, an address, or the password; the code does.
    const logged = lines.join("");
    expect(logged).toContain('"errorCode":"EAUTH"');
    expect(logged).not.toContain("Invalid login");
    expect(logged).not.toContain("example.test");
    expect(logged).not.toContain(password);
  });

  it("raises the System notice when it gives up on one email in a run where another sends", async () => {
    await saveSmtp();
    // The server refuses only System notices, for their content.
    stub.failSubjects = new Set(["System notice"]);
    stub.failWith = smtpError("EMESSAGE", 552, "Message refused");
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    const stopped = async () =>
      await query(
        `SELECT closed_at IS NOT NULL AS closed FROM system_notices WHERE condition = '${EMAIL_STOPPED}'`,
      );

    for (let run = 1; run < EMAIL_TRIES_CAP; run += 1) {
      await expect(deliverWaiting()).rejects.toThrow();
    }
    await sendAlert("Over Budget", "Gas is over Budget");
    // The run at the cap gives up on the notice and sends the Alert.
    await expect(deliverWaiting()).resolves.toBeUndefined();
    expect(stub.emails.map((email) => email.subject)).toEqual(["Over Budget"]);
    expect(await stopped()).toEqual([{ closed: 0 }]);

    // A later run that sends something and gives up on nothing ends it.
    stub.failWith = undefined;
    await deliverWaiting();
    expect(await stopped()).toEqual([{ closed: 1 }]);
  });

  it("raises a System notice while the saved SMTP password cannot be read, and ends it once a Member enters it again", async () => {
    await saveSmtp();
    // As after a restore under another Master key.
    await test.database.$client.execute("UPDATE smtp_settings SET password = 'unreadable'");
    const unreadable = async () =>
      await query(
        `SELECT closed_at IS NOT NULL AS closed FROM system_notices WHERE condition = '${SMTP_PASSWORD_UNREADABLE}'`,
      );

    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await deliverWaiting();
    await deliverWaiting();
    expect(await unreadable()).toEqual([{ closed: 0 }]);
    expect(stub.emails).toEqual([]);
    expect(lines.join("")).toContain("The stored SMTP password cannot be read");

    // Saving the password again asks for a Delivery job, which ends the notice.
    const before = asked;
    await saveSmtp();
    expect(asked).toBe(before + 1);
    await deliverWaiting();
    expect(await unreadable()).toEqual([{ closed: 1 }]);
    await raiseNotice({ kind: "event", text: "Backups are working again" });
    await deliverWaiting();
    expect(stub.emails.map((email) => email.text)).toEqual([
      "Backups are working again\n\nOpen the app: http://nas.local:8080/",
    ]);
  });

  it("deletes a Member's channels with the Member", async () => {
    await channels().set(bob.id, { push: false, email: false });
    await test.database.$client.execute({
      sql: "DELETE FROM members WHERE id = ?",
      args: [bob.id],
    });

    expect(await query("SELECT member_id FROM alert_channels")).toEqual([]);
  });
});
