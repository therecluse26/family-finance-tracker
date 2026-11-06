import { type FormEvent, useEffect, useState } from "react";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import type { BackupsView } from "../../../server/backups-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { lastCheckText, sendPastedKey } from "../../master-key.ts";
import {
  BUTTONS,
  DoneLine,
  HINT,
  LABEL,
  Lead,
  SettingCard,
  TabHeading,
  TEXTAREA,
} from "./settings-ui.tsx";

// Settings, Backups and data (spec 07, Settings overview): backups and "Back up now" (spec 11),
// "Check my master key" (spec 09, The Master key), and "Download my data" (spec 11, Data export).

// "Back up now" sends an empty JSON body: the route takes only JSON.
export const backUpNow = () => api.backups.now.$post({ json: {} });

// "Download my data" sends an empty JSON body: the route takes only JSON.
export const downloadMyData = () => api.export.$post({ json: {} });

// The file name the server gave the ZIP, or a plain one.
export function exportFileName(res: Response): string {
  const named = /filename="([\w.-]+)"/.exec(res.headers.get("content-disposition") ?? "");
  return named?.[1] ?? "family-finance-data.zip";
}

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
      <p className="mt-3">
        Backups go to <code className="font-mono text-sm break-all">{backups.folder}</code>. The app
        keeps the newest 7 backups and 3 safety copies, and uploads nothing.
      </p>
      {backups.readable ? (
        <p className="mt-1.5">
          {backups.lastBackupAt === null
            ? "No backup yet."
            : `Last backup: ${momentLabel(backups.lastBackupAt, now)}. ${count}, ${sizeLabel(backups.bytes)} in all.`}
        </p>
      ) : (
        <p className="mt-1.5">
          <StatusText tone="critical">The app cannot read the backup folder.</StatusText>
        </p>
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
    <SettingCard id="backups" title="Backups">
      <Lead>The app backs up its data every day at 3:00 AM, Household time.</Lead>
      {backups === undefined ? null : <BackupLines backups={backups} />}
      <div className={BUTTONS}>
        <Button type="button" variant="outlined" disabled={busy} onClick={backUp}>
          Back up now
        </Button>
      </div>
      <DoneLine done={done} />
      <ErrorLine error={error} />
    </SettingCard>
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
    <SettingCard id="check-my-master-key" title="Check my master key">
      <form onSubmit={submit}>
        <Lead>
          Paste the Master key you saved, and the app says whether it matches. The app never shows
          the Master key.
        </Lead>
        {lastCheck === undefined ? null : <p className={HINT}>{lastCheckText(lastCheck)}</p>}
        <label className={LABEL}>
          Master key
          <textarea
            className={TEXTAREA}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            required
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </label>
        <div className={BUTTONS}>
          <Button type="submit" disabled={busy}>
            Check my master key
          </Button>
        </div>
        <DoneLine done={done} />
        <ErrorLine error={error} />
      </form>
      <p className="mt-3 text-small text-muted">
        No code is needed. You signed in with one already.
      </p>
    </SettingCard>
  );
}

// The data export says before the download that the file is not encrypted (spec 11, Data export).
export function DownloadMyData() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    downloadMyData()
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: unknown };
          setError(typeof body.error === "string" ? body.error : "That did not work.");
          return;
        }
        const name = exportFileName(res);
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        // Some browsers read the file after click() returns.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setDone(`Downloaded ${name}.`);
      })
      .catch(() => setError("The download did not finish. Try again."))
      .finally(() => setBusy(false));
  }

  return (
    <SettingCard id="download-my-data" title="Download my data">
      <form onSubmit={submit}>
        <Lead>
          One ZIP file: your Transactions, Accounts, Budgets, Goals, and Category rules as CSV
          files, and all the app's data in data.json. It holds no keys, passwords, or codes.
        </Lead>
        <p className="mt-3 font-semibold">
          The file is not encrypted. Anyone who has it can read your Household's money. Keep it
          somewhere safe.
        </p>
        <div className={BUTTONS}>
          <Button type="submit" variant="outlined" disabled={busy}>
            Download my data
          </Button>
        </div>
        <DoneLine done={done} />
        <ErrorLine error={error} />
      </form>
      <p className="mt-3 text-small text-muted">
        No code is needed. You signed in with one already.
      </p>
    </SettingCard>
  );
}

export function BackupsAndData() {
  return (
    <>
      <TabHeading>Backups and data</TabHeading>
      <Backups />
      <CheckMasterKey />
      <DownloadMyData />
    </>
  );
}
