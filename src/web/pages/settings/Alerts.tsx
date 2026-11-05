import { type FormEvent, useEffect, useState } from "react";
import type { AlertSettingsView } from "../../../server/alerts-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// Settings, Alerts (spec 06, The weekly cap; spec 07, Settings overview): the weekly cap. Any
// Member may change it, to any whole number from 0. Channels come with their own tickets.

export function WeeklyCapForm(props: {
  settings: AlertSettingsView;
  onSaved: (settings: AlertSettingsView) => void;
}) {
  const [cap, setCap] = useState(String(props.settings.weeklyCap));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const weeklyCap = Number(cap.trim());
    if (cap.trim() === "" || !Number.isSafeInteger(weeklyCap) || weeklyCap < 0) {
      return setError("Enter a whole number from 0.");
    }
    setBusy(true);
    setError(undefined);
    try {
      const res = await api["alert-settings"]["weekly-cap"].$put({ json: { weeklyCap } });
      if (!res.ok) return setError("The weekly cap did not save.");
      props.onSaved((await res.json()) as AlertSettingsView);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <label className="block">
        Weekly cap
        <input
          className={FIELD}
          inputMode="numeric"
          pattern="\d+"
          required
          value={cap}
          onChange={(event) => setCap(event.target.value)}
        />
      </label>
      <p className="mt-1 text-gray-600">
        The app sends at most this many Alerts a week, Monday to Sunday, most urgent first. An Alert
        over the cap is held back: it waits in the Alert list and the Monthly review, and is never
        sent later. Duplicate charges and card interest or fees always go out. With 0, only those
        do.
      </p>
      <button className={BUTTON} type="submit" disabled={busy}>
        Save the weekly cap
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function Alerts() {
  const [settings, setSettings] = useState<AlertSettingsView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  useEffect(() => {
    api["alert-settings"]
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError("The Alert settings did not load.");
        setSettings((await res.json()) as AlertSettingsView);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <h2 className="text-xl font-semibold">Alerts</h2>
      <ErrorLine error={error} />
      {settings === undefined ? null : (
        <WeeklyCapForm
          settings={settings}
          onSaved={(saved) => {
            setSettings(saved);
            setDone("The weekly cap is saved.");
          }}
        />
      )}
      {done === undefined ? null : <p className="mt-3">{done}</p>}
    </>
  );
}
