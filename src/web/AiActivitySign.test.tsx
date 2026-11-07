import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { AiActivitySign } from "./AiActivitySign.tsx";
import { AI_WORK_FINISHED, AI_WORKING, aiActivityAnnouncement } from "./ai-activity.ts";
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
  it("links its line to Settings, AI, with the accent icon and color beside the words, outside the live region", () => {
    const html = paint("AI working: Categories");

    expect(html).toMatch(
      /^<div data-slot="ai-activity" class="min-w-0"><span aria-live="polite" class="sr-only">AI working<\/span><a[^>]*>/,
    );
    expect(html).toContain('href="/settings/ai"');
    expect(html).toMatch(
      /<span class="text-accent"><span aria-hidden="true">● <\/span>AI working: Categories<\/span>/,
    );
  });

  it("keeps a run's percent whole beside the words, so only the words shorten", () => {
    const html = paint("AI working: Categories · 47%");
    expect(html).toContain(
      '<span class="min-w-0 truncate"><span class="text-accent"><span aria-hidden="true">● </span>AI working: Categories</span></span><span class="shrink-0 whitespace-pre text-accent"> · 47%</span>',
    );
  });

  it("leaves the live region empty when no background AI works", () => {
    expect(paint(undefined)).toBe(
      '<div data-slot="ai-activity" class="min-w-0"><span aria-live="polite" class="sr-only"></span></div>',
    );
  });

  it("says only that AI work started, never the step, however the line changes", () => {
    for (const line of [
      "AI working: Categories",
      "AI working: Merchants",
      "AI working: history, 3 of 12",
    ]) {
      expect(aiActivityAnnouncement(line, false)).toBe(AI_WORKING);
      expect(aiActivityAnnouncement(line, true)).toBe(AI_WORKING);
      expect(paint(line)).toContain('<span aria-live="polite" class="sr-only">AI working</span>');
    }
    expect(AI_WORKING).toBe("AI working");
  });

  it("says that AI work finished when the sign hides after it showed, and nothing before it first shows", () => {
    expect(aiActivityAnnouncement(undefined, true)).toBe(AI_WORK_FINISHED);
    expect(AI_WORK_FINISHED).toBe("AI work finished");
    expect(aiActivityAnnouncement(undefined, false)).toBe("");
  });

  it("sits in the main menu, once, before the menu's items, and is empty at first paint", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/transactions"] });
    const html = renderToString(<RouterProvider router={router} />);
    const nav = /<nav[^>]*aria-label="Main menu"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";

    expect(html.match(/data-slot="ai-activity"/g)).toHaveLength(1);
    expect(nav.indexOf('data-slot="ai-activity"')).toBeGreaterThan(-1);
    expect(nav.indexOf('data-slot="ai-activity"')).toBeLessThan(nav.indexOf("<ul"));
    expect(nav).toContain(
      '<div data-slot="ai-activity" class="min-w-0"><span aria-live="polite" class="sr-only"></span></div>',
    );
  });
});
