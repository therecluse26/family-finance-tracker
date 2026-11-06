import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiUsageView, AiView } from "../../../ai/ai-view.ts";
import { atCap } from "../../../ai/usage-view.ts";
import {
  AiProviderForm,
  AiStatusLine,
  COST_CAP_SAVED,
  CostCapForm,
  centsOfText,
  dataUseLine,
  enteredPrices,
  priceOfText,
  saveCostCap,
  spentShare,
  statusLine,
  todayHere,
} from "./Ai.tsx";
import { AiUsageReport } from "./AiUsage.tsx";

// Settings → AI, as the browser paints it once the AI settings have loaded.

const OPENAI: AiView = {
  provider: "openai",
  keySet: true,
  baseUrl: null,
  gatewayTokenSet: false,
  quickModel: "gpt-6-luna",
  writerModel: "gpt-6.1-terra",
  prices: { quick: { source: "table" }, writer: { source: "table" } },
  status: { state: "on" },
};

// A month at $3.12 of $10.00, with one Chat call and one check on save.
const USAGE: AiUsageView = {
  month: "2026-11",
  totalNanos: 3_120_000_000,
  capCents: 1000,
  pausedUntil: null,
  byUse: [
    { use: "chat", calls: 1, costNanos: 3_119_979_000 },
    { use: "check on save", calls: 2, costNanos: 21_000 },
  ],
  calls: [
    {
      id: 3,
      use: "chat",
      model: "claude-sonnet-5-5",
      noCacheTokens: 1200,
      cacheReadTokens: 2500,
      cacheWriteTokens: 0,
      outputTokens: 310,
      costNanos: 6_350_000,
      at: "2026-11-20T13:15:00.000Z",
    },
  ],
};

const routed = (page: ReactNode) => renderToString(<MemoryRouter>{page}</MemoryRouter>);

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

