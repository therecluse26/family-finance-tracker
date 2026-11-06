import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonClass, Segment } from "./Button.tsx";

// The shared buttons of the page boards.

describe("Button", () => {
  it("is a native button with the type its caller names", () => {
    expect(renderToString(<Button type="button">Edit</Button>)).toMatch(
      /^<button type="button" class="[^"]*"[^>]*>Edit<\/button>$/,
    );
    expect(renderToString(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it("passes on disabled, click and aria props", () => {
    const html = renderToString(
      <Button type="button" variant="outlined" disabled aria-describedby="why">
        Skip
      </Button>,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-describedby="why"');
  });

  it("draws primary filled and outlined with a border, from the tokens", () => {
    expect(buttonClass("primary")).toContain("bg-accent");
    expect(buttonClass("primary")).toContain("text-white");
    expect(buttonClass("outlined")).toContain("border-field");
    expect(buttonClass("outlined", "small")).toContain("h-8");
  });
});

describe("Segment", () => {
  it("is a button that says whether it is pressed", () => {
    const html = renderToString(
      <Segment pressed onClick={() => {}}>
        This month
      </Segment>,
    );
    expect(html).toMatch(/^<button type="button" aria-pressed="true"[^>]*>This month<\/button>$/);
  });
});
