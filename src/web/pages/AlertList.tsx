import { useEffect, useState } from "react";
import { calendarDateIn, dateLabel } from "../../format.ts";
import type { AlertPartView, AlertView } from "../../server/alerts-views.ts";
import { api } from "../api.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { AiMark } from "../components/Status.tsx";
import { browserZone } from "./Accounts.tsx";

// The Alert list (spec 07, Alert list; spec 06, The Alert list): every Alert, newest first,
// including those held back by the weekly cap and those found in history. A merged Alert shows each
// part's line under one heading, and each part takes its own "Not a problem" press.

const BUTTON = "rounded border border-gray-300 px-3 py-1 disabled:opacity-50";

// Newest first, by when each Alert's first part was created.
export function newestFirst(alerts: readonly AlertView[]): AlertView[] {
  return [...alerts].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  );
}

// "Nov 3 · Price increase · sent". An Alert the Alerts step has not decided yet has no mark.
export function alertLine(alert: AlertView, today: string, zone: string): string {
  return [
    dateLabel(calendarDateIn(new Date(alert.createdAt), zone), today),
    alert.kind,
    ...(alert.state === null ? [] : [alert.state]),
  ].join(" · ");
}

export type PartState = { busy?: boolean; error?: string };

export function AlertPart(props: {
  part: AlertPartView;
  state: PartState;
  today: string;
  zone: string;
  onNotAProblem(part: AlertPartView): void;
}) {
  const { part, state } = props;
  const pressed = part.notAProblem[0];
  return (
    <li className="mt-2">
      <p>{part.text}</p>
      {part.advice === null ? null : (
        <p className="mt-1 text-gray-700">
          <AiMark /> {part.advice}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={state.busy === true || pressed !== undefined}
          onClick={() => props.onNotAProblem(part)}
        >
          Not a problem
        </button>
        {pressed === undefined ? null : (
          <span className="text-sm text-gray-500">
            marked {dateLabel(calendarDateIn(new Date(pressed.pressedAt), props.zone), props.today)}
          </span>
        )}
      </div>
      <ErrorLine error={state.error} />
    </li>
  );
}

export function AlertRows(props: {
  alerts: readonly AlertView[];
  states: Readonly<Record<string, PartState>>;
  today: string;
  zone: string;
  onNotAProblem(part: AlertPartView): void;
}) {
  if (props.alerts.length === 0) return <p className="mt-4">No Alerts yet.</p>;
  return (
    <ul>
      {newestFirst(props.alerts).map((alert) => (
        <li
          key={alert.id}
          className="mt-4 rounded border border-gray-200 p-3"
          data-kind={alert.kind}
        >
          <p className="text-sm text-gray-600">{alertLine(alert, props.today, props.zone)}</p>
          {alert.heading === null ? null : <p className="font-semibold">{alert.heading}</p>}
          <ul>
            {alert.parts.map((part) => (
              <AlertPart
                key={part.id}
                part={part}
                state={props.states[part.id] ?? {}}
                today={props.today}
                zone={props.zone}
                onNotAProblem={props.onNotAProblem}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export const alertListRequests = {
  list: () => api.alerts.$get(),
  // The route takes only JSON, and reads no body.
  notAProblem: (id: string) => {
    const press = { param: { id }, json: {} };
    return api.alerts[":id"]["not-a-problem"].$post(press);
  },
};

export function AlertList() {
  const [alerts, setAlerts] = useState<AlertView[] | undefined>();
  const [states, setStates] = useState<Record<string, PartState>>({});
  const [error, setError] = useState<string | undefined>();
  const zone = browserZone();
  const today = calendarDateIn(new Date(), zone);

  const setState = (id: string, state: PartState) => setStates((all) => ({ ...all, [id]: state }));

  async function load() {
    try {
      const res = await alertListRequests.list();
      if (!res.ok) return setError("That did not work.");
      setAlerts(((await res.json()) as { alerts: AlertView[] }).alerts);
      setError(undefined);
    } catch {
      setError("The server did not answer.");
    }
  }

  async function notAProblem(part: AlertPartView) {
    setState(part.id, { busy: true });
    try {
      const res = await alertListRequests.notAProblem(part.id);
      if (!res.ok) return setState(part.id, { error: "That did not work." });
      const { notAProblem: presses } = (await res.json()) as {
        notAProblem: AlertPartView["notAProblem"];
      };
      setAlerts((all) =>
        all?.map((alert) => ({
          ...alert,
          parts: alert.parts.map((each) =>
            each.id === part.id ? { ...each, notAProblem: presses } : each,
          ),
        })),
      );
      setState(part.id, {});
    } catch {
      setState(part.id, { error: "The server did not answer." });
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <main>
      <h1 className="text-2xl font-semibold">Alert list</h1>
      <ErrorLine error={error} />
      {alerts === undefined ? null : (
        <AlertRows
          alerts={alerts}
          states={states}
          today={today}
          zone={zone}
          onNotAProblem={(part) => void notAProblem(part)}
        />
      )}
    </main>
  );
}
