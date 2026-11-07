import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiUsageView } from "../../../ai/ai-view.ts";
import type {
  AiRequestLogEntryView,
  AiRequestLogItem,
  AiRequestLogSettingsView,
} from "../../../ai/request-log-view.ts";
import {
  AiRequestLogCard,
  AiRequestLogEntryReport,
  AiRequestLogList,
  readAiRequestLog,
  readAiRequestLogEntry,
  saveAiRequestLog,
  TURN_OFF_QUESTION,
} from "./AiRequestLog.tsx";
import { AiUsageReport } from "./AiUsage.tsx";

// Settings → AI → AI usage: the AI request log's card, the log page, and one kept call's page
// (spec 08, AI request log), as the browser first paints them, and the requests they send.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const routed = (page: ReactNode) => renderToString(<MemoryRouter>{page}</MemoryRouter>);
const ZONE = "America/New_York";
const TODAY = "2026-11-20";
const OFF: AiRequestLogSettingsView = { on: false, keepDays: 30, stopped: false };
const ON: AiRequestLogSettingsView = { ...OFF, on: true };

const CHAT: AiRequestLogItem = {
  id: 41,
  at: "2026-11-20T13:15:00.000Z",
  use: "chat",
  model: "claude-sonnet-5-5",
  failure: null,
  failureStatus: null,
  usage: {
    noCacheTokens: 1200,
    cacheReadTokens: 2500,
    cacheWriteTokens: 0,
    outputTokens: 310,
    costNanos: 6_400_000,
  },
};
const REFUSED: AiRequestLogItem = {
  id: 40,
  at: "2026-11-20T04:30:00.000Z",
  use: "category fix",
  model: "claude-haiku-5-5",
  failure: "rate limit",
  failureStatus: 429,
  usage: null,
};

describe("Settings → AI usage: the AI request log card", () => {
  it("is one labeled switch, off by default, with the kept days at 30", () => {
    const html = routed(<AiRequestLogCard initial={OFF} />);
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toMatch(/<input type="checkbox" role="switch"[^>]*aria-checked="false"/);
    expect(text(html)).toContain("Keep AI request text");
    expect(text(html)).toContain(
      "Off by default. The AI usage metadata on this page is kept either way.",
    );
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((match) => match[0]);
    expect(radios).toHaveLength(3);
    expect(radios.map((radio) => /value="(\d+)"/.exec(radio)?.[1])).toEqual(["7", "30", "90"]);
    expect(radios.filter((radio) => radio.includes('checked=""'))).toEqual([
      expect.stringContaining('value="30"'),
    ]);
    expect(text(html)).toContain("Keep text for7 days30 days90 days");
    expect(html).toContain('href="/settings/ai/usage/log"');
    expect(text(html)).not.toContain(TURN_OFF_QUESTION);

    const on = routed(<AiRequestLogCard initial={{ ...ON, keepDays: 7 }} />);
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toMatch(/checked="" value="7"/);
    expect(text(on)).toContain("✓ On");
  });

  it("asks before turning off, saying it deletes every kept text, and holds the switch meanwhile", () => {
    const html = routed(<AiRequestLogCard initial={ON} confirming />);
    expect(TURN_OFF_QUESTION).toBe(
      "Turn off the AI request log? This deletes all kept AI request text now.",
    );
    expect(text(html)).toContain(TURN_OFF_QUESTION);
    expect(text(html)).toContain("Turn off and delete");
    expect(text(html)).toContain("Keep it on");
    expect(html).toMatch(/role="switch"[^>]* disabled=""/);
  });

  it("says when the cleanup has stopped, with a button to try it again", () => {
    const html = routed(<AiRequestLogCard initial={{ ...ON, stopped: true }} />);
    expect(text(html)).toContain(
      "▲ The app could not delete old AI request text, so the log keeps no new text.",
    );
    expect(text(html)).toContain("Try the cleanup again");
    expect(text(routed(<AiRequestLogCard initial={ON} />))).not.toContain("Try the cleanup");
  });
});

describe("Settings → AI usage: the Open link of a call with kept text", () => {
  const USAGE: AiUsageView = {
    month: "2026-11",
    totalNanos: 6_400_000,
    capCents: 1000,
    pausedUntil: null,
    byUse: [{ use: "chat", calls: 2, costNanos: 6_400_000 }],
    calls: [
      {
        id: 2,
        at: "2026-11-20T13:15:00.000Z",
        use: "chat",
        model: "claude-sonnet-5-5",
        noCacheTokens: 1200,
        cacheReadTokens: 2500,
        cacheWriteTokens: 0,
        outputTokens: 310,
        costNanos: 6_400_000,
        logEntryId: 41,
      },
      {
        id: 1,
        at: "2026-11-20T13:10:00.000Z",
        use: "chat",
        model: "claude-sonnet-5-5",
        noCacheTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        costNanos: 0,
      },
    ],
  };

  it("opens the kept call, and shows no Text column while no call has kept text", () => {
    const html = routed(<AiUsageReport usage={USAGE} zone={ZONE} today={TODAY} />);
    expect(html.match(/>Open</g)).toHaveLength(1);
    expect(html).toContain('href="/settings/ai/usage/log/41"');
    expect(html).toMatch(/<th[^>]*>Text<\/th>/);

    const none = routed(
      <AiUsageReport
        usage={{ ...USAGE, calls: USAGE.calls.map(({ logEntryId: _, ...call }) => call) }}
        zone={ZONE}
        today={TODAY}
      />,
    );
    expect(none).not.toContain(">Open<");
    expect(none).not.toMatch(/<th[^>]*>Text<\/th>/);
  });

  it("puts the card under the month's total", () => {
    const html = routed(
      <AiUsageReport usage={USAGE} zone={ZONE} today={TODAY}>
        <AiRequestLogCard initial={OFF} />
      </AiUsageReport>,
    );
    const total = text(html).indexOf("this month");
    const card = text(html).indexOf("Keep AI request text");
    const byUse = text(html).indexOf("This month by use");
    expect(total).toBeLessThan(card);
    expect(card).toBeLessThan(byUse);
  });
});

