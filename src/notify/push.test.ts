import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideAlerts } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  type AlertKind,
  markSetupStep,
  storeAlerts,
  storeHouseholdFacts,
  VAPID_KEYS_ROW,
} from "../db/index.ts";
import { countWaitingJobs, startJobs } from "../jobs/index.ts";
import {
  channelSettings,
  deliverWaiting,
  endCondition,
  MAX_PUSH_BODY,
  MorningDeliveryJob,
  PUSH_KEYS_REPLACED,
  PUSH_STOPPED,
  PUSH_TRIES_CAP,
  pushSettings,
  raiseNotice,
  removeMemberDevices,
  requestDelivery,
  requestDeliveryAt,
  startNotify,
} from "./index.ts";
import type { PushSubscriptionFields } from "./push-view.ts";
import { DeliveryJob, newSubscription, StubPushService, TEST_NOTIFY_JOB_LIST } from "./testing.ts";

// Web push in the Delivery job (spec 06, Recipients and channels; Quiet hours; System notices),
// through the notify module's interface, with a stubbed push service and a fake clock. Alerts are
// decided as the Alerts step decides them. The Household is in New York: on 2026-11-04, after the
// clocks changed, 8 AM there is 13:00 UTC and 9 PM is 02:00 UTC the next day.

const APP_URL = "https://money.example.com";
const NOON = new Date("2026-11-04T17:00:00.000Z");
const LATE_EVENING = new Date("2026-11-05T04:30:00.000Z");
const NEXT_8_AM = new Date("2026-11-05T13:00:00.000Z");