describe("Settings → AI", () => {
  it("shows each status line", () => {
    const today = "2026-11-20";

    expect(statusLine({ state: "on" }, today)).toBe("AI is on");
    expect(statusLine({ state: "waits for history" }, today)).toBe("AI waits for history to load");
    expect(statusLine({ state: "cost cap", until: "2026-12-01" }, today)).toBe(
      "AI paused until Dec 1: AI cost cap reached",
    );
    expect(statusLine({ state: "key rejected" }, today)).toBe(
      "AI paused: the AI provider rejected the key",
    );
    expect(text(renderToString(<AiStatusLine ai={OPENAI} today={today} />))).toBe("✓ AI is on");
  });

  it("takes today in the Household time zone, not in UTC", () => {
    // 9 PM in New York on Dec 31 is already Jan 1 in UTC, so a pause into January is next year.
    const evening = new Date("2027-01-01T02:00:00Z");
    const today = todayHere(evening, "America/New_York");

    expect(today).toBe("2026-12-31");
    expect(statusLine({ state: "cost cap", until: "2027-01-05" }, today)).toBe(
      "AI paused until Jan 5, 2027: AI cost cap reached",
    );
  });

  it("starts a new AI provider on Anthropic's default models, with the key as a password field", () => {
    const html = renderToString(<AiProviderForm ai={null} onSaved={() => {}} />);

    expect(html).toContain('value="claude-haiku-5-5"');
    expect(html).toContain('value="claude-sonnet-5-5"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain("Anthropic workspace limit");
    expect(text(html)).toContain("The app does not check it.");
  });

  it("shows only that the key is set, the saved models, and a link to the OpenAI project limit", () => {
    const html = renderToString(<AiProviderForm ai={OPENAI} onSaved={() => {}} />);

    expect(html).toContain('placeholder="Set. Enter a new key to change it."');
    expect(html).toContain('value="gpt-6-luna"');
    expect(html).toContain('value="gpt-6.1-terra"');
    expect(html).toContain('href="https://platform.openai.com/settings/organization/projects"');
  });

  it("says the app cannot check an OpenAI-compatible endpoint's data use", () => {
    const html = renderToString(
      <AiProviderForm
        ai={{
          ...OPENAI,
          provider: "openai-compatible",
          keySet: false,
          baseUrl: "http://ollama.local:11434/v1",
          quickModel: "llama-small",
          writerModel: "llama-large",
        }}
        onSaved={() => {}}
      />,
    );

    expect(text(html)).toContain("The app cannot check this endpoint");
    expect(text(html)).not.toContain("usage limit");
  });

  it("names each AI provider's data-use setting, and the gateway's", () => {
    expect(dataUseLine("openai", null)).toContain("store: false");
    expect(dataUseLine("openrouter", null)).toContain("data_collection: deny");
    expect(dataUseLine("anthropic", null)).toContain("never sends it feedback");
    expect(
      dataUseLine("anthropic", "https://gateway.ai.cloudflare.com/v1/a/g/anthropic"),
    ).toContain("Cloudflare AI Gateway");
  });

  it("asks for the gateway token only with a Cloudflare AI Gateway base URL", () => {
    const plain = renderToString(<AiProviderForm ai={OPENAI} onSaved={() => {}} />);
    const gateway = renderToString(
      <AiProviderForm
        ai={{ ...OPENAI, baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/openai" }}
        onSaved={() => {}}
      />,
    );

    expect(text(plain)).not.toContain("Gateway token");
    expect(text(gateway)).toContain("Gateway token");
  });

  it("asks for prices only for a model not in the price table, and fills in the stored ones", () => {
    const table = renderToString(<AiProviderForm ai={OPENAI} onSaved={() => {}} />);
    const custom = renderToString(
      <AiProviderForm
        ai={{
          ...OPENAI,
          quickModel: "gpt-6-luna-mini",
          prices: {
            quick: { source: "member", input: 50_000, output: 250_000 },
            writer: { source: "table" },
          },
        }}
        onSaved={() => {}}
      />,
    );

    expect(text(table)).not.toContain("Prices, in dollars per million tokens");
    expect(text(custom)).toContain("Quick model (gpt-6-luna-mini): input price");
    expect(text(custom)).not.toContain("Writer model (gpt-6.1-terra)");
    expect(text(custom)).toContain("Cache reads and writes count at the input price.");
    expect(custom).toContain('value="0.05"');
    expect(custom).toContain('value="0.25"');
  });

  it("reads prices and the cap as a Member types them", () => {
    expect(priceOfText("0.50")).toBe(500_000);
    expect(priceOfText("$2")).toBe(2_000_000);
    expect(priceOfText("0")).toBe(0);
    expect(priceOfText("-1")).toBeUndefined();
    expect(priceOfText("abc")).toBeUndefined();
    expect(centsOfText("10")).toBe(1000);
    expect(centsOfText("$12.50")).toBe(1250);
    expect(centsOfText("12.505")).toBeUndefined();

    const models = { quick: "llama-small", writer: "gpt-6.1-terra" };
    const empty = { input: "", output: "" };
    expect(
      enteredPrices("openai", models, { quick: { input: "0", output: "0" }, writer: empty }),
    ).toEqual({ quick: { input: 0, output: 0 } });
    expect(enteredPrices("openai", models, { quick: empty, writer: empty })).toEqual({});
    expect(
      enteredPrices("openai", models, { quick: { input: "0.1", output: "" }, writer: empty }),
    ).toBe("bad");
  });

  it("shows the AI cost cap, the month's total against it, and a link to the AI usage page", () => {
    const html = routed(<CostCapForm usage={USAGE} today="2026-11-20" onSaved={() => {}} />);

    expect(text(html)).toContain("This month: $3.12 of $10.00");
    expect(html).toContain('value="10"');
    expect(html).toContain('href="/settings/ai/usage"');
    expect(html).toContain("bg-accent");
    expect(text(html)).not.toContain("AI paused");
  });

  it("fills the cost cap bar just when the server's cap check pauses AI, from exact amounts", () => {
    const cases = [
      { totalNanos: 0, capCents: 0 },
      { totalNanos: 1, capCents: 0 },
      { totalNanos: 0, capCents: 1000 },
      // Rounds to $10.00, but is still under the cap.
      { totalNanos: 9_999_999_999, capCents: 1000 },
      { totalNanos: 10_000_000_000, capCents: 1000 },
      { totalNanos: 10_000_000_001, capCents: 1000 },
    ];
    for (const amounts of cases) {
      const share = spentShare({ ...USAGE, ...amounts });
      expect(share >= 1, JSON.stringify(amounts)).toBe(atCap(amounts.totalNanos, amounts.capCents));
    }
    expect(spentShare({ ...USAGE, totalNanos: 5_000_000_000, capCents: 1000 })).toBe(0.5);
  });

  it("shows the paused status on a serious bar at the cap, and a $0 cap as full", () => {
    const paused = { ...USAGE, totalNanos: 0, capCents: 0, pausedUntil: "2026-12-01" };
    const html = routed(<CostCapForm usage={paused} today="2026-11-20" onSaved={() => {}} />);

    expect(text(html)).toContain("◆ AI paused until Dec 1");
    expect(html).toMatch(/bg-serious[^"]*" style="width:100%"/);
  });
});

describe("Settings → AI → AI usage", () => {
  it("lists each call's use, model, token counts, cost, and time, and the month's totals", () => {
    const html = renderToString(
      <AiUsageReport usage={USAGE} zone="America/New_York" today="2026-11-20" />,
    );
    const cells = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((match) => text(match[1] ?? ""));

    expect(text(html)).toContain("$3.12 of $10.00 this month");
    expect(cells).toEqual([
      "Chat",
      "1",
      "$3.1200",
      "Check on save",
      "2",
      "under $0.0001",
      "Nov 20, 8:15 AM",
      "Chat",
      "claude-sonnet-5-5",
      "1,200",
      "2,500",
      "0",
      "310",
      "$0.0064",
    ]);
  });

  it("says when background AI is paused, and when no call was made", () => {
    const html = renderToString(
      <AiUsageReport
        usage={{ ...USAGE, pausedUntil: "2026-12-01", byUse: [], calls: [] }}
        zone="America/New_York"
        today="2026-11-20"
      />,
    );

    expect(text(html)).toContain("AI paused until Dec 1: AI cost cap reached");
    expect(text(html)).toContain("No AI calls this month.");
  });
});

describe("Settings → AI: Save cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A server that answers PUT /api/ai/cost-cap with `status` and `body`, and records each request.
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

  it("says the cap is saved, as the Alerts and email forms do, with the new usage", async () => {
    const saved = { ...USAGE, capCents: 700 };
    const sent = server(200, { usage: saved });

    expect(COST_CAP_SAVED).toBe("The AI cost cap is saved.");
    expect(await saveCostCap("7")).toEqual({ usage: saved, saved: COST_CAP_SAVED });
    expect(sent).toEqual([{ method: "PUT", path: "/api/ai/cost-cap", body: '{"capCents":700}' }]);
  });

  it("says nothing is saved when the server refuses, or the cap is not an amount", async () => {
    server(400, { error: "The cap is too high." });
    expect(await saveCostCap("7")).toEqual({ error: "The cap is too high." });

    const sent = server(200, { usage: USAGE });
    for (const typed of ["seven", "10000.01"]) {
      expect(await saveCostCap(typed)).toEqual({
        error: "Enter the AI cost cap in dollars, from $0 to $10,000.",
      });
    }
    expect(sent).toEqual([]);
  });
});