describe("Settings → AI usage → AI request log", () => {
  it("lists kept calls newest first, in Household time, with their use, model, tokens, cost, and failure", () => {
    const html = routed(
      <AiRequestLogList settings={ON} entries={[CHAT, REFUSED]} zone={ZONE} today={TODAY} />,
    );
    const rows = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((match) => text(match[1] ?? ""));
    expect(rows).toEqual([
      "Nov 20, 8:15 AMChat · claude-sonnet-5-54,010 tokens · $0.0064",
      "Nov 19, 11:30 PMCategory fix · claude-haiku-5-5▲ Failed: rate limit (HTTP 429)No usage counted",
    ]);
    expect([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "/settings/ai/usage/log/41",
      "/settings/ai/usage/log/40",
    ]);
    expect(text(html)).not.toContain("is off");
  });

  it("says when the log is off or its cleanup stopped, and when nothing is kept", () => {
    const html = routed(
      <AiRequestLogList
        settings={{ ...OFF, stopped: true }}
        entries={[]}
        zone={ZONE}
        today={TODAY}
      />,
    );
    expect(text(html)).toContain(
      "The AI request log is off, so it keeps no new text. Turn it on on the AI usage page.",
    );
    expect(text(html)).toContain("▲ The app could not delete old AI request text");
    expect(text(html)).toContain("No kept AI request text.");
  });
});

describe("Settings → AI usage → one kept call", () => {
  const ENTRY: AiRequestLogEntryView = {
    ...CHAT,
    request: '{\n  "prompt": "<b>Member A</b> asked **how much**"\n}',
    requestCut: false,
    response: "<script>alert(1)</script>\n\n# Not a heading",
    responseCut: true,
  };

  it("shows its facts and both texts as plain text, never as HTML or Markdown", () => {
    const html = routed(<AiRequestLogEntryReport entry={ENTRY} zone={ZONE} today={TODAY} />);
    const facts = [...html.matchAll(/<d[td][^>]*>(.*?)<\/d[td]>/g)].map((match) =>
      text(match[1] ?? ""),
    );
    expect(facts).toEqual([
      "Use",
      "Chat",
      "Model",
      "claude-sonnet-5-5",
      "Time",
      "Nov 20, 8:15 AM",
      "Input without cache",
      "1,200",
      "Cache read",
      "2,500",
      "Cache write",
      "0",
      "Output",
      "310",
      "Cost",
      "$0.0064",
    ]);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<h1");
    expect(html).toContain("&lt;b&gt;Member A&lt;/b&gt; asked **how much**");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;\n\n# Not a heading");
    expect(html.match(/<pre[^>]*whitespace-pre-wrap/g)).toHaveLength(2);
    // Only the cut text says so.
    expect(text(html).match(/Cut at 256 KB/g)).toHaveLength(1);
    expect(text(html).indexOf("Cut at 256 KB")).toBeGreaterThan(text(html).indexOf("Reply"));
  });

  it("shows a failed call with no usage row as such", () => {
    const html = routed(
      <AiRequestLogEntryReport
        entry={{ ...ENTRY, ...REFUSED, response: "", responseCut: false }}
        zone={ZONE}
        today={TODAY}
      />,
    );
    expect(text(html)).toContain("UsageNo usage counted");
    expect(text(html)).not.toContain("Cost");
    expect(text(html)).toContain("▲ Failed: rate limit (HTTP 429)");
    expect(text(html)).toContain("No reply text.");
    expect(text(html)).toContain("Nov 19, 11:30 PM");
  });
});

// PUT /api/ai-request-log/settings answers 415 without a JSON content type, so the page must send
// one. src/server/ai-request-log-api.test.ts sends these same requests.
describe("Settings → AI usage: the AI request log's requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the switch and the kept days as JSON, and pages with the cursor", async () => {
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
    await saveAiRequestLog({ on: false, keepDays: 7 });
    await readAiRequestLog();
    await readAiRequestLog(41);
    await readAiRequestLogEntry("41");
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/ai-request-log/settings",
        type: "application/json",
        body: JSON.stringify({ on: false, keepDays: 7 }),
      },
      { method: "GET", path: "/api/ai-request-log", type: null, body: undefined },
      { method: "GET", path: "/api/ai-request-log?before=41", type: null, body: undefined },
      { method: "GET", path: "/api/ai-request-log/41", type: null, body: undefined },
    ]);
  });
});
