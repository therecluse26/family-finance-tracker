import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AmazonStatusView } from "../../../server/amazon-views.ts";
import { AmazonCard, deleteAmazonData, uploadAmazonFile, uploadType } from "./Amazon.tsx";

// The Amazon card on Settings → Store orders (spec 14, The Store orders page in Settings), as the
// browser paints it, and the requests it sends.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const EMPTY: AmazonStatusView = {
  lastImport: null,
  lineItems: 0,
  shipments: {
    linked: 0,
    waiting: 0,
    onReviewList: 0,
    notMatched: 0,
    beforeBankHistory: 0,
    giftCard: 0,
  },
};

const STORED: AmazonStatusView = {
  lastImport: {
    importedAt: "2026-11-09T15:30:00.000Z",
    memberName: "Alice",
    rowsRead: 40,
    added: 36,
    updated: 1,
    unchanged: 0,
    skipped: [{ reason: "cancelled", rows: 3, firstRow: 7 }],
  },
  lineItems: 37,
  shipments: {
    linked: 20,
    waiting: 3,
    onReviewList: 1,
    notMatched: 2,
    beforeBankHistory: 4,
    giftCard: 1,
  },
};

const NOW = new Date("2026-11-09T18:00:00.000Z");

const card = (status: AmazonStatusView, extra: Partial<Parameters<typeof AmazonCard>[0]> = {}) =>
  text(
    renderToString(
      <AmazonCard
        status={status}
        zone="America/New_York"
        busy={false}
        onUpload={() => {}}
        onDelete={() => {}}
        now={NOW}
        {...extra}
      />,
    ),
  );

describe("Settings, Store orders: the Amazon card", () => {
  it("shows the steps to get the file and Upload before any file", () => {
    const html = renderToString(
      <AmazonCard
        status={EMPTY}
        zone="America/New_York"
        busy={false}
        onUpload={() => {}}
        onDelete={() => {}}
        now={NOW}
      />,
    );
    const page = text(html);

    // One card, with the store's name as its title.
    expect(html.match(/<h3[^>]*>/g)).toHaveLength(1);
    expect(html).toMatch(/<h3[^>]*>Amazon<\/h3>/);

    expect(page).toContain("Account & Lists → Your Account → Request Your Data");
    expect(page).toContain("Pick Your Orders , then Submit Request");
    expect(page).toContain("Upload the ZIP file here, as it is.");
    expect(page).toContain("Upload");
    expect(page).toContain("No file uploaded yet.");
    expect(page).not.toContain("Delete all Amazon data");
    expect(page).not.toContain("Links to charges");
    expect(page).not.toContain("Before your bank history");
  });

  it("shows the last import with its date and Member, and the link counts", () => {
    const page = card(STORED);

    expect(page).toContain("Nov 9 at 10:30 AM, by Alice.");
    expect(page).toContain("Linked to a charge 20 shipments");
    expect(page).toContain("Waiting for a charge 3 shipments");
    expect(page).toContain("Waiting on the Review list 1 shipment");
    expect(page).toContain("Not matched 2 shipments");
    expect(page).toContain(
      "Before your bank history Shipped before the first charge your banks sent. These cannot link. 4 shipments",
    );
    expect(page.indexOf("Not matched")).toBeLessThan(page.indexOf("Before your bank history"));
    expect(page).toContain("Paid in part by gift card, not linked 1 shipment");
    expect(page).toContain("Delete all Amazon data");
  });

  it("shows a before your bank history count of 0 like the other rows", () => {
    const page = card({ ...STORED, shipments: { ...STORED.shipments, beforeBankHistory: 0 } });

    expect(page).toContain("These cannot link. 0 shipments");
  });

  it("shows what an upload did, with each skip reason and its first row", () => {
    const page = card(STORED, { lastResult: STORED.lastImport ?? undefined });

    expect(page).toContain(
      "40 rows read. 36 Line items added, 1 updated, 0 unchanged. 3 rows skipped.",
    );
    expect(page).toContain("3 rows were skipped: cancelled (first at row 7).");
  });

  it("asks once before it deletes", () => {
    const page = card(STORED, { confirming: true });

    expect(page).toContain("Delete every Line item, every link, and every Item rule?");
    expect(page).toContain("Keep it");
  });

  it("names a removed Member's import without a name", () => {
    const lastImport = STORED.lastImport && { ...STORED.lastImport, memberName: null };
    const page = card({ ...STORED, lastImport });

    expect(page).toContain("Nov 9 at 10:30 AM.");
  });
});

describe("Settings, Store orders: the Amazon card's requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("picks the upload's content type by the file's name", () => {
    expect(uploadType("amazon-orders.ZIP")).toBe("application/zip");
    expect(uploadType("Order History.csv")).toBe("text/csv");
    expect(uploadType("photo.jpeg")).toBeUndefined();
  });

  it("sends the file as the raw body with its content type, and the delete with none", async () => {
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
    const file = new Blob(["PK"]);

    await uploadAmazonFile(file, "application/zip");
    await deleteAmazonData();

    expect(requests).toEqual([
      { method: "POST", path: "/api/amazon/import", type: "application/zip", body: file },
      { method: "DELETE", path: "/api/amazon", type: null, body: undefined },
    ]);
  });
});
