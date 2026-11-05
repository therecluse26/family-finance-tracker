import { expect } from "vitest";
import { readZip } from "../../server/testing.ts";
import { REQUEST_LIMIT_MS, timedCase } from "../index.ts";

// The whole 5-year ZIP streams as the browser reads it. Its limit is a download's, not a request's.
const WHOLE_ZIP_LIMIT_MS = 3_000;

// "Download my data" (spec 11, Data export) over 5 years of Transactions. The body is a ZIP, not
// JSON, so the case times it as jobs: the request until the response starts, with the request
// limit, then the whole ZIP read to its end.
timedCase("the data export", async (history, time) => {
  const [code = ""] = history.member.backupCodes;

  const res = await time.job("POST /api/export (until the response starts)", REQUEST_LIMIT_MS, () =>
    history.browser.send("POST", "/api/export", { code }),
  );
  if (!res.ok) throw new Error(`POST /api/export answered ${res.status}: ${await res.text()}`);
  const zip = await time.job(
    "POST /api/export (the whole ZIP, streamed)",
    WHOLE_ZIP_LIMIT_MS,
    async () => new Uint8Array(await res.arrayBuffer()),
  );

  const files = readZip(zip);
  const lines = new TextDecoder().decode(files.get("transactions.csv")).split("\r\n");
  const shown = await history.database.$client.execute(
    "SELECT count(*) AS n FROM transactions WHERE hidden_reason IS NULL",
  );
  // A header, at least one line per shown Transaction, and the last line's end.
  expect(lines.length).toBeGreaterThanOrEqual(Number(shown.rows[0]?.n) + 2);
  expect(files.get("data.json")?.length).toBeGreaterThan(0);
});
