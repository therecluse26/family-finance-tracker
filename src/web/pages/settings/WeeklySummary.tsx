import { useEffect, useState } from "react";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { WeeklySummaryView } from "../../../weekly-summary/view.ts";
import { api } from "../../api.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { HINT } from "./settings-ui.tsx";

// Settings, Alerts: the Member's own "Weekly summary email" switch, a row of the My channels card
// (spec 06, Weekly summary email). The switch saves at once, and changes only the signed-in
// Member's own setting. With no SMTP server saved, the row says so. It shows the Member's latest
// week: sent, still sending, or not sent.

// The page's write, exactly as it sends it. It sends a JSON body: the server answers 415 to a write
// without one.
export const saveWeeklySummary = (on: boolean) => api["weekly-summary"].$put({ json: { on } });

// The words to show for a refused request: the server's own.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "Sunday, Nov 8" for "2026-11-08". `today` gives the year rule of dateLabel.
function dayLabel(date: string, today: string): string {
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return `${weekday}, ${dateLabel(date, today)}`;
}

// The board's switch (.sw): 40 by 24 px, accent when on, the field gray when off. This page draws
// its own, as Budgets.tsx does for "Follow the bill"; one shared switch should move to components.
const SWITCH_TRACK =
  "relative inline-block h-6 w-10 shrink-0 rounded-full bg-field peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-70 after:absolute after:top-[3px] after:left-[3px] after:size-[18px] after:rounded-full after:bg-white after:content-[''] peer-checked:after:left-[19px]";

export function WeeklySummaryRow(props: { initial: WeeklySummaryView; today?: string }) {
  const [view, setView] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Today in the Household time zone: only the year of a label depends on it.
  const zone = useHouseholdZone();
  const today = props.today ?? (zone === undefined ? undefined : calendarDateIn(new Date(), zone));

  // The email server's state comes from the page: saving the server below changes it.
  useEffect(() => {
    setView((current) => ({ ...current, emailSetUp: props.initial.emailSetUp }));
  }, [props.initial.emailSetUp]);

  async function turn(on: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await saveWeeklySummary(on);
      if (!res.ok) return setError(await refusal(res));
      setView(((await res.json()) as { weeklySummary: WeeklySummaryView }).weeklySummary);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  const { last } = view;
  return (
    <div className="mt-4 border-t border-line-soft pt-3.5">
      <label className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          aria-checked={view.on}
          aria-describedby="weekly-summary-when"
          checked={view.on}
          disabled={busy}
          onChange={() => turn(!view.on)}
        />
        <span aria-hidden="true" className={SWITCH_TRACK} />
        <span className="min-w-0 flex-[1_1_220px]">
          <span className="block font-semibold">Weekly summary email</span>
          <span id="weekly-summary-when" className="mt-0.5 block text-small text-muted">
            Sunday morning at 8:00 AM, Household time, to your login email. It covers Sunday to
            Saturday of the week before.
          </span>
        </span>
      </label>
      {view.emailSetUp ? null : <p className={HINT}>Needs the email server. Save it below.</p>}
      {last === null || today === undefined ? null : last.state === "sent" ? (
        <p className="mt-1.5 text-small">
          <StatusText tone="good">Last sent {dayLabel(last.on, today)}</StatusText>
        </p>
      ) : last.state === "sending" ? (
        <p className="mt-1.5 text-small">
          <StatusText tone="serious">
            Sending the summary for {dateLabel(last.from, today)} to {dateLabel(last.to, today)}.
            The app tries again if a send fails.
          </StatusText>
        </p>
      ) : (
        <p className="mt-1.5 text-small">
          <StatusText tone="critical">
            The summary for {dateLabel(last.from, today)} to {dateLabel(last.to, today)} did not
            send. Check the email server below.
          </StatusText>
        </p>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
