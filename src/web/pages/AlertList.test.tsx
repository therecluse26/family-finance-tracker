import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertPartView, AlertView } from "../../server/alerts-views.ts";
import { askAiAbout } from "../chat.ts";
import { AlertPart, AlertRows, alertLine, alertListRequests, newestFirst } from "./AlertList.tsx";

// The Alert list (spec 07, Alert list), with every mark and a merged Alert.

const TODAY = "2026-11-05";
const ZONE = "America/New_York";

const part = (id: string, fields: Partial<AlertPartView> = {}): AlertPartView => ({
  id,
  createdAt: "2026-11-03T14:00:00.000Z",
  text: `Alert ${id}.`,
  facts: {},
  transactionIds: [],
  category: null,
  advice: null,
  notAProblem: [],
  ...fields,
});

const alert = (
  id: string,
  createdAt: string,
  kind: AlertView["kind"],
  state: AlertView["state"],
  parts: AlertPartView[] = [part(id, { createdAt })],
  heading: string | null = null,
): AlertView => ({ id, kind, createdAt, heading, parts, state });

// Out of order, as no list should rely on.
const ALERTS: AlertView[] = [
  alert("held", "2026-11-02T15:00:00.000Z", "Large purchase", "held back (weekly cap)"),
  alert("found", "2025-12-30T15:00:00.000Z", "Duplicate charge", "found in history"),
  alert(
    "merged",
    "2026-11-04T13:00:00.000Z",
    "Over Budget",
    "sent",
    [
      part("merged", { text: "Groceries is $40.00 over its Budget." }),
      part("merged-2", {
        text: "Dining is $12.00 over its Budget.",
        advice: "Plan two meals at home this week.",
      }),
    ],
    "2 Categories are over Budget",
  ),
  alert("waiting", "2026-11-05T01:00:00.000Z", "Price increase", null, [
    part("waiting", {
      createdAt: "2026-11-05T01:00:00.000Z",
      text: "Streamly went up from $15.49 to $17.99 (+$2.50, +16%) on Oct 3.",
    }),
  ]),
];

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the Alert list page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows every Alert newest first, held and found-in-history ones too, each with its mark", () => {
    expect(newestFirst(ALERTS).map((each) => each.id)).toEqual([
      "waiting",
      "merged",
      "held",
      "found",
    ]);
    const html = renderToString(
      <AlertRows
        alerts={ALERTS}
        states={{}}
        asks={{}}
        today={TODAY}
        zone={ZONE}
        onNotAProblem={() => {}}
        onAskAi={() => {}}
      />,
    );
    const rows = [
      ...html.matchAll(
        /<li [^>]*data-kind="[^"]*"[^>]*>(.*?)<\/li>(?=<li [^>]*data-kind|<\/ul>$)/gs,
      ),
    ].map((match) =>
      // An amount kept whole sits inside the words, so its span adds no space.
      text((match[1] ?? "").replace(/<span class="whitespace-nowrap">([^<]*)<\/span>/g, "$1")),
    );

    // Each Alert's kind icon, its text, then its date, kind and mark, then its presses. A merged
    // Alert puts the icon, the date line, and its one "Ask the AI" under its heading, and each part
    // has its own "Not a problem".
    expect(rows).toEqual([
      // 1 AM UTC on Nov 5 is Nov 4 in New York. The Alerts step has not decided it yet.
      "◆ Streamly went up from $15.49 to $17.99 (+$2.50, +16%) on Oct 3. Nov 4 · Price increase Ask the AI Not a problem",
      "▲ 2 Categories are over Budget Nov 4 · Over Budget · sent Ask the AI Groceries is $40.00 over its Budget. Not a problem Dining is $12.00 over its Budget. AI Plan two meals at home this week. Not a problem",
      "● Alert held. Nov 2 · Large purchase · held back (weekly cap) Ask the AI Not a problem",
      "◆ Alert found. Dec 30, 2025 · Duplicate charge · found in history Ask the AI Not a problem",
    ]);
    // The icon is color with a word: the kind always shows beside it, and the icon is hidden from
    // screen readers.
    expect(html).toContain('<span aria-hidden="true" class="mr-1.5 text-critical">▲</span>');
    expect(html).toContain('<span aria-hidden="true" class="mr-1.5 text-serious">◆</span>');
    expect(html).toContain('<span aria-hidden="true" class="mr-1.5 text-accent">●</span>');
    // A signed amount never breaks after its sign (spec 07, Number formats).
    expect(html).toContain('(<span class="whitespace-nowrap">+$2.50</span>, +16%)');
    expect(alertLine(ALERTS[0] as AlertView, TODAY, ZONE)).toBe("Nov 2 · Large purchase");
  });

  it('says "No Alerts yet." with no Alerts', () => {
    const html = renderToString(
      <AlertRows
        alerts={[]}
        states={{}}
        asks={{}}
        today={TODAY}
        zone={ZONE}
        onNotAProblem={() => {}}
        onAskAi={() => {}}
      />,
    );

    expect(text(html)).toBe("No Alerts yet.");
  });

  it("gives each part of a merged Alert its own Not a problem press, sent as JSON", async () => {
    const sent: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        type: new Headers(init?.headers).get("content-type"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ notAProblem: [] });
    });
    const merged = ALERTS[2] as AlertView;
    const onNotAProblem = (each: AlertPartView) => void alertListRequests.notAProblem(each.id);

    for (const each of merged.parts) {
      const button = AlertPart({ part: each, state: {}, today: TODAY, zone: ZONE, onNotAProblem })
        .props.children[1].props.children[1];
      button.props.onClick();
    }

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual(
      ["merged", "merged-2"].map((id) => ({
        method: "POST",
        path: `/api/alerts/${id}/not-a-problem`,
        type: "application/json",
        body: {},
      })),
    );
  });

  it("shows a pressed part as marked, and does not offer the press again", () => {
    const pressed = part("held", {
      notAProblem: [{ memberId: "member-1", pressedAt: "2026-11-03T18:00:00.000Z" }],
    });
    const html = renderToString(
      <AlertPart part={pressed} state={{}} today={TODAY} zone={ZONE} onNotAProblem={() => {}} />,
    );

    expect(text(html)).toBe("Alert held. Not a problem marked Nov 3");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Not a problem<\/button>/);
    const open = renderToString(
      <AlertPart
        part={part("open")}
        state={{}}
        today={TODAY}
        zone={ZONE}
        onNotAProblem={() => {}}
      />,
    );
    expect(open).not.toContain(`disabled=""`);
  });

  it('"Ask the AI" sends only the Alert\'s ID, as an empty JSON body, and opens its thread or says why not', async () => {
    const sent: { method: string; path: string; type: string | null; body: unknown }[] = [];
    let answer = Response.json({ threadId: "thread-1" }, { status: 201 });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        type: new Headers(init?.headers).get("content-type"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return answer;
    });
    const asked: string[] = [];
    const html = renderToString(
      <AlertRows
        alerts={ALERTS}
        states={{}}
        asks={{
          held: { error: "Set up an AI provider in Settings, AI, to use Chat." },
          merged: { error: "Chat is paused." },
        }}
        today={TODAY}
        zone={ZONE}
        onNotAProblem={() => {}}
        onAskAi={(each) => asked.push(each.id)}
      />,
    );
    // One press per Alert, a merged one too, and the refusal's words under the Alert it is about.
    expect(html.match(/>Ask the AI<\/button>/g)).toHaveLength(ALERTS.length);
    expect(text(html)).toContain(
      "Nov 2 · Large purchase · held back (weekly cap) Ask the AI Not a problem Set up an AI provider in Settings, AI, to use Chat.",
    );
    // A merged Alert's words go under its heading's row, not beside the button in it.
    expect(text(html)).toContain("Nov 4 · Over Budget · sent Ask the AI Chat is paused. Groceries");
    expect(html).toContain(
      '>Ask the AI</button></div><p class="mt-3 text-critical" role="alert">Chat is paused.</p></div>',
    );

    expect(await askAiAbout("merged")).toEqual({ threadId: "thread-1" });
    answer = Response.json(
      { error: "Set up an AI provider in Settings, AI, to use Chat.", pause: "no AI provider" },
      { status: 409 },
    );
    expect(await askAiAbout("held")).toEqual({
      error: "Set up an AI provider in Settings, AI, to use Chat.",
    });
    expect(sent).toEqual(
      ["merged", "held"].map((id) => ({
        method: "POST",
        path: `/api/alerts/${id}/ask-ai`,
        type: "application/json",
        body: {},
      })),
    );
  });
});
