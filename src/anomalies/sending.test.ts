import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  type AlertKind,
  type NewAlert,
  type NewPart,
  storeAlertDecisions,
  storeAlerts,
  storeDecisions,
  storeFirstDraft,
  storeHouseholdFacts,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  ALERT_SENDING_CAP,
  ALERT_SENDING_STOPPED,
  alertList,
  alertsHeldBack,
  checkOverspending,
  DEFAULT_WEEKLY_CAP,
  decideAlerts,
  mergedAlertList,
  setWeeklyCap,
  startAlertSending,
  weeklyCap,
} from "./index.ts";

// The Alerts step (spec 06, Sending Alerts; The weekly cap; Merging; Sent stays sent), through
// the anomalies module's interface. Most tests store new Alerts as the checks store them, at the
// times they would be created, and decide them as the follow-up job's Alerts step does. The
// Household time zone is New York, on Eastern Standard Time (UTC-5) in these weeks.

// A time on a day in New York, such as est("2026-11-02", 9) for 9 AM on Monday, November 2.
const est = (date: string, hour: number) => {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCHours(hour + 5);
  return at;
};

describe("the Alerts step", () => {
  let bank: TestBank;
  let made = 0;

  // A new Alert of `kind`, created at `createdAt`, whose text is `text`.
  const alert = (kind: AlertKind, createdAt: Date, text: string): NewAlert => {
    made += 1;
    return {
      id: `alert-${String(made).padStart(3, "0")}`,
      kind,
      createdAt,
      facts: { kind },
      text,
      category: null,
      state: null,
      transactionIds: [],
    };
  };
  // Stores one batch of new Alerts and runs the Alerts step on it.
  const batch = async (...alerts: NewAlert[]) => {
    await storeAlerts(bank.database, alerts);
    return decideAlerts(bank.database);
  };
  // Each Alert's state, by its text.
  const states = async () =>
    Object.fromEntries((await alertList(bank.database)).map((each) => [each.text, each.state]));

  beforeEach(async () => {
    made = 0;
    bank = await newTestBank();
    await storeHouseholdFacts(bank.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41, 39, 8],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
  });

  afterEach(() => {
    bank.close();
  });

  it("follows the spec's week: 3 sent within the cap, Large purchase and New Recurring charge held, Duplicate charge outside it", async () => {
    expect(await weeklyCap(bank.database)).toBe(DEFAULT_WEEKLY_CAP);
    expect(DEFAULT_WEEKLY_CAP).toBe(3);

    // Monday: an Over Budget Alert is sent (1 of 3).
    expect(await batch(alert("Over Budget", est("2026-11-02", 9), "Monday Over Budget"))).toEqual({
      sent: 1,
      heldBack: 0,
      joined: 0,
      sentIds: ["alert-001"],
    });
    // Tuesday's batch: the Price increase and the On pace are sent (3 of 3). The Large purchase is
    // held, though the checks stored it first.
    const tuesday = est("2026-11-03", 10);
    expect(
      await batch(
        alert("Large purchase", tuesday, "Tuesday Large purchase"),
        alert("Price increase", tuesday, "Tuesday Price increase"),
        alert("On pace", tuesday, "Tuesday On pace"),
      ),
    ).toEqual({ sent: 2, heldBack: 1, joined: 0, sentIds: ["alert-003", "alert-004"] });
    // Thursday: a Duplicate charge is sent, outside the cap.
    await batch(alert("Duplicate charge", est("2026-11-05", 8), "Thursday Duplicate charge"));
    // Friday: a New Recurring charge is held.
    await batch(
      alert("New Recurring charge", est("2026-11-06", 12), "Friday New Recurring charge"),
    );

    expect(await states()).toEqual({
      "Monday Over Budget": "sent",
      "Tuesday Large purchase": "held back (weekly cap)",
      "Tuesday Price increase": "sent",
      "Tuesday On pace": "sent",
      "Thursday Duplicate charge": "sent",
      "Friday New Recurring charge": "held back (weekly cap)",
    });

    // A held Alert is never sent later: the next week's run leaves it held, and the next Monday
    // starts 3 new slots.
    await batch(alert("Large purchase", est("2026-11-09", 9), "Next Monday Large purchase"));
    const after = await states();
    expect(after["Tuesday Large purchase"]).toBe("held back (weekly cap)");
    expect(after["Friday New Recurring charge"]).toBe("held back (weekly cap)");
    expect(after["Next Monday Large purchase"]).toBe("sent");

    // The held Alerts wait for November's Monthly review.
    expect(
      (await alertsHeldBack(bank.database, "2026-11")).map((each) => each.parts[0]?.text),
    ).toEqual(["Tuesday Large purchase", "Friday New Recurring charge"]);
    expect(await alertsHeldBack(bank.database, "2026-10")).toEqual([]);
  });

  it("fills a batch's slots by priority, and across batches earlier Alerts take them", async () => {
    await setWeeklyCap(bank.database, 2);
    const monday = est("2026-11-02", 9);
    // One batch, every capped kind, stored least urgent first.
    await batch(
      alert("Large purchase", monday, "Large purchase"),
      alert("On pace", monday, "On pace"),
      alert("New Recurring charge", monday, "New Recurring charge"),
      alert("Price increase", monday, "Price increase"),
      alert("Over Budget", monday, "Over Budget"),
    );
    expect(await states()).toEqual({
      "Over Budget": "sent",
      "Price increase": "sent",
      "New Recurring charge": "held back (weekly cap)",
      "On pace": "held back (weekly cap)",
      "Large purchase": "held back (weekly cap)",
    });

    // A new week: an earlier Large purchase takes a slot that a later Over Budget then lacks.
    await batch(alert("Large purchase", est("2026-11-09", 9), "Monday Large purchase"));
    await batch(alert("On pace", est("2026-11-10", 9), "Tuesday On pace"));
    await batch(alert("Over Budget", est("2026-11-11", 9), "Wednesday Over Budget"));
    const after = await states();
    expect(after["Monday Large purchase"]).toBe("sent");
    expect(after["Tuesday On pace"]).toBe("sent");
    expect(after["Wednesday Over Budget"]).toBe("held back (weekly cap)");
  });

  it("merges Alerts of one kind created on one day into one Alert that counts once, under one heading", async () => {
    await setWeeklyCap(bank.database, 2);
    const morning = est("2026-11-03", 8);
    await batch(
      alert("Over Budget", morning, "Restaurants is over Budget"),
      alert("Over Budget", morning, "Groceries is over Budget"),
      alert("Price increase", morning, "Streamflix went up"),
      alert("Large purchase", morning, "Large purchase at Best Buy"),
    );
    expect(await states()).toEqual({
      "Restaurants is over Budget": "sent",
      "Groceries is over Budget": "sent",
      "Streamflix went up": "sent",
      "Large purchase at Best Buy": "held back (weekly cap)",
    });

    const [overBudget] = (await mergedAlertList(bank.database)).filter(
      (each) => each.kind === "Over Budget",
    );
    expect(overBudget?.heading).toBe("2 Categories are over Budget");
    expect(overBudget?.parts.map((part) => part.text)).toEqual([
      "Restaurants is over Budget",
      "Groceries is over Budget",
    ]);
    expect(overBudget?.state).toBe("sent");

    // The merged Alert still counts once in a later batch: with a cap of 3, a third slot is left.
    await setWeeklyCap(bank.database, 3);
    await batch(alert("New Recurring charge", est("2026-11-04", 9), "Hulu"));
    expect((await states()).Hulu).toBe("sent");
  });

  it("stores a delivery only for each Alert it newly sends, with its message as it reads then", async () => {
    await setWeeklyCap(bank.database, 1);
    const morning = est("2026-11-03", 8);
    await storeAlerts(bank.database, [
      alert("Over Budget", morning, "Restaurants is over Budget"),
      alert("Over Budget", morning, "Groceries is over Budget"),
      alert("Large purchase", morning, "Large purchase at Best Buy"),
    ]);
    // The AI's advice, as the advice call stores it before the Alerts step.
    await bank.database.$client.execute({
      sql: "UPDATE alerts SET advice = ? WHERE text = ?",
      args: ["Cook at home twice this week.", "Groceries is over Budget"],
    });
    const deliveries = async () =>
      (
        await bank.database.$client.execute(
          "SELECT alert_id, title, text, advice, email_done_at FROM alert_deliveries",
        )
      ).rows;

    // The merged Over Budget Alert is sent once, under its heading. The Large purchase is held.
    expect((await decideAlerts(bank.database)).sentIds).toEqual(["alert-001"]);
    expect(await deliveries()).toEqual([
      {
        alert_id: "alert-001",
        title: "Over Budget",
        text: "2 Categories are over Budget\n- Restaurants is over Budget\n- Groceries is over Budget",
        advice: "Cook at home twice this week.",
        email_done_at: null,
      },
    ]);

    // An Alert that joins it later that day sends nothing, nor does one held back.
    expect(
      (
        await batch(
          alert("Over Budget", est("2026-11-03", 20), "Gas is over Budget"),
          alert("On pace", est("2026-11-03", 20), "Dining is on pace"),
        )
      ).sentIds,
    ).toEqual([]);
    expect(await deliveries()).toHaveLength(1);
  });

  it("joins a later Alert to that day's sent or held Alert of its kind, with no new slot", async () => {
    await setWeeklyCap(bank.database, 1);
    const morning = est("2026-11-03", 8);
    await batch(
      alert("Over Budget", morning, "Restaurants is over Budget"),
      alert("Large purchase", morning, "Large purchase at Best Buy"),
    );

    // The same day, Household time, though 10 PM in New York is the next day in UTC.
    const night = est("2026-11-03", 22);
    expect(
      await batch(
        alert("Over Budget", night, "Groceries is over Budget"),
        alert("Large purchase", night, "Large purchase at Skyway Air"),
      ),
    ).toEqual({ sent: 0, heldBack: 0, joined: 2, sentIds: [] });
    expect(await states()).toEqual({
      "Restaurants is over Budget": "sent",
      "Large purchase at Best Buy": "held back (weekly cap)",
      "Groceries is over Budget": "sent",
      "Large purchase at Skyway Air": "held back (weekly cap)",
    });

    const merged = await mergedAlertList(bank.database);
    expect(merged.map((each) => [each.heading, each.state, each.parts.map((p) => p.text)])).toEqual(
      [
        [
          "2 Large purchases",
          "held back (weekly cap)",
          ["Large purchase at Best Buy", "Large purchase at Skyway Air"],
        ],
        [
          "2 Categories are over Budget",
          "sent",
          ["Restaurants is over Budget", "Groceries is over Budget"],
        ],
      ],
    );
    // The later part sends nothing itself: it names the merged Alert it joined.
    const restaurants = merged[1]?.parts[0]?.id;
    expect(merged[1]?.parts[1]?.mergedInto).toBe(restaurants);
    expect(merged[1]?.parts[0]?.mergedInto).toBeNull();

    // The next day starts a new Alert of the kind, held by the full week.
    await batch(alert("Over Budget", est("2026-11-04", 9), "Gas is over Budget"));
    expect((await states())["Gas is over Budget"]).toBe("held back (weekly cap)");
  });

  it("counts the week Monday to Sunday in Household time", async () => {
    await setWeeklyCap(bank.database, 1);
    // 11:30 PM on Sunday, November 8 in New York is Monday in UTC: it takes the old week's slot.
    await batch(
      alert("Price increase", new Date("2026-11-09T04:30:00.000Z"), "Sunday night Price increase"),
    );
    await batch(alert("Price increase", est("2026-11-09", 9), "Monday Price increase"));
    await batch(alert("Large purchase", est("2026-11-09", 10), "Monday Large purchase"));

    expect(await states()).toEqual({
      "Sunday night Price increase": "sent",
      "Monday Price increase": "sent",
      "Monday Large purchase": "held back (weekly cap)",
    });
    // Two Alerts: one day each, Household time.
    expect((await mergedAlertList(bank.database)).map((each) => each.heading)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("with a cap of 0, holds every Alert but Duplicate charges and card interest or fees", async () => {
    await setWeeklyCap(bank.database, 0);
    const monday = est("2026-11-02", 9);
    await batch(
      alert("Over Budget", monday, "Over Budget"),
      alert("Price increase", monday, "Price increase"),
      alert("Duplicate charge", monday, "Duplicate charge"),
      alert("Card interest or fee", monday, "Card interest or fee"),
    );

    expect(await states()).toEqual({
      "Over Budget": "held back (weekly cap)",
      "Price increase": "held back (weekly cap)",
      "Duplicate charge": "sent",
      "Card interest or fee": "sent",
    });
  });

  it("never lets Duplicate charges or card interest or fees use a slot", async () => {
    await setWeeklyCap(bank.database, 1);
    for (const [day, kind] of [
      ["2026-11-02", "Duplicate charge"],
      ["2026-11-03", "Card interest or fee"],
      ["2026-11-04", "Duplicate charge"],
    ] as const) {
      await batch(alert(kind, est(day, 9), `${day} ${kind}`));
    }
    await batch(alert("Large purchase", est("2026-11-05", 9), "Large purchase"));

    expect(Object.values(await states())).toEqual(["sent", "sent", "sent", "sent"]);
  });

  it("leaves an Alert found in history as it is: never sent, never merged, and no slot", async () => {
    await setWeeklyCap(bank.database, 1);
    const monday = est("2026-11-02", 9);
    await storeAlerts(bank.database, [
      { ...alert("Price increase", monday, "Found Price increase"), state: "found in history" },
    ]);
    await batch(alert("Price increase", monday, "New Price increase"));

    expect(await states()).toEqual({
      "Found Price increase": "found in history",
      "New Price increase": "sent",
    });
    expect((await mergedAlertList(bank.database)).map((each) => each.heading)).toEqual([
      null,
      null,
    ]);
  });

  it("takes a cap change from the next Alert on, and only a whole number from 0", async () => {
    await batch(alert("Over Budget", est("2026-11-02", 9), "Over Budget"));
    expect(await setWeeklyCap(bank.database, 1)).toBe(1);
    await batch(alert("Price increase", est("2026-11-02", 10), "Price increase"));
    expect(await states()).toEqual({
      "Over Budget": "sent",
      "Price increase": "held back (weekly cap)",
    });
    // A held Alert uses no slot: raised to 2, the cap has one left this week, and the held Alert
    // stays held.
    await setWeeklyCap(bank.database, 2);
    await batch(alert("Large purchase", est("2026-11-03", 9), "Large purchase"));
    await batch(alert("On pace", est("2026-11-04", 9), "On pace"));
    expect(await states()).toEqual({
      "Over Budget": "sent",
      "Price increase": "held back (weekly cap)",
      "Large purchase": "sent",
      "On pace": "held back (weekly cap)",
    });
    await setWeeklyCap(bank.database, 1);

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(setWeeklyCap(bank.database, bad)).rejects.toThrow(
        "The weekly cap is a whole number from 0.",
      );
    }
    expect(await weeklyCap(bank.database)).toBe(1);
  });

  it("decides each Alert once: a run with nothing new changes nothing", async () => {
    await batch(alert("Over Budget", est("2026-11-02", 9), "Over Budget"));
    const before = await alertList(bank.database);

    expect(await decideAlerts(bank.database)).toEqual({
      sent: 0,
      heldBack: 0,
      joined: 0,
      sentIds: [],
    });
    expect(await alertList(bank.database)).toEqual(before);
  });

  it("never stores a second decision on a sent or held back Alert, in its state or its merged Alert", async () => {
    await setWeeklyCap(bank.database, 1);
    const monday = est("2026-11-02", 9);
    await batch(
      alert("Over Budget", monday, "Sent Over Budget"),
      alert("Large purchase", monday, "Held Large purchase"),
      alert("Price increase", monday, "Other Price increase"),
    );
    const before = await alertList(bank.database);
    const idOf = (text: string) => before.find((each) => each.text === text)?.id ?? "";

    const deliveries = async () =>
      (await bank.database.$client.execute("SELECT alert_id, text FROM alert_deliveries")).rows;
    const sentBefore = await deliveries();
    expect(sentBefore).toEqual([{ alert_id: idOf("Sent Over Budget"), text: "Sent Over Budget" }]);

    // A decision that would turn each into a later part of another Alert, with the other state,
    // and send each again.
    const other = idOf("Other Price increase");
    const again = (id: string) => ({
      alertId: id,
      title: "Over Budget",
      text: "Sent again",
      advice: null,
      createdAt: monday,
    });
    expect(
      await storeAlertDecisions(
        bank.database,
        [
          { id: idOf("Sent Over Budget"), state: "held back (weekly cap)", mergedInto: other },
          { id: idOf("Held Large purchase"), state: "sent", mergedInto: other },
        ],
        [again(idOf("Sent Over Budget")), again(idOf("Held Large purchase"))],
      ),
    ).toEqual(new Set());
    expect(await alertList(bank.database)).toEqual(before);
    expect(await deliveries()).toEqual(sentBefore);
    expect((await mergedAlertList(bank.database)).map((each) => each.parts.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it("keeps a merged Alert's later parts when its first part is deleted, each an Alert of its own", async () => {
    const morning = est("2026-11-03", 8);
    await batch(
      alert("Over Budget", morning, "Restaurants is over Budget"),
      alert("Over Budget", morning, "Groceries is over Budget"),
    );
    const deliveries = async () =>
      (await bank.database.$client.execute("SELECT alert_id FROM alert_deliveries")).rows;
    expect(await deliveries()).toEqual([{ alert_id: "alert-001" }]);
    await bank.database.$client.execute({
      sql: "DELETE FROM alerts WHERE text = ?",
      args: ["Restaurants is over Budget"],
    });

    const merged = await mergedAlertList(bank.database);
    expect(merged.map((each) => [each.heading, each.state, each.parts.length])).toEqual([
      [null, "sent", 1],
    ]);
    expect(merged[0]?.parts[0]?.mergedInto).toBeNull();
    // Its delivery goes with the first part. The later part never went out, and nothing sends it
    // now: only the Alerts step's decisions send.
    expect(await deliveries()).toEqual([]);
    expect((await decideAlerts(bank.database)).sentIds).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });
});

describe("the Alerts step in the follow-up job", () => {
  const BANK = "fake-alerts-bank";
  const CHECKING = fakeAccount({ id: "acc-checking", name: "Checking" });
  const $ = (dollars: number) => Math.round(dollars * 100);
  const at = (date: string) => new Date(`${date}T15:00:00.000Z`);
  let bank: TestBank;
  let connectionId: string;
  let stop: () => void;
  let now: Date;
  const clock = () => now;
  const ids = new Map<string, string>();

  // Syncs Transactions with their parts, as Money movement and Categorization would store them.
  const load = async (txns: { id: string; date: string; parts: NewPart[] }[]) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CHECKING.id,
          amount: txn.parts.reduce((sum, part) => sum + part.amount, 0),
          postedDate: txn.date,
        }),
      ),
    });
    await syncConnection(connectionId, clock);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    for (const row of rows.rows) ids.set(String(row.provider_transaction_id), String(row.id));
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: now,
        parts: txn.parts,
      })),
    );
  };

  beforeEach(async () => {
    ids.clear();
    now = at("2026-11-10");
    bank = await newTestBank();
    connectionId = await bank.connect(BANK);
    stop = startAlertSending({ database: bank.database }).stop;
  });

  afterEach(() => {
    stop();
    bank.close();
  });

  it("never changes a sent Alert, even when a later Refund brings its month back under Budget", async () => {
    await storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6_000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-11",
        fixedCostsPassIncome: false,
        recordedAt: at("2026-11-01"),
      },
      budgets: [
        {
          category: "Restaurants",
          amount: $(500),
          period: "monthly",
          takesEffect: "2026-11",
          source: "formula",
          setBy: null,
          pinned: null,
          setAt: at("2026-11-01"),
        },
      ],
    });
    await load([
      {
        id: "dinner",
        date: "2026-11-09",
        parts: [{ type: "Spending", amount: -$(620), category: "Restaurants" }],
      },
    ]);
    expect(await checkOverspending(bank.database, [...ids.values()], now)).toBe(1);
    await runFollowUp(clock);
    const sent = await alertList(bank.database);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "Over Budget",
        state: "sent",
        text: "Restaurants is over Budget for Nov 2026: $620 of $500. Latest: $620.00 at FAKE dinner on Nov 9.",
      }),
    ]);

    // A $400 Refund brings November's Spending to $220 of $500. The sent Alert stays as it went
    // out, beside the new On pace Alert the checks fire: the $620 one-off is not extrapolated.
    now = at("2026-11-12");
    await load([
      {
        id: "refund",
        date: "2026-11-11",
        parts: [{ type: "Refund", amount: $(400), category: "Restaurants" }],
      },
    ]);
    await checkOverspending(bank.database, [...ids.values()], now);
    await runFollowUp(clock);
    const after = await alertList(bank.database);
    expect(after.map((each) => each.text)).toEqual([
      "Restaurants is on pace for $620 in Nov 2026, 24% over its $500 Budget. Spent so far: $220.",
      sent[0]?.text,
    ]);
    expect(after[1]).toEqual(sent[0]);
  });

  it("stops at its cap with one System notice, and the next run that succeeds decides the Alerts and ends it", async () => {
    await load([
      {
        id: "lunch",
        date: "2026-11-09",
        parts: [{ type: "Spending", amount: -$(20), category: "Restaurants" }],
      },
    ]);
    await storeAlerts(bank.database, [
      {
        id: "alert-1",
        kind: "Price increase",
        createdAt: now,
        facts: { kind: "Price increase" },
        text: "Streamflix went up",
        category: null,
        state: null,
        transactionIds: [],
      },
    ]);
    await bank.database.$client.execute("ALTER TABLE alert_settings RENAME TO alert_settings_away");
    for (let run = 1; run < ALERT_SENDING_CAP; run += 1) {
      await expect(runFollowUp(clock)).rejects.toThrow("The Alerts step failed.");
    }
    // The run at the cap gives up, and the job goes on. The Alert stays undecided: nothing sends it.
    await expect(runFollowUp(clock)).resolves.toBeUndefined();
    const open = async () =>
      (
        await bank.database.$client.execute({
          sql: "SELECT text FROM system_notices WHERE condition = ? AND closed_at IS NULL",
          args: [ALERT_SENDING_STOPPED],
        })
      ).rows;
    expect(await open()).toHaveLength(1);
    expect((await alertList(bank.database))[0]?.state).toBeNull();
    const deliveries = async () =>
      (await bank.database.$client.execute("SELECT alert_id FROM alert_deliveries")).rows;
    expect(await deliveries()).toEqual([]);
    // The notice asked for its own delivery.
    expect(bank.deliveriesAsked()).toBe(1);

    await bank.database.$client.execute("ALTER TABLE alert_settings_away RENAME TO alert_settings");
    await load([
      {
        id: "dinner",
        date: "2026-11-10",
        parts: [{ type: "Spending", amount: -$(40), category: "Restaurants" }],
      },
    ]);
    await runFollowUp(clock);
    expect(await open()).toEqual([]);
    expect((await alertList(bank.database))[0]?.state).toBe("sent");
    // Decided late, it is sent when it is decided: its delivery is stored, and the step asks once.
    expect(await deliveries()).toEqual([{ alert_id: "alert-1" }]);
    expect(bank.deliveriesAsked()).toBe(2);
    await load([
      {
        id: "snack",
        date: "2026-11-10",
        parts: [{ type: "Spending", amount: -$(5), category: "Restaurants" }],
      },
    ]);
    await runFollowUp(clock);
    // A run that sends nothing asks for nothing.
    expect(bank.deliveriesAsked()).toBe(2);
  });
});
