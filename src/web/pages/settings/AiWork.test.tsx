import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_WORK_WAIT_LINES, type AiWorkView } from "../../../redo/work-view.ts";
import {
  AiWorkCard,
  AiWorkLine,
  AiWorkProgress,
  ALL_HISTORY_CONFIRM,
  AllHistoryConfirm,
  aiWorkLine,
  pressAiWork,
} from "./AiWork.tsx";

// Settings → AI: AI work on your Transactions (spec 08), as the browser paints it.

const ZONE = "America/New_York";
// 3:30 PM in New York on Nov 6, 2026.
const NOW = new Date("2026-11-06T20:30:00.000Z");

const IDLE: AiWorkView = { running: null, waits: null, retryAt: null, waiting: 0, lastRun: null };

describe("Settings → AI: the AI work status line", () => {
  it("says the step of a run that goes on, before anything else", () => {
    expect(
      aiWorkLine(
        { ...IDLE, running: { kind: "finish", step: "Categories" }, waits: "cost cap" },
        ZONE,
        NOW,
      ),
    ).toEqual({ tone: "accent", text: "AI work is running: Categories" });
  });

  it("says why AI work waits, each with its own tone", () => {
    const tones = {
      "no AI provider": "muted",
      "key rejected": "critical",
      "cost cap": "serious",
      "waits for history": "accent",
      "no price": "critical",
    } as const;
    for (const [waits, tone] of Object.entries(tones) as [keyof typeof tones, string][]) {
      expect(aiWorkLine({ ...IDLE, waits }, ZONE, NOW)).toEqual({
        tone,
        text: AI_WORK_WAIT_LINES[waits],
      });
    }
    expect(AI_WORK_WAIT_LINES["cost cap"]).toBe("AI work waits: AI cost cap reached");
  });

  it("names the time the AI tries again, in Household time, while a use the run calls waits for its retry", () => {
    // 8:41 PM UTC is 3:41 PM in New York.
    expect(
      aiWorkLine({ ...IDLE, waits: "retry wait", retryAt: "2026-11-06T20:41:00.000Z" }, ZONE, NOW),
    ).toEqual({ tone: "serious", text: "AI work waits: AI tries again at 3:41 PM" });
  });

  it("says the last run in Household time, and how many items the run decided and how many Categories the AI answered", () => {
    // 8:12 PM UTC is 3:12 PM in New York.
    const at = "2026-11-06T20:12:00.000Z";
    expect(
      aiWorkLine(
        { ...IDLE, lastRun: { at, items: 214, aiCategories: 180, outcome: "finished" } },
        ZONE,
        NOW,
      ),
    ).toEqual({
      tone: "good",
      text: "Last run Nov 6 at 3:12 PM: 214 items decided, and the AI answered 180 Categories",
    });
    expect(
      aiWorkLine(
        {
          ...IDLE,
          lastRun: {
            at: "2026-11-02T13:05:00.000Z",
            items: 1,
            aiCategories: 1,
            outcome: "stopped",
          },
        },
        ZONE,
        NOW,
      ),
    ).toEqual({
      tone: "serious",
      text: "Last run Nov 2 at 8:05 AM stopped: 1 item decided, and the AI answered 1 Category",
    });
    expect(aiWorkLine(IDLE, ZONE, NOW)).toEqual({
      tone: "muted",
      text: "No AI work has run yet",
    });
  });

  it("paints the line with an icon and a color beside its words", () => {
    const html = renderToString(
      <AiWorkLine work={{ ...IDLE, waits: "key rejected" }} zone={ZONE} now={NOW} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("text-critical");
    expect(html).toContain("AI work waits: the AI provider rejected the key");
  });
});

describe("Settings → AI: the AI work progress bar", () => {
  it("shows the items, the step and its place, and the time left, on a progress bar", () => {
    const html = renderToString(
      <AiWorkProgress
        run={{
          kind: "finish",
          step: "Categories",
          progress: { before: 2_654, done: 1_240, place: 2, steps: 3, minutesLeft: 4 },
        }}
      />,
    );
    expect(html).toContain("1,240 of 2,654 items · Step 2 of 3: Categories · about 4 min left");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="46"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-label="AI work"');
    expect(html).toContain("width:46%");
  });

  it("says less than a minute below one minute, and no time before the run knows it", () => {
    const run = (minutesLeft: number | null) =>
      renderToString(
        <AiWorkProgress
          run={{
            kind: null,
            step: "Money movement",
            progress: { before: 100, done: 90, place: 2, steps: 3, minutesLeft },
          }}
        />,
      );
    expect(run(0)).toContain(
      "90 of 100 items · Step 2 of 3: Money movement · less than a minute left",
    );
    expect(run(null)).toContain("90 of 100 items · Step 2 of 3: Money movement</p>");
  });

  it("shows nothing before the run counts its items", () => {
    expect(renderToString(<AiWorkProgress run={{ kind: "finish", step: "starting" }} />)).toBe("");
  });
});

describe("Settings → AI: the AI work buttons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A server that answers every request with `status` and `body`, and records each request.
  function server(status: number, body: unknown) {
    const sent: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push({ method: init.method ?? "GET", path: String(input), body: init.body });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return sent;
  }

  it("shows both buttons under the card's title", () => {
    const html = renderToString(<AiWorkCard />);
    expect(html).toContain("AI work on your Transactions");
    expect(html).toContain("Finish AI work now");
    expect(html).toContain("Run AI on all history");
    expect(html).toContain('aria-expanded="false"');
  });

  it("asks before a run on all history, with what it does and its cost against the cap", () => {
    expect(ALL_HISTORY_CONFIRM).toContain("each Transaction in the last 18 months");
    expect(ALL_HISTORY_CONFIRM).toContain("even one the bank or the Merchant's history chose.");
    expect(ALL_HISTORY_CONFIRM).toContain("Hand-set Categories and Category rules still win.");
    expect(ALL_HISTORY_CONFIRM).toContain(
      "It costs about $0.10, and the cost counts against the AI cost cap.",
    );
    const html = renderToString(
      <AllHistoryConfirm busy={false} onRun={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Run AI on all history?");
    expect(html).toContain("Cancel");
    expect(html).toContain("$0.10");
  });

  it("posts an empty body to each button's route, and answers the status line after it", async () => {
    const work: AiWorkView = { ...IDLE, running: { kind: "finish", step: "starting" } };
    const sent = server(202, { work });

    expect(await pressAiWork("finish")).toEqual({ work });
    expect(await pressAiWork("all history")).toEqual({ work });
    expect(sent).toEqual([
      { method: "POST", path: "/api/ai/work/finish", body: "{}" },
      { method: "POST", path: "/api/ai/work/all-history", body: "{}" },
    ]);
  });

  it("answers the server's words for a refusal", async () => {
    server(409, { error: "AI work is running. Wait for it to finish." });
    expect(await pressAiWork("finish")).toEqual({
      error: "AI work is running. Wait for it to finish.",
    });

    server(500, "not JSON words");
    expect(await pressAiWork("all history")).toEqual({ error: "That did not work." });
  });
});
