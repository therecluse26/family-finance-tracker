import { type FormEvent, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, PasteField } from "../../components/Fields.tsx";
import { lastCheckText, sendPastedKey } from "../../master-key.ts";

// Settings, Backups and data (spec 07, Settings overview). This ticket brings "Check my master
// key" (spec 09, The Master key). Backups and the data export come with their own tickets.

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
      <CheckMasterKey />
    </>
  );
}
