import { expect } from "vitest";
import { householdTimeZone } from "../../household/index.ts";
import { smtpSettings } from "../../notify/index.ts";
import {
  buildWeeklySummary,
  sendWeeklySummaries,
  summaryWeek,
} from "../../weekly-summary/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { REQUEST_LIMIT_MS, timedCase } from "../index.ts";

// The weekly summary email on the full history (spec 06, Weekly summary email): the Member's own
// switch in Settings, Alerts, the summary's build, and the Sunday job that builds it once and
// sends it through a stubbed SMTP server. The build reads each kind of data once, never once per
// Transaction, so it keeps the 1 s request limit.
timedCase("the weekly summary email", async (history, time) => {
  await time.request("GET /api/weekly-summary", () => history.browser.get("/api/weekly-summary"));
  await time.request("PUT /api/weekly-summary", () =>
    history.browser.send("PUT", "/api/weekly-summary", { on: true }),
  );

  const now = HISTORY_NOW();
  const timeZone = (await householdTimeZone(history.database)) ?? "UTC";
  const week = summaryWeek(now, timeZone);
  const email = await time.job("Weekly summary build on the full history", REQUEST_LIMIT_MS, () =>
    buildWeeklySummary({
      database: history.database,
      week,
      timeZone,
      address: (path) => `http://nas.local:8080${path}`,
      now,
    }),
  );
  expect(email.text).toMatch(/^Spending: \$[\d,]+/m);

  const saved = await smtpSettings({
    database: history.database,
    secrets: history.secrets,
    address: (path) => path,
  }).save({
    host: "smtp.example.test",
    port: 587,
    username: "household@example.test",
    password: `pw-${crypto.randomUUID()}`,
    sender: "alerts@example.test",
  });
  expect(saved.saved).toBe(true);
  const run = await time.job("Weekly summary job on the full history", 2_000, () =>
    sendWeeklySummaries(),
  );
  expect(run).toMatchObject({ sent: 1, failed: 0, gaveUp: 0 });
});
