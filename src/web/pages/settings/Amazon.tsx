import { useEffect, useState } from "react";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import type {
  AmazonImportView,
  AmazonShipmentCounts,
  AmazonStatusView,
} from "../../../server/amazon-views.ts";
import { api } from "../../api.ts";
import { Button, buttonClass } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import {
  ADD_PANEL,
  BUTTONS,
  DoneLine,
  HINT,
  Lead,
  ROW,
  SettingCard,
  SUBHEADING,
  TabHeading,
} from "./settings-ui.tsx";

// Settings → Amazon (spec 14, The Amazon page in Settings): the steps to get Amazon's order file,
// Upload, what the last upload did, the link counts, and "Delete all Amazon data", which asks once.

// The Content-Type an upload is sent with, by the file's name: Amazon's ZIP file, or the order file
// inside it. Undefined for any other file, which the page does not send.
export function uploadType(fileName: string): "application/zip" | "text/csv" | undefined {
  const name = fileName.toLowerCase();
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".csv")) return "text/csv";
  return undefined;
}

// The file as the raw body, with no form around it (the route reads it once, with its own limit).
export const uploadAmazonFile = (body: Blob, contentType: "application/zip" | "text/csv") =>
  api.amazon.import.$post(undefined, {
    headers: { "content-type": contentType },
    init: { body },
  });

export const deleteAmazonData = () => api.amazon.$delete();

const DELETE_QUESTION =
  "Delete every Line item, every link, and every Item rule? Each Transaction with Line items goes back to its own Category. Hand-set Categories and hand splits stay.";

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

function momentLabel(at: string, zone: string, now: Date): string {
  const moment = new Date(at);
  return `${dateLabel(calendarDateIn(moment, zone), calendarDateIn(now, zone))} at ${timeLabel(moment, zone)}`;
}

export function AmazonSteps() {
  return (
    <ol className="mt-3 list-decimal space-y-1 pl-6">
      <li>
        On amazon.com, open <strong>Account &amp; Lists → Your Account → Request Your Data</strong>.
      </li>
      <li>
        Pick <strong>Your Orders</strong>, then <strong>Submit Request</strong>.
      </li>
      <li>Confirm the request from Amazon's email.</li>
      <li>When Amazon's second email arrives, download the ZIP file.</li>
      <li>Upload the ZIP file here, as it is.</li>
    </ol>
  );
}

