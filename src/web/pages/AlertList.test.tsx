import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertPartView, AlertView } from "../../server/alerts-views.ts";
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
  alert("waiting", "2026-11-05T01:00:00.000Z", "Price increase", null),
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
      <AlertRows alerts={ALERTS} states={{}} today={TODAY} zone={ZONE} onNotAProblem={() => {}} />,
    );
    const rows = [
      ...html.matchAll(/<li class="mt-4[^>]*>(.*?)<\/li>(?=<li class="mt-4|<\/ul>$)/gs),
    ].map((match) => text(match[1] ?? ""));

    expect(rows).toEqual([
      // 1 AM UTC on Nov 5 is Nov 4 in New York. The Alerts step has not decided it yet.
      "Nov 4 · Price increase Alert waiting. Not a problem",
      "Nov 4 · Over Budget · sent 2 Categories are over Budget Groceries is $40.00 over its Budget. Not a problem Dining is $12.00 over its Budget. AI Plan two meals at home this week. Not a problem",
      "Nov 2 · Large purchase · held back (weekly cap) Alert held. Not a problem",
      "Dec 30, 2025 · Duplicate charge · found in history Alert found. Not a problem",
    ]);
    expect(alertLine(ALERTS[0] as AlertView, TODAY, ZONE)).toBe(
      "Nov 2 · Large purchase · held back (weekly cap)",
    );
  });

  it('says "No Alerts yet." with no Alerts', () => {
    const html = renderToString(
      <AlertRows alerts={[]} states={{}} today={TODAY} zone={ZONE} onNotAProblem={() => {}} />,
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
        .props.children[2].props.children[0];
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
});
