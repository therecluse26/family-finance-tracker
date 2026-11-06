import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeeklySummaryView } from "../../../weekly-summary/view.ts";
import { saveWeeklySummary, WeeklySummaryRow } from "./WeeklySummary.tsx";

// Settings, Alerts: the Member's own weekly summary email switch (spec 06, Weekly summary email),
// as the browser first paints it.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const TODAY = "2026-11-10";
const OFF: WeeklySummaryView = { on: false, emailSetUp: true, last: null };
const paint = (view: WeeklySummaryView) =>
  renderToString(<WeeklySummaryRow initial={view} today={TODAY} />);

describe("Settings, Alerts: the weekly summary email switch", () => {
  it("is one labeled switch, off or on", () => {
    const off = paint(OFF);
    expect(off.match(/role="switch"/g)).toHaveLength(1);
    expect(off).toMatch(/<input type="checkbox" role="switch"[^>]*aria-checked="false"/);
    expect(off).not.toMatch(/role="switch"[^>]* checked=""/);
    expect(text(off)).toContain("Weekly summary email");
    expect(text(off)).toContain("Sunday morning at 8:00 AM, Household time, to your login email.");

    const on = paint({ ...OFF, on: true });
    expect(on).toMatch(/<input type="checkbox" role="switch"[^>]*aria-checked="true"/);
    expect(on).toMatch(/role="switch"[^>]* checked=""/);
  });

  it("says it needs the email server while none is saved, and lets the Member turn it on", () => {
    const html = paint({ ...OFF, emailSetUp: false });
    expect(text(html)).toContain("Needs the email server. Save it below.");
    expect(html).not.toMatch(/role="switch"[^>]* disabled=""/);
    expect(text(paint(OFF))).not.toContain("Needs the email server");
  });

  it("shows the Member's latest week: sent, still sending, or not sent", () => {
    const sent = paint({
      on: true,
      emailSetUp: true,
      last: { from: "2026-11-01", to: "2026-11-07", state: "sent", on: "2026-11-08" },
    });
    expect(text(sent)).toContain("✓ Last sent Sunday, Nov 8");

    const gaveUp = paint({
      on: true,
      emailSetUp: true,
      last: { from: "2026-11-01", to: "2026-11-07", state: "did not send", on: "2026-11-08" },
    });
    expect(text(gaveUp)).toContain(
      "▲ The summary for Nov 1 to Nov 7 did not send. Check the email server below.",
    );
    expect(text(gaveUp)).not.toContain("Last sent");

    const sending = paint({
      on: true,
      emailSetUp: true,
      last: { from: "2026-11-08", to: "2026-11-14", state: "sending", on: "2026-11-15" },
    });
    expect(text(sending)).toContain(
      "◆ Sending the summary for Nov 8 to Nov 14. The app tries again if a send fails.",
    );
    expect(text(sending)).not.toMatch(/Last sent|did not send/);

    const lastYear = paint({
      on: true,
      emailSetUp: true,
      last: { from: "2025-12-28", to: "2026-01-03", state: "sent", on: "2026-01-04" },
    });
    expect(text(lastYear)).toContain("Last sent Sunday, Jan 4");
  });
});

// PUT /api/weekly-summary answers 415 without a JSON content type, so the page must send one.
// src/weekly-summary/weekly-summary-api.test.ts sends this same request.
describe("Settings, Alerts: the request the switch sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only the switch's new state, as JSON", async () => {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    await saveWeeklySummary(true);
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/weekly-summary",
        type: "application/json",
        body: JSON.stringify({ on: true }),
      },
    ]);
  });
});
