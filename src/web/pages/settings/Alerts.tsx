import { type FormEvent, useEffect, useState } from "react";
import type { AlertSettingsView } from "../../../server/alerts-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { AlertEmail } from "./AlertEmail.tsx";
import { BOX, BUTTONS, DoneLine, HINT, LABEL, SettingCard, TabHeading } from "./settings-ui.tsx";

// Settings, Alerts (spec 06, The weekly cap; Recipients and channels; spec 07, Settings overview):
// the weekly cap, which any Member may change to any whole number from 0; then each Member's
// channels and the Household's email server (AlertEmail.tsx).

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
    <form onSubmit={submit}>
      <label className={LABEL}>
        Weekly cap
        <input
          className={`${BOX} max-w-40 tabular-nums`}
          inputMode="numeric"
          pattern="\d+"
          required
          value={cap}
          onChange={(event) => setCap(event.target.value)}
        />
      </label>
      <p className={HINT}>
        The app sends at most this many Alerts a week, Monday to Sunday, most urgent first. An Alert
        over the cap is held back: it waits in the Alert list and the Monthly review, and is never
        sent later. Duplicate charges and card interest or fees always go out. With 0, only those
        do.
      </p>
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Save the weekly cap
        </Button>
      </div>
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
      <TabHeading>Alerts</TabHeading>
      <ErrorLine error={error} />
      <SettingCard id="weekly-cap" title="How many Alerts a week">
        {settings === undefined ? null : (
          <WeeklyCapForm
            settings={settings}
            onSaved={(saved) => {
              setSettings(saved);
              setDone("The weekly cap is saved.");
            }}
          />
        )}
        <DoneLine done={done} />
      </SettingCard>
      <AlertEmail />
    </>
  );
}
