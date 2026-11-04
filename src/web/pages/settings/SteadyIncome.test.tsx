import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SteadyIncomeView } from "../../../server/recurring-views.ts";
import { SteadyIncomeForm } from "./SteadyIncome.tsx";

// Steady Income in Settings, Household, as the page paints it.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

const FROM_SERIES: SteadyIncomeView = {
  amount: 600_000,
  detected: 600_000,
  detectedFrom: "Income series",
  typed: null,
};

describe("the Steady Income form", () => {
  it("shows the figure the app found from repeating Income, and a field for another", () => {
    const html = text(renderToString(<SteadyIncomeForm income={FROM_SERIES} onSaved={() => {}} />));

    expect(html).toContain("Steady Income: $6,000 a month.");
    expect(html).toContain("The app found $6,000 a month from Income that repeats");
    expect(html).toContain("A different figure, per month (optional)");
    expect(html).not.toContain("Clear the typed figure");
  });

  it("says when the median of the last 3 complete months stands in", () => {
    const html = text(
      renderToString(
        <SteadyIncomeForm
          income={{ ...FROM_SERIES, detected: 400_000, amount: 400_000, detectedFrom: "median" }}
          onSaved={() => {}}
        />,
      ),
    );

    expect(html).toContain("No repeating Income counts yet");
    expect(html).toContain("the last 3 complete months of Income: $4,000.");
  });

  it("shows a typed figure in use, with a way to clear it", () => {
    const html = text(
      renderToString(
        <SteadyIncomeForm
          income={{ ...FROM_SERIES, amount: 450_000, typed: 450_000 }}
          onSaved={() => {}}
        />,
      ),
    );

    expect(html).toContain("Steady Income: $4,500 a month.");
    expect(html).toContain("A Member typed $4,500.");
    expect(html).toContain("Clear the typed figure");
  });
});
