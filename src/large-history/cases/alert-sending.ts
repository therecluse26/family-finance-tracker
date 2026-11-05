import { expect } from "vitest";
import { decideAlerts, mergedAlertList } from "../../anomalies/index.ts";
import { type AlertKind, storeAlerts } from "../../db/index.ts";
import { deliverWaiting, smtpSettings } from "../../notify/index.ts";
import { addDays } from "../../recurring/index.ts";
import type { AlertView } from "../../server/alerts-views.ts";
import { HISTORY_LAST_DAY } from "../history.ts";
import { timedCase } from "../index.ts";

const KINDS: AlertKind[] = [
  "Over Budget",
  "Price increase",
  "New Recurring charge",
  "On pace",
  "Large purchase",
  "Duplicate charge",
  "Card interest or fee",
];

// The Alerts step on 2,500 new Alerts over the history's last 50 weeks, beside every Alert found
// in the full history: it decides them all in one run, and the weekly cap holds each week. Then
// the Delivery job, which emails every Alert sent, then the Alert list and Settings, Alerts.
timedCase("Alerts step", async (history, time) => {
  const first = addDays(HISTORY_LAST_DAY, -349);
  await storeAlerts(
    history.database,
    Array.from({ length: 2_500 }, (_, index) => {
      const kind = KINDS[index % KINDS.length] ?? "Over Budget";
      const day = addDays(first, index % 350);
      return {
        id: `bench-alert-${index}`,
        kind,
        createdAt: new Date(`${day}T15:00:00.000Z`),
        facts: { kind },
        text: `${kind} ${index}`,
        category: null,
        state: null,
        transactionIds: [],
      };
    }),
  );

  const done = await time.job("Alerts step on 2,500 new Alerts", 5_000, () =>
    decideAlerts(history.database),
  );
  expect(done.sent + done.heldBack + done.joined).toBeGreaterThan(0);

  // At most 3 Alerts a week within the cap, a merged Alert counted once.
  const capped = new Map<string, number>();
  for (const alert of await mergedAlertList(history.database)) {
    if (
      alert.state !== "sent" ||
      ["Duplicate charge", "Card interest or fee"].includes(alert.kind)
    ) {
      continue;
    }
    const day = alert.createdAt.toISOString().slice(0, 10);
    const weekday = (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
    const week = addDays(day, -weekday);
    capped.set(week, (capped.get(week) ?? 0) + 1);
  }
  expect(Math.max(...capped.values())).toBe(3);

  const saved = await smtpSettings({
    database: history.database,
    secrets: history.secrets,
    address: (path) => path,
  }).save(
    {
      host: "smtp.example.test",
      port: 587,
      username: "household@example.test",
      password: `pw-${crypto.randomUUID()}`,
      sender: "alerts@example.test",
    },
    { freshCode: true },
  );
  expect(saved.saved).toBe(true);
  await time.job(`Delivery job on ${done.sent} sent Alerts`, 10_000, () => deliverWaiting());
  const waiting = await history.database.$client.execute(
    "SELECT count(*) AS n FROM alert_deliveries WHERE email_done_at IS NULL",
  );
  expect(waiting.rows[0]?.n).toBe(0);

  const { alerts } = (await time.request("GET /api/alerts", () =>
    history.browser.get("/api/alerts"),
  )) as { alerts: AlertView[] };
  expect(alerts.some((alert) => alert.heading !== null)).toBe(true);
  await time.request("POST /api/alerts/:id/not-a-problem", () =>
    history.browser.send("POST", `/api/alerts/${alerts[0]?.id ?? ""}/not-a-problem`, {}),
  );
  await time.request("GET /api/alert-settings", () => history.browser.get("/api/alert-settings"));
  await time.request("PUT /api/alert-settings/weekly-cap", () =>
    history.browser.send("PUT", "/api/alert-settings/weekly-cap", { weeklyCap: 2 }),
  );
  await time.request("GET /api/alert-channels", () => history.browser.get("/api/alert-channels"));
  await time.request("PUT /api/alert-channels", () =>
    history.browser.send("PUT", "/api/alert-channels", { push: true, email: false }),
  );
});
