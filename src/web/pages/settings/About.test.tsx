import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import FILE from "../../../../docs/data-sources.md?raw";
import type { AboutView, UpdateCheckView } from "../../../server/about-views.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { AboutDetails } from "./About.tsx";
import { cpiFetchText, DataSourcesPage } from "./DataSources.tsx";

// Settings, About and the Data sources page, as the browser first paints them.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const NO_UPDATE: UpdateCheckView = { on: true, checkedAt: null, update: null, lastFailure: null };

const ABOUT: AboutView = {
  version: "1.2.0",
  sourceCode: "https://github.com/some-fork/fft-fork/tree/v1.2.0",
  thirdPartyNotices: "/third-party-notices.txt",
  updateCheck: NO_UPDATE,
  dataSources: { cpiFetchedAt: null, benchmarkNotice: "Sample numbers, not real data" },
};

function render(element: React.JSX.Element): string {
  const router = createMemoryRouter([{ path: "*", element }]);
  return renderToString(<RouterProvider router={router} />);
}

const NOW = new Date("2026-11-04T17:00:00.000Z");

describe("Settings, About", () => {
  it("shows the version, the Source code link, the third-party notices, and the Data sources page", () => {
    const html = render(<AboutDetails about={ABOUT} now={NOW} />);

    expect(text(html)).toContain("Version 1.2.0");
    expect(html).toContain('href="https://github.com/some-fork/fft-fork/tree/v1.2.0"');
    expect(text(html)).toContain("Source code");
    expect(html).toContain('href="/third-party-notices.txt"');
    expect(html).toContain('href="/settings/about/data-sources"');
    expect(text(html)).toContain("The app has not checked for an update yet.");
    expect(text(html)).toContain("The check sends no Household data.");
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
  });

  it("shows a newer minor version as Update available, with no compose.yaml change", () => {
    const update = {
      version: "1.3.0",
      newMajor: false,
      imageMajor: { now: 1, update: 1 },
      releaseNotes: "https://github.com/some-fork/fft-fork/releases/tag/v1.3.0",
    };
    const html = render(
      <AboutDetails about={{ ...ABOUT, updateCheck: { ...NO_UPDATE, update } }} now={NOW} />,
    );

    expect(text(html)).toContain("Update available: version 1.3.0.");
    expect(text(html)).not.toContain("compose.yaml");
  });

  it("says a new major version needs a new image version in compose.yaml, and links the release notes", () => {
    const update = {
      version: "2.0.0",
      newMajor: true,
      imageMajor: { now: 1, update: 2 },
      releaseNotes: "https://github.com/some-fork/fft-fork/releases/tag/v2.0.0",
    };
    const html = render(
      <AboutDetails about={{ ...ABOUT, updateCheck: { ...NO_UPDATE, update } }} now={NOW} />,
    );

    expect(text(html)).toContain("Update available: version 2.0.0.");
    expect(text(html)).toContain(
      "This is a new major version. Change the image version in compose.yaml from :1 to :2, then update.",
    );
    expect(html).toContain('href="https://github.com/some-fork/fft-fork/releases/tag/v2.0.0"');
  });

  it("shows the last check, a failure, and the switch off", () => {
    const checked = render(
      <AboutDetails
        about={{
          ...ABOUT,
          updateCheck: {
            ...NO_UPDATE,
            checkedAt: "2026-11-03T10:00:00.000Z",
            lastFailure: "rate limited",
          },
        }}
        now={NOW}
      />,
    );
    expect(text(checked)).toContain("No update. The app last checked on Nov 3.");
    expect(text(checked)).toContain(
      "The last check failed: GitHub asked the app to wait. The app tries again tomorrow.",
    );

    const off = render(
      <AboutDetails about={{ ...ABOUT, updateCheck: { ...NO_UPDATE, on: false } }} now={NOW} />,
    );
    expect(text(off)).toContain("The Update check is off.");
    expect(off).not.toMatch(/type="checkbox"[^>]*checked=""/);
  });
});

describe("the Data sources page", () => {
  it("renders the text of docs/data-sources.md, with the sample label and the CPI fetch date", () => {
    const html = render(
      <DataSourcesPage
        dataSources={{
          cpiFetchedAt: "2026-10-20T11:00:00.000Z",
          benchmarkNotice: "Sample numbers, not real data",
        }}
        now={NOW}
      />,
    );
    const shown = text(html);

    expect(shown).toContain("Sample numbers, not real data");
    expect(shown).toContain("The app last fetched the CPI from BLS on Oct 20.");
    expect(shown).toContain(
      "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.",
    );
    expect(shown).toContain("No agency named on this page endorses this app");
    expect(shown).toContain("The government numbers are public domain.");
    expect(shown).toContain("Our own work is under the AGPL.");
    // Each source row of the file, with its agency, table, and data date.
    const rows = FILE.split("\n").filter((line) => /^\| (Bureau|U\.S\.|National)/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const [agency = "", table = "", date = ""] = row
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      expect(shown).toContain(`${agency}${table.replace(/\[([^\]]+)\]\([^)]+\)/, "$1")}${date}`);
    }
    for (const heading of FILE.split("\n").filter((line) => line.startsWith("## "))) {
      expect(html).toContain(`<h3 class="mt-6 text-lg font-semibold">${heading.slice(3)}</h3>`);
    }
    expect(html).not.toContain("sources:start");
  });

  it("says when the app has not fetched the CPI yet, and shows no label for a real snapshot", () => {
    const html = render(
      <DataSourcesPage dataSources={{ cpiFetchedAt: null, benchmarkNotice: null }} now={NOW} />,
    );

    expect(text(html)).toContain(
      "The app has not fetched the CPI from BLS yet. It uses the CPI values shipped with this release.",
    );
    expect(cpiFetchText("2025-12-20T11:00:00.000Z", NOW)).toBe(
      "The app last fetched the CPI from BLS on Dec 20, 2025.",
    );
  });
});

describe("the Markdown renderer", () => {
  it("builds elements, never markup, and links only https:// addresses", () => {
    const html = renderToString(
      <Markdown
        text={[
          "# Title",
          "",
          'A <script>alert("x")</script> line with **bold**, `code`, and [a link](https://example.org/a).',
          "",
          "- [plain](javascript:alert(1))",
          "- [web](http://example.org)",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h2");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.org/a"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="http://example.org"');
    expect(text(html)).toContain("plain");
  });
});
