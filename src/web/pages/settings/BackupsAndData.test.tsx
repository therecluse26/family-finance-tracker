import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupsView } from "../../../server/backups-views.ts";
import {
  BackupLines,
  backUpNow,
  DownloadMyData,
  downloadMyData,
  exportFileName,
  sizeLabel,
} from "./BackupsAndData.tsx";

// Settings, Backups and data: the backup lines as the browser first paints them, and the request
// "Back up now" sends.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

const NO_BACKUP: BackupsView = {
  folder: "/backups",
  readable: true,
  lastBackupAt: null,
  files: 0,
  bytes: 0,
};

describe("Settings, Backups and data: backups", () => {
  it("shows the folder in use, and says when there is no backup yet", () => {
    const html = text(renderToString(<BackupLines backups={NO_BACKUP} />));

    expect(html).toContain("Backups go to /backups.");
    expect(html).toContain("No backup yet.");
  });

  it("shows the last backup, the number of files, and their total size", () => {
    // The time shows in this browser's time zone, so the test reads any hour.
    const html = text(
      renderToString(
        <BackupLines
          backups={{
            folder: "/data/backups",
            readable: true,
            lastBackupAt: "2026-11-02T03:00:00.000Z",
            files: 10,
            bytes: 32_400_000,
          }}
          now={new Date("2026-11-02T12:00:00.000Z")}
        />,
      ),
    );

    expect(html).toContain("Backups go to /data/backups.");
    expect(html).toMatch(
      /Last backup: Nov [12] at \d{1,2}:\d{2} [AP]M\. 10 files, 32\.4 MB in all\./,
    );
  });

  it("says when the app cannot read the backup folder", () => {
    const html = text(renderToString(<BackupLines backups={{ ...NO_BACKUP, readable: false }} />));

    expect(html).toContain("The app cannot read the backup folder.");
  });

  it.each([
    [512, "512 bytes"],
    [820_400, "820 KB"],
    [3_210_000, "3.2 MB"],
  ])("writes %i bytes as %s", (bytes, label) => {
    expect(sizeLabel(bytes)).toBe(label);
  });
});

// POST /api/backups/now answers 415 without a JSON content type, so the page must send one.
// src/server/backups-api.test.ts sends this same request.
describe("Settings, Backups and data: the request Back up now sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an empty JSON body", async () => {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await backUpNow();

    expect(requests).toEqual([
      { method: "POST", path: "/api/backups/now", type: "application/json", body: "{}" },
    ]);
  });
});

// POST /api/export answers 415 without a JSON content type, so the page must send one.
// src/server/data-export-api.test.ts sends this same request.
describe("Settings, Backups and data: Download my data", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the file is not encrypted before the download, and asks for a code", () => {
    const html = text(renderToString(<DownloadMyData />));

    expect(html).toContain("The file is not encrypted.");
    expect(html).toContain("enter a code from your authenticator app, or a backup code");
    expect(html.indexOf("not encrypted")).toBeLessThan(html.lastIndexOf("Download my data"));
  });

  it("sends the code as JSON", async () => {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("", { headers: { "content-type": "application/zip" } });
    });

    await downloadMyData("123456");

    expect(requests).toEqual([
      { method: "POST", path: "/api/export", type: "application/json", body: '{"code":"123456"}' },
    ]);
  });

  it("names the file as the server does, with plain characters only", () => {
    const named = (disposition: string) =>
      exportFileName(new Response("", { headers: { "content-disposition": disposition } }));

    expect(named('attachment; filename="family-finance-data-2026-11-05.zip"')).toBe(
      "family-finance-data-2026-11-05.zip",
    );
    expect(named('attachment; filename="../x y.zip"')).toBe("family-finance-data.zip");
  });
});