// What one upload did: rows read, Line items added and updated, and each skip reason with its
// count and first row.
export function ImportLines(props: { result: AmazonImportView }) {
  const { result } = props;
  const skipped = result.skipped.reduce((sum, skip) => sum + skip.rows, 0);
  return (
    <>
      <p className="mt-3">
        {plural(result.rowsRead, "row", "rows")} read.{" "}
        {plural(result.added, "Line item", "Line items")} added,{" "}
        {result.updated.toLocaleString("en-US")} updated, {result.unchanged.toLocaleString("en-US")}{" "}
        unchanged. {plural(skipped, "row", "rows")} skipped.
      </p>
      {result.skipped.length === 0 ? null : (
        <ul className="mt-1.5 list-disc pl-6">
          {result.skipped.map((skip) => (
            <li key={skip.reason}>
              {plural(skip.rows, "row", "rows")} {skip.rows === 1 ? "was" : "were"} skipped:{" "}
              {skip.reason} (first at row {skip.firstRow.toLocaleString("en-US")}).
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Shipments by where their linking stands.
export function LinkCounts(props: { shipments: AmazonShipmentCounts }) {
  const { shipments } = props;
  const rows: [string, number][] = [
    ["Linked to a charge", shipments.linked],
    ["Waiting for a charge", shipments.waiting],
    ["Waiting on the Review list", shipments.onReviewList],
    ["Not matched", shipments.notMatched],
    ["Paid in part by gift card, not linked", shipments.giftCard],
  ];
  return (
    <ul className="mt-2.5">
      {rows.map(([label, count]) => (
        <li key={label} className={ROW}>
          <span className="min-w-0 flex-[1_1_220px]">{label}</span>
          <span className="font-semibold tabular-nums">
            {plural(count, "shipment", "shipments")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AmazonCard(props: {
  status: AmazonStatusView;
  zone: string;
  // What the upload in this visit did, if there was one.
  lastResult?: AmazonImportView;
  busy: boolean;
  onUpload: (file: File) => void;
  onDelete: () => void;
  // Starts with the confirm step open, for a test of the first paint.
  confirming?: boolean;
  now?: Date;
}) {
  const { status, zone } = props;
  const [confirming, setConfirming] = useState(props.confirming ?? false);
  const now = props.now ?? new Date();
  const last = status.lastImport;
  return (
    <>
      <SettingCard
        id="amazon-orders"
        title="Amazon orders"
        status={
          status.lineItems === 0 ? (
            <span className="text-muted">No file yet</span>
          ) : (
            <span className="text-muted">
              {plural(status.lineItems, "Line item", "Line items")}
            </span>
          )
        }
      >
        <Lead>
          Upload Amazon's order file, and the app links each order's items to its card charge, so
          one charge can show the Categories of what it bought.
        </Lead>
        <AmazonSteps />
        <p className={HINT}>
          Amazon usually takes a few hours to a few days. You may upload a newer file at any time.
          The app reads only the order history file in the ZIP, and never its addresses, gift
          messages, or photos.
        </p>
        <div className={BUTTONS}>
          <label
            className={`${buttonClass()} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${props.busy ? "pointer-events-none opacity-60" : ""}`}
          >
            {props.busy ? "Working…" : "Upload"}
            <input
              type="file"
              className="sr-only"
              accept=".zip,.csv,application/zip,text/csv"
              disabled={props.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file !== undefined) props.onUpload(file);
              }}
            />
          </label>
          <span className="text-small text-muted">A .zip or .csv file, at most 50 MB.</span>
        </div>
        {props.lastResult === undefined ? null : <ImportLines result={props.lastResult} />}
        <h4 className={SUBHEADING}>Last import</h4>
        {last === null ? (
          <p className="mt-1.5">No file uploaded yet.</p>
        ) : (
          <p className="mt-1.5">
            {momentLabel(last.importedAt, zone, now)}
            {last.memberName === null ? "" : `, by ${last.memberName}`}.
          </p>
        )}
      </SettingCard>
      {status.lineItems === 0 ? null : (
        <SettingCard id="amazon-links" title="Links to charges">
          <Lead>
            Each shipment is one order's items that shipped together, and links to one card charge.
          </Lead>
          <LinkCounts shipments={status.shipments} />
        </SettingCard>
      )}
      {status.lineItems === 0 ? null : (
        <SettingCard id="amazon-delete" title="Delete all Amazon data">
          <Lead>
            Removes every Line item, every link, and every Item rule. Hand-set Categories and hand
            splits stay.
          </Lead>
          {confirming ? (
            <div className={ADD_PANEL}>
              <p id="amazon-delete-confirm" className="font-semibold">
                {DELETE_QUESTION}
              </p>
              <div className={BUTTONS}>
                <Button
                  type="button"
                  aria-describedby="amazon-delete-confirm"
                  disabled={props.busy}
                  onClick={() => {
                    setConfirming(false);
                    props.onDelete();
                  }}
                >
                  Delete all Amazon data
                </Button>
                <Button
                  type="button"
                  variant="outlined"
                  disabled={props.busy}
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <div className={BUTTONS}>
              <Button
                type="button"
                variant="outlined"
                disabled={props.busy}
                onClick={() => setConfirming(true)}
              >
                Delete all Amazon data
              </Button>
            </div>
          )}
        </SettingCard>
      )}
    </>
  );
}

async function errorOf(res: Response): Promise<string> {
  try {
    const answer = (await res.json()) as { error?: unknown };
    if (typeof answer.error === "string") return answer.error;
  } catch {}
  return "The file was not imported.";
}

export function Amazon() {
  const [status, setStatus] = useState<AmazonStatusView | undefined>();
  const [lastResult, setLastResult] = useState<AmazonImportView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const zone = useHouseholdZone();

  useEffect(() => {
    api.amazon
      .$get()
      .then(async (res) =>
        res.ok ? setStatus(await res.json()) : setError("The page did not load."),
      )
      .catch(() => setError("The server did not answer."));
  }, []);

  async function upload(file: File) {
    setError(undefined);
    setDone(undefined);
    setLastResult(undefined);
    const type = uploadType(file.name);
    if (type === undefined) return setError("Pick Amazon's ZIP file, or the CSV file inside it.");
    if (file.size > 50 * 1024 * 1024) return setError("The file is larger than 50 MB.");
    setBusy(true);
    try {
      const res = await uploadAmazonFile(file, type);
      if (!res.ok) return setError(await errorOf(res));
      const answer = (await res.json()) as { import: AmazonImportView; status: AmazonStatusView };
      setStatus(answer.status);
      setLastResult(answer.import);
      setDone("The file is imported.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAll() {
    setError(undefined);
    setDone(undefined);
    setLastResult(undefined);
    setBusy(true);
    try {
      const res = await deleteAmazonData();
      if (!res.ok) return setError(await errorOf(res));
      setStatus((await res.json()).status);
      setDone("All Amazon data is deleted.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TabHeading>Amazon</TabHeading>
      <ErrorLine error={error} />
      <DoneLine done={done} />
      {status === undefined || zone === undefined ? null : (
        <AmazonCard
          status={status}
          zone={zone}
          lastResult={lastResult}
          busy={busy}
          onUpload={(file) => void upload(file)}
          onDelete={() => void removeAll()}
        />
      )}
    </>
  );
}