describe("web push in the Delivery job", () => {
  let test: TestAuth;
  let push: StubPushService;
  let stopNotify: () => void;
  let lines: string[];
  let morningJobs: Date[];
  let alice: TestMember;
  let bob: TestMember;
  let carol: TestMember;
  let made = 0;

  const query = async (sql: string, args: (string | number)[] = []) =>
    (await test.database.$client.execute({ sql, args })).rows;
  const settings = () =>
    pushSettings({ database: test.database, secrets: test.secrets, available: true });
  const channels = () => channelSettings(test.database);
  // Turns Alerts on for a new device of this Member, a second before what comes next.
  const turnOn = async (member: TestMember): Promise<PushSubscriptionFields> => {
    const subscription = newSubscription();
    expect(await settings().addDevice(member.id, subscription)).toEqual({ added: true });
    vi.setSystemTime(Date.now() + 1000);
    return subscription;
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
      await query("UPDATE alerts SET advice = ? WHERE id = ?", [advice, id]);
    }
    return decideAlerts(test.database);
  };
  const startWith = (options: { push: boolean }) => {
    stopNotify = startNotify({
      database: test.database,
      delivery: {
        secrets: test.secrets,
        address: (path) => `${APP_URL}${path}`,
        startJob: async () => {},
        ...(options.push
          ? {
              push: {
                subject: APP_URL,
                startJobAt: async (at: Date) => {
                  morningJobs.push(at);
                },
                send: push.send,
              },
            }
          : {}),
      },
    }).stop;
  };
  const sentTo = () => push.pushes.map((each) => each.endpoint);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
    lines = [];
    morningJobs = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    test = await newTestAuth(APP_URL);
    push = new StubPushService();
    startWith({ push: true });
    await markSetupStep(test.database, "master key", "done");
    await storeHouseholdFacts(test.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.test" });
    carol = await addMember(test.auth, { name: "Carol", email: "carol@example.test" });
  });

  afterEach(() => {
    stopNotify();
    test.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("pushes a sent Alert to each device of each Member whose channels hold push, with the kind as its title and the template text as its body", async () => {
    const alicePhone = await turnOn(alice);
    const aliceLaptop = await turnOn(alice);
    const bobPhone = await turnOn(bob);
    await turnOn(carol);
    // Alice keeps both channels, as every new Member starts. Bob picks push only, Carol email only.
    await channels().set(bob.id, { push: true, email: false });
    await channels().set(carol.id, { push: false, email: true });

    await sendAlert(
      "Over Budget",
      "Restaurants is over Budget for Nov 2026: $620 of $500.",
      "Cook at home twice this week.",
    );
    await deliverWaiting();

    expect(sentTo()).toEqual([alicePhone.endpoint, aliceLaptop.endpoint, bobPhone.endpoint]);
    const [first] = push.pushes;
    // The push holds the kind and the template text, and never the AI's advice.
    expect(first?.shown).toEqual({
      title: "Over Budget",
      body: "Restaurants is over Budget for Nov 2026: $620 of $500.",
      url: "/alert-list",
      tag: expect.stringMatching(/^push-\d+$/),
    });
    expect(first?.payload).not.toContain("Cook at home");
    // The request web-push builds names the app by APP_URL's origin, signed with the app's key.
    const { publicKey } = (await settings().view()) as { publicKey: string };
    expect(first?.subject).toBe(APP_URL);
    expect(first?.headers.Authorization).toContain(`k=${publicKey}`);
    expect(first?.headers.TTL).toBe(String(24 * 60 * 60));

    // Running the job again pushes nothing twice.
    await deliverWaiting();
    expect(push.pushes).toHaveLength(3);
    expect(await query("SELECT * FROM push_sends")).toEqual([]);
  });

  it("pushes a System notice's text, and sends a device only messages made after it was turned on", async () => {
    await raiseNotice({ kind: "event", text: "Raised before any device" });
    vi.setSystemTime(Date.now() + 1000);
    const phone = await turnOn(alice);
    await raiseNotice({ kind: "event", text: "Your history is ready" });

    await deliverWaiting();

    expect(push.pushes.map((each) => each.shown)).toEqual([
      { title: "System notice", body: "Your history is ready", url: "/", tag: expect.any(String) },
    ]);
    expect(sentTo()).toEqual([phone.endpoint]);
    expect((await query("SELECT push_done_at FROM notice_deliveries")).length).toBe(2);
    expect(await query("SELECT * FROM notice_deliveries WHERE push_done_at IS NULL")).toEqual([]);
  });

  it("holds pushes from 9 PM to 8 AM, Household time, and the 8 AM Delivery job sends them; System notice pushes wait too", async () => {
    const phone = await turnOn(alice);
    const bobPhone = await turnOn(bob);

    // 8:59 PM: the push goes at once.
    vi.setSystemTime(new Date("2026-11-05T01:59:00.000Z"));
    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();
    expect(push.pushes.map((each) => each.shown.title)).toEqual([
      "Duplicate charge",
      "Duplicate charge",
    ]);
    expect(morningJobs).toEqual([]);

    // 9 PM sharp: quiet hours start.
    vi.setSystemTime(new Date("2026-11-05T02:00:00.000Z"));
    await sendAlert("Card interest or fee", "Interest of $14.20 on the card ending 4821.");
    await deliverWaiting();
    vi.setSystemTime(LATE_EVENING);
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await deliverWaiting();
    expect(push.pushes).toHaveLength(2);
    expect(morningJobs).toEqual([NEXT_8_AM, NEXT_8_AM]);
    expect(lines.join("")).toContain("Held push for quiet hours");

    // Bob takes push out of his channels during the night: his held pushes are not sent.
    await channels().set(bob.id, { push: false, email: true });
    // 7:59:59 AM is still quiet.
    vi.setSystemTime(new Date(NEXT_8_AM.getTime() - 1000));
    await deliverWaiting();
    expect(push.pushes).toHaveLength(2);

    vi.setSystemTime(NEXT_8_AM);
    await deliverWaiting();
    expect(push.pushes.slice(2).map((each) => [each.endpoint, each.shown.title])).toEqual([
      [phone.endpoint, "Card interest or fee"],
      [phone.endpoint, "System notice"],
    ]);
    expect(sentTo().filter((endpoint) => endpoint === bobPhone.endpoint)).toHaveLength(1);
    expect(await query("SELECT * FROM push_sends")).toEqual([]);
  });

  it("does not push a condition notice whose condition ended before 8 AM", async () => {
    await turnOn(alice);
    vi.setSystemTime(LATE_EVENING);
    await raiseNotice({
      kind: "condition",
      condition: "backup failed",
      text: "The backup failed.",
    });
    await deliverWaiting();
    await endCondition("backup failed");
    // One that ended before the Delivery job ran is never handed out.
    await raiseNotice({ kind: "condition", condition: "sync broken", text: "A sync broke." });
    await endCondition("sync broken");
    await deliverWaiting();
    expect(await query("SELECT body FROM push_sends")).toEqual([{ body: "The backup failed." }]);

    vi.setSystemTime(NEXT_8_AM);
    await deliverWaiting();

    expect(push.pushes).toEqual([]);
    expect(await query("SELECT * FROM push_sends")).toEqual([]);
  });

  it("hands out no push to a device whose Member's channels leave out push", async () => {
    const phone = await turnOn(alice);
    await turnOn(carol);
    await channels().set(carol.id, { push: false, email: true });
    vi.setSystemTime(LATE_EVENING);

    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();

    const held = await query(
      "SELECT d.endpoint FROM push_sends s JOIN push_devices d ON d.id = s.device_id",
    );
    expect(held.map((row) => row.endpoint)).toEqual([phone.endpoint]);
  });

  it("clips a long body, so the encrypted push stays under 4 KB", async () => {
    await turnOn(alice);
    await sendAlert("Large purchase", "é".repeat(MAX_PUSH_BODY + 50));
    await deliverWaiting();

    const [only] = push.pushes;
    expect(Array.from(only?.shown.body ?? "")).toHaveLength(MAX_PUSH_BODY);
    expect(only?.shown.body.endsWith("…")).toBe(true);
    expect(Number(only?.headers["Content-Length"])).toBeLessThan(4096);
  });

  it("removes a device the push service reports gone, and keeps pushing to the others", async () => {
    const gone = await turnOn(alice);
    const moved = await turnOn(alice);
    const kept = await turnOn(bob);
    push.failWith.set(gone.endpoint, 410);
    push.failWith.set(moved.endpoint, 404);

    await sendAlert("Price increase", "Streamflix went from $12.99 to $15.99.");
    await deliverWaiting();

    expect(sentTo()).toEqual([kept.endpoint]);
    expect((await query("SELECT endpoint FROM push_devices")).map((row) => row.endpoint)).toEqual([
      kept.endpoint,
    ]);
    // The next message goes to the device left, and no log line names an endpoint.
    await sendAlert("New Recurring charge", "A new Recurring charge: Gym Club, $40 a month.");
    await deliverWaiting();
    expect(sentTo()).toEqual([kept.endpoint, kept.endpoint]);
    for (const endpoint of [gone.endpoint, moved.endpoint, kept.endpoint]) {
      expect(lines.join("")).not.toContain(endpoint);
    }
  });

  it("counts a failed push, tries again, and gives up at the cap with one System notice; a later sent push ends it", async () => {
    const phone = await turnOn(alice);
    push.failWith.set(phone.endpoint, 503);
    await sendAlert("On pace", "Groceries is on pace to go over Budget.");

    // A step that always throws stops: each run counts a try, until the cap.
    let throws = 0;
    for (let run = 0; run < PUSH_TRIES_CAP + 3; run += 1) {
      await deliverWaiting().catch(() => {
        throws += 1;
      });
    }
    // The Alert's push gave up at its cap; the "push stopped" notice's own push did too.
    expect(throws).toBe(2 * (PUSH_TRIES_CAP - 1));
    expect(await query("SELECT * FROM push_sends")).toEqual([]);
    const open = await query(
      "SELECT text FROM system_notices WHERE condition = ? AND closed_at IS NULL",
      [PUSH_STOPPED],
    );
    expect(open).toHaveLength(1);
    expect(lines.join("")).not.toContain(phone.endpoint);
    expect(lines.join("")).not.toContain("The push service's reply");

    push.failWith.clear();
    await sendAlert("Large purchase", "A $1,250.00 purchase at Bluebird Books on Nov 4.");
    await deliverWaiting();
    expect(push.pushes.map((each) => each.shown.title)).toEqual(["Large purchase"]);
    expect(
      await query("SELECT * FROM system_notices WHERE condition = ? AND closed_at IS NULL", [
        PUSH_STOPPED,
      ]),
    ).toEqual([]);
  });

  it("skips push in plain-HTTP mode: nothing is pushed, and push is done with every message", async () => {
    await turnOn(alice);
    vi.setSystemTime(LATE_EVENING);
    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();
    expect(await query("SELECT * FROM push_sends")).toHaveLength(1);

    // APP_URL now starts with http://: push is hidden, and email is the only channel.
    stopNotify();
    startWith({ push: false });
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    vi.setSystemTime(NEXT_8_AM);
    await deliverWaiting();

    expect(push.pushes).toEqual([]);
    expect(await query("SELECT * FROM push_sends")).toEqual([]);
    expect(await query("SELECT * FROM alert_deliveries WHERE push_done_at IS NULL")).toEqual([]);
    expect(await query("SELECT * FROM notice_deliveries WHERE push_done_at IS NULL")).toEqual([]);
  });

  it("keeps the VAPID private key out of every push, log line, and stored row", async () => {
    await turnOn(alice);
    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();

    const [row] = await query("SELECT public_key, private_key FROM vapid_keys");
    const privateKey = test.secrets.decrypt(String(row?.private_key), {
      rowId: VAPID_KEYS_ROW,
      column: "vapid_keys.private_key",
    });
    const publicKey = test.secrets.decrypt(String(row?.public_key), {
      rowId: VAPID_KEYS_ROW,
      column: "vapid_keys.public_key",
    });
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(row?.private_key)).not.toContain(privateKey);
    expect(String(row?.public_key)).not.toContain(publicKey);
    expect(push.pushes).toHaveLength(1);
    expect(JSON.stringify(push.pushes)).not.toContain(privateKey);
    expect(lines.join("")).not.toContain(privateKey);
  });

  it("makes new VAPID keys when the stored ones cannot be decrypted, and removes every device", async () => {
    await turnOn(alice);
    await turnOn(bob);
    const before = (await settings().view()) as { publicKey: string };
    const notices = () => query("SELECT kind, text FROM system_notices");
    expect(await notices()).toEqual([]);
    // A ciphertext moved to another column fails to decrypt, as after a restore without the
    // Master key.
    await query("UPDATE vapid_keys SET private_key = public_key");

    const [after] = await Promise.all([settings().view(), settings().view()]);

    expect(after).toEqual({ available: true, publicKey: expect.any(String) });
    expect((after as { publicKey: string }).publicKey).not.toBe(before.publicKey);
    expect(await query("SELECT * FROM push_devices")).toEqual([]);
    expect(lines.join("")).toContain("The stored VAPID keys cannot be read");
    // One System notice tells each Member to turn Alerts on again.
    expect(await notices()).toEqual([{ kind: "event", text: PUSH_KEYS_REPLACED }]);
    expect(PUSH_KEYS_REPLACED).toContain("Turn Alerts on again on each device");
    await settings().view();
    expect(await notices()).toHaveLength(1);
  });

  it("never sends to a stored device whose endpoint the check refuses, and removes it", async () => {
    const kept = await turnOn(alice);
    const good = newSubscription();
    // Rows stored before the check was as strict as now: web-push would send these elsewhere.
    const stored = [
      "https://169.254.169.254;x.push.apple.com/latest/meta-data",
      "https://internal-nas%2ex.push.apple.com/admin",
      "https://evil.test{.fcm.notify.windows.com/x",
    ];
    for (const endpoint of stored) {
      await query(
        "INSERT INTO push_devices (member_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)",
        [bob.id, endpoint, good.keys.p256dh, good.keys.auth, new Date(0).toISOString()],
      );
    }

    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await deliverWaiting();

    expect(sentTo()).toEqual([kept.endpoint]);
    expect((await query("SELECT endpoint FROM push_devices")).map((row) => row.endpoint)).toEqual([
      kept.endpoint,
    ]);
    expect(lines.join("")).toContain(
      "Removed a device whose push service the app does not send to",
    );
    for (const endpoint of stored) expect(lines.join("")).not.toContain(endpoint);
  });

  it("deletes a waiting push with its Alert, its device, or its device's Member", async () => {
    await turnOn(alice);
    await turnOn(bob);
    await turnOn(carol);
    vi.setSystemTime(LATE_EVENING);
    await sendAlert("Duplicate charge", "Two charges of $12.99 at Streamflix on Nov 3.");
    await raiseNotice({ kind: "event", text: "Your history is ready" });
    await deliverWaiting();
    expect(await query("SELECT * FROM push_sends")).toHaveLength(6);

    // Foreign keys are on in app.db: each delete takes the waiting pushes with it.
    await query("DELETE FROM alerts WHERE id = ?", [`alert-${made}`]);
    expect(await query("SELECT * FROM push_sends WHERE alert_id IS NOT NULL")).toEqual([]);
    expect(await removeMemberDevices(test.database, bob.id)).toBe(1);
    await query("DELETE FROM members WHERE id = ?", [carol.id]);
    const left = await query(
      "SELECT d.member_id FROM push_sends s JOIN push_devices d ON d.id = s.device_id",
    );
    expect(left.map((each) => each.member_id)).toEqual([alice.id]);
    expect(
      (await query("SELECT member_id FROM push_devices")).map((each) => each.member_id),
    ).toEqual([alice.id]);
  });

  it("hands out 2,500 waiting Alerts to 2 devices in a few seconds", async () => {
    await turnOn(alice);
    await turnOn(bob);
    vi.setSystemTime(LATE_EVENING);
    const count = 2500;
    await storeAlerts(
      test.database,
      Array.from({ length: count }, (_, index) => ({
        id: `bulk-${index}`,
        kind: "Large purchase" as const,
        createdAt: new Date(),
        facts: {},
        text: `A large purchase, number ${index}.`,
        category: null,
        state: "sent" as const,
        transactionIds: [],
      })),
    );
    await query(
      "INSERT INTO alert_deliveries (alert_id, title, text, created_at) SELECT id, kind, text, created_at FROM alerts",
    );

    const started = performance.now();
    await deliverWaiting();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await query("SELECT count(*) AS n FROM push_sends")).toEqual([{ n: 2 * count }]);
  });
});

describe("the 8 AM Delivery job", () => {
  it("waits as its own job, so a Delivery job still starts at once while it waits", async () => {
    const test = await newTestAuth(APP_URL);
    const dir = mkdtempSync(join(tmpdir(), "fft-morning-delivery-"));
    const notify = startNotify({ database: test.database });
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_NOTIFY_JOB_LIST,
      tasks: [],
      database: test.database,
    });
    try {
      const at = new Date(Date.now() + 60 * 60 * 1000);
      expect(await requestDeliveryAt(at)).toBe(true);
      expect(await requestDeliveryAt(at)).toBe(false);
      expect(await countWaitingJobs(MorningDeliveryJob)).toBe(1);
      expect(await countWaitingJobs(DeliveryJob)).toBe(0);
      expect(await requestDelivery()).toBe(true);
    } finally {
      await jobs.stop();
      notify.stop();
      test.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
