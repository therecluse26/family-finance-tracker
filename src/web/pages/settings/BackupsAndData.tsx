import { type FormEvent, useEffect, useState } from "react";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import type { BackupsView } from "../../../server/backups-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, PasteField } from "../../components/Fields.tsx";
import { lastCheckText, sendPastedKey } from "../../master-key.ts";

// Settings, Backups and data (spec 07, Settings overview): backups and "Back up now" (spec 11), and
// "Check my master key" (spec 09, The Master key). The data export comes with its own ticket.

// "Back up now" sends an empty JSON body: the route takes only JSON.
export const backUpNow = () => api.backups.now.$post({ json: {} });

// "3.2 MB", "820 KB", or "512 bytes".
export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// "Nov 2 at 3:00 AM", in this browser's time zone.
function momentLabel(at: string, now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const moment = new Date(at);
  return `${dateLabel(calendarDateIn(moment, zone), calendarDateIn(now, zone))} at ${timeLabel(moment, zone)}`;
}

export function BackupLines(props: { backups: BackupsView; now?: Date }) {
  const { backups } = props;
  const now = props.now ?? new Date();
  const count = backups.files === 1 ? "1 file" : `${backups.files} files`;
  return (
    <>
      <p className="mt-2">
        Backups go to <code>{backups.folder}</code>. The app keeps the newest 7 backups and 3 safety
        copies, and uploads nothing.
      </p>
      {backups.readable ? (
        <p className="mt-2">
          {backups.lastBackupAt === null
            ? "No backup yet."
            : `Last backup: ${momentLabel(backups.lastBackupAt, now)}. ${count}, ${sizeLabel(backups.bytes)} in all.`}
        </p>
      ) : (
        <p className="mt-2 text-red-700">The app cannot read the backup folder.</p>
      )}
    </>
  );
}

function Backups() {
  const [backups, setBackups] = useState<BackupsView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  useEffect(() => {
    api.backups
      .$get()
      .then(async (res) => (res.ok ? setBackups((await res.json()).backups) : undefined))
      .catch(() => {});
  }, []);

  function backUp() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    backUpNow()
      .then(async (res) => {
        const answer = (await res.json()) as
          | { backup: { file: string }; backups: BackupsView }
          | { error: string; backups?: BackupsView };
        if (answer.backups !== undefined) setBackups(answer.backups);
        if ("backup" in answer) setDone(`Backed up. The new file is ${answer.backup.file}.`);
        else setError(answer.error);
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <section className="mt-4">
      <h3 className="font-semibold">Backups</h3>
      <p className="mt-2">The app backs up its data every day at 3:00 AM, Household time.</p>
      {backups === undefined ? null : <BackupLines backups={backups} />}
      <button className={BUTTON} type="button" disabled={busy} onClick={backUp}>
        Back up now
      </button>
      {done === undefined ? null : (
        <p className="mt-3 text-green-700" role="status">
          {done}
        </p>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

type LastCheck = { memberName: string | null; at: string; matched: boolean } | null;

async function fetchLastCheck(): Promise<LastCheck | undefined> {
  const res = await api["master-key"].check.$get();
  return res.ok ? (await res.json()).lastCheck : undefined;
}

function CheckMasterKey() {
  const [lastCheck, setLastCheck] = useState<LastCheck | undefined>();
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const readLastCheck = async () => setLastCheck(await fetchLastCheck());

  useEffect(() => {
    fetchLastCheck()
      .then(setLastCheck)
      .catch(() => {});
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    sendPastedKey("/api/master-key/check", pasted)
      .then(async (result) => {
        setPasted("");
        if (result.matches) setDone("It matches. Your saved copy is the Master key.");
        else setError(result.error);
        await readLastCheck();
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <h3 className="font-semibold">Check my master key</h3>
      <p className="mt-2">
        Paste the Master key you saved, and the app says whether it matches. The app never shows the
        Master key.
      </p>
      {lastCheck === undefined ? null : (
        <p className="mt-2 text-gray-600">{lastCheckText(lastCheck)}</p>
      )}
      <PasteField label="Master key" value={pasted} onChange={setPasted} />
      <button className={BUTTON} type="submit" disabled={busy}>
        Check my master key
      </button>
      {done === undefined ? null : (
        <p className="mt-3 text-green-700" role="status">
          {done}
        </p>
      )}
      <ErrorLine error={error} />
    </form>
  );
}

export function BackupsAndData() {
  return (
    <>
      <h2 className="text-xl font-semibold">Backups and data</h2>
      <Backups />
      <CheckMasterKey />
    </>
  );
}
