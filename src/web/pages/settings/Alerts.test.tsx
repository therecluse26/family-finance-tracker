import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeeklyCapForm } from "./Alerts.tsx";

// Settings, Alerts, as the browser first paints it.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

describe("Settings, Alerts", () => {
  it("shows the weekly cap for editing, and what it holds back", () => {
    const html = renderToString(<WeeklyCapForm settings={{ weeklyCap: 3 }} onSaved={() => {}} />);

    expect(text(html)).toContain("Weekly cap");
    expect(html).toContain('value="3"');
    expect(text(html)).toContain("Monday to Sunday");
    expect(text(html)).toContain("is never sent later");
    expect(text(html)).toContain("Duplicate charges and card interest or fees always go out.");
    expect(text(html)).toContain("Save the weekly cap");
  });

  it("shows a cap of 0", () => {
    const html = renderToString(<WeeklyCapForm settings={{ weeklyCap: 0 }} onSaved={() => {}} />);

    expect(html).toContain('value="0"');
  });
});
