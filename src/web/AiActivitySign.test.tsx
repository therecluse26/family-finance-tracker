import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { AiActivitySign } from "./AiActivitySign.tsx";
import { routes } from "./routes.tsx";

// The live AI status's sign in the main menu (spec 07, Main menu; spec 08, Live AI status), as the
// browser paints it.

function paint(line: string | undefined): string {
  const router = createMemoryRouter([{ path: "/", element: <AiActivitySign line={line} /> }], {
    initialEntries: ["/"],
  });
  return renderToString(<RouterProvider router={router} />);
}

describe("the live AI status's sign", () => {
  it("links its line to Settings, AI, with the accent icon and color beside the words, in a polite live region", () => {
    const html = paint("AI working: Categories");

    expect(html).toMatch(/^<div aria-live="polite" data-slot="ai-activity"[^>]*><a[^>]*>/);
    expect(html).toContain('href="/settings/ai"');
    expect(html).toMatch(
      /<span class="text-accent"><span aria-hidden="true">● <\/span>AI working: Categories<\/span>/,
    );
  });

  it("leaves the live region empty when no background AI works", () => {
    expect(paint(undefined)).toBe(
      '<div aria-live="polite" data-slot="ai-activity" class="min-w-0"></div>',
    );
  });

  it("sits in the main menu, once, before the menu's items, and is empty at first paint", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/transactions"] });
    const html = renderToString(<RouterProvider router={router} />);
    const nav = /<nav[^>]*aria-label="Main menu"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";

    expect(html.match(/data-slot="ai-activity"/g)).toHaveLength(1);
    expect(nav.indexOf('data-slot="ai-activity"')).toBeGreaterThan(-1);
    expect(nav.indexOf('data-slot="ai-activity"')).toBeLessThan(nav.indexOf("<ul"));
    expect(nav).toContain('<div aria-live="polite" data-slot="ai-activity" class="min-w-0"></div>');
  });
});
