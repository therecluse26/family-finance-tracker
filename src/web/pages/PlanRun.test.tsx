import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanRunCost, PlanRunView } from "../../deal-finder/run-view.ts";
import { loadPlanRun, PlanRunControls, PlanRunPanel, startPlanRun } from "./PlanRunButton.tsx";
import { costWords, PlanRunConfirm } from "./PlanRunConfirm.tsx";
import { PlanRunProgress } from "./PlanRunProgress.tsx";

// "Find the best prices" (spec 15, The Shopping plan) as the browser paints it: the button, the
// cost to confirm before a full search, and each Store's progress. Every Store and cost is made
// up.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const COST: PlanRunCost = {
  fullSearch: true,
  costNanos: 42_500_000,
  monthCostNanos: 120_000_000,
  capCents: 500,
};

const RUNNING: PlanRunView = {
  planId: "plan-1",
  running: true,
  phase: "reading",
  startedAt: "2026-11-11T15:00:00.000Z",
  finishedAt: null,
  stores: [
    { storeId: "kroger", name: "Kroger", state: "read", reason: null },
    { storeId: "walmart", name: "Walmart", state: "reading", reason: null },
    { storeId: "aldi", name: "Aldi", state: "skipped", reason: "Needs your ZIP code" },
    { storeId: "costco", name: "Costco", state: "failed", reason: "Could not read this store" },
    { storeId: "target", name: "Target", state: "waiting", reason: null },
  ],
};

const noop = () => undefined;

describe("the Find the best prices button", () => {
  it("starts a plan run, and is off while one runs or its cost waits to be confirmed", () => {
    const button = (run: PlanRunView | null, confirming: boolean) =>
      renderToString(
        <PlanRunControls run={run} busy={false} confirming={confirming} onStart={noop} />,
      );
    const idle = button(null, false);
    const running = button(RUNNING, false);
    const confirming = button(null, true);

    expect(text(idle)).toBe("Find the best prices");
    expect(idle).not.toContain('disabled=""');
    expect(text(running)).toBe("Finding the best prices…");
    expect(running).toContain('disabled=""');
    expect(text(confirming)).toBe("Find the best prices");
    expect(confirming).toContain('disabled=""');
  });
});

describe("the plan run panel under the heading", () => {
  const panel = (fields: { run?: PlanRunView | null; cost?: PlanRunCost; error?: string }) =>
    renderToString(
      <PlanRunPanel
        run={fields.run ?? null}
        cost={fields.cost}
        busy={false}
        error={fields.error}
        poll="polling"
        onConfirm={noop}
        onCancel={noop}
      />,
    );

  it("shows the cost to confirm before a full search", () => {
    expect(text(panel({ cost: COST }))).toBe(
      "This plan run searches each Store for new List items. It should cost about $0.05 in Price source fees. $0.12 spent this month, $4.88 left under the $5.00 cap. Find the best prices for $0.05 Cancel",
    );
  });

  it("shows each Store's progress and the error, and nothing with neither", () => {
    expect(text(panel({ run: RUNNING }))).toContain("Reading Store prices. Kroger ✓ Prices read");
    expect(text(panel({ error: "The server did not answer." }))).toBe("The server did not answer.");
    expect(panel({})).toBe("");
  });
});

describe("the cost to confirm", () => {
  it("rounds a cost up to the cent, so a cost under a cent never shows as nothing", () => {
    expect(costWords(0)).toBe("$0.00");
    expect(costWords(1)).toBe("$0.01");
    expect(costWords(10_000_000)).toBe("$0.01");
    expect(costWords(10_000_001)).toBe("$0.02");
  });

  it("shows nothing left once the month passed the cap", () => {
    const html = renderToString(
      <PlanRunConfirm
        cost={{ ...COST, monthCostNanos: 6_000_000_000 }}
        busy={true}
        onConfirm={noop}
        onCancel={noop}
      />,
    );

    expect(text(html)).toContain("$6.00 spent this month, $0.00 left under the $5.00 cap.");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("each Store's progress", () => {
  it("shows each Store's state with its icon and word, and the reason it was not read", () => {
    const html = renderToString(<PlanRunProgress run={RUNNING} poll="polling" />);

    expect(text(html)).toBe(
      [
        "Reading Store prices.",
        "Kroger ✓ Prices read",
        "Walmart ● Reading prices",
        "Aldi ● Skipped Needs your ZIP code",
        "Costco ◆ Failed Could not read this store",
        "Target ● Waiting",
      ].join(" "),
    );
  });

  it("says how the run ended, and when the page stopped reading its progress", () => {
    const done = renderToString(
      <PlanRunProgress run={{ ...RUNNING, running: false, phase: "done" }} poll="ended" />,
    );
    const failed = renderToString(
      <PlanRunProgress
        run={{ ...RUNNING, running: false, phase: "failed", stores: [] }}
        poll="ended"
      />,
    );
    const gaveUp = renderToString(<PlanRunProgress run={RUNNING} poll="gave up" />);

    expect(text(done)).toContain("The plan run is done.");
    expect(text(failed)).toBe("The plan run failed. Press Find the best prices to try again.");
    expect(text(gaveUp)).toContain("Still working. Reload the page to see its progress.");
  });
});

describe("the plan run requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the progress, and sends a start as JSON with the cost the Member confirmed", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await loadPlanRun();
    await startPlanRun();
    await startPlanRun(42_500_000);

    expect(requests).toEqual([
      { method: "GET", path: "/api/shopping-plan/run", body: undefined },
      { method: "POST", path: "/api/shopping-plan/run", body: {} },
      { method: "POST", path: "/api/shopping-plan/run", body: { confirmedCostNanos: 42_500_000 } },
    ]);
  });
});
