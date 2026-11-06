import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Meter } from "./Meter.tsx";

// The meter of Budgets, Goals and Top Merchants.

const width = (html: string, slot: string) =>
  new RegExp(`style="(?:width|left):([^"]*)"[^>]*data-slot="${slot}"`).exec(html)?.[1];

describe("Meter", () => {
  it("fills to its share, and draws a share outside 0 to 1 at the end", () => {
    expect(width(renderToString(<Meter share={0.25} />), "meter-fill")).toBe("25%");
    expect(width(renderToString(<Meter share={1.4} />), "meter-fill")).toBe("100%");
    expect(width(renderToString(<Meter share={-0.2} />), "meter-fill")).toBe("0%");
  });

  it("draws a today tick only when asked", () => {
    expect(renderToString(<Meter share={0.5} />)).not.toContain("meter-today");
    expect(width(renderToString(<Meter share={0.5} today={0.2} />), "meter-today")).toBe("20%");
  });

  it("colors the fill by tone", () => {
    expect(renderToString(<Meter share={0.5} />)).toContain("bg-accent");
    expect(renderToString(<Meter share={0.5} tone="serious" />)).toContain("bg-serious");
    expect(renderToString(<Meter share={0.5} tone="good" />)).toContain("bg-good-bar");
  });

  it("is hidden from screen readers unless it has a label", () => {
    expect(renderToString(<Meter share={0.5} />)).toContain('aria-hidden="true"');
    const labeled = renderToString(<Meter share={0.5} label="38% of the target" />);
    expect(labeled).toContain('role="img"');
    expect(labeled).toContain('aria-label="38% of the target"');
    expect(labeled).not.toContain("aria-hidden");
  });
});
