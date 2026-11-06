import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { calendarDateIn, dateLabel, STATUS_ICON, type StatusTone } from "../../format.ts";
import type { AlertPartView, AlertView } from "../../server/alerts-views.ts";
import { api } from "../api.ts";
import { askAiAbout } from "../chat.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { Page, PageHeading } from "../components/Page.tsx";
import { Pill } from "../components/Pill.tsx";
import { AiMark, TONE_COLOR } from "../components/Status.tsx";
import { browserZone } from "./Accounts.tsx";

// The Alert list (spec 07, Alert list; spec 06, The Alert list): every Alert, newest first,
// including those held back by the weekly cap and those found in history. A merged Alert shows each
// part's line under one heading, and each part takes its own "Not a problem" press. Each Alert has
// one "Ask the AI" press (spec 06, "Ask the AI"), which opens the Member's Chat thread about it.

// Newest first, by when each Alert's first part was created.
export function newestFirst(alerts: readonly AlertView[]): AlertView[] {
  return [...alerts].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  );
}

// "Nov 3 · Price increase". The mark, such as "sent", follows it as a pill.
export function alertLine(alert: AlertView, today: string, zone: string): string {
  return [dateLabel(calendarDateIn(new Date(alert.createdAt), zone), today), alert.kind].join(
    " · ",
  );
}

// Each kind's icon and color (spec 07, Status). Spending past its Budget is red; on pace and the
// charges worth acting on are orange; the rest are blue, to know about. The kind's word always
// shows in the line under it, so the color is never alone.
export const KIND_TONE: Record<AlertView["kind"], StatusTone> = {
  "Over Budget": "critical",
  "On pace": "serious",
  "Price increase": "serious",
  "Duplicate charge": "serious",
  "Card interest or fee": "serious",
  "Large purchase": "accent",
  "New Recurring charge": "accent",
};

function KindIcon(props: { kind: AlertView["kind"] }) {
  const tone = KIND_TONE[props.kind];
  return (
    <span aria-hidden="true" className={`mr-1.5 ${TONE_COLOR[tone]}`}>
      {STATUS_ICON[tone]}
    </span>
  );
}

// The date, the kind, and the mark the Alerts step gave it. An Alert it has not decided yet has
// no mark.
function AlertMeta(props: { alert: AlertView; today: string; zone: string }) {
  return (
    <p className="mt-0.5 text-small text-muted">
      {alertLine(props.alert, props.today, props.zone)}
      {props.alert.state === null ? null : (
        <>
          {" · "}
          <Pill>{props.alert.state}</Pill>
        </>
      )}
    </p>
  );
}

export type PartState = { busy?: boolean; error?: string };

// "Ask the AI" on one Alert: its press, and its state, keyed by the Alert's ID.
export type AskAi = { state: PartState; onAsk(): void };

function AskAiButton(props: { ask: AskAi }) {
  return (
    <Button
      type="button"
      variant="outlined"
      disabled={props.ask.state.busy === true}
      onClick={props.ask.onAsk}
    >
      Ask the AI
    </Button>
  );
}

// One part: its text, the AI's advice, and its own "Not a problem" press. An Alert of one part
// gives it its kind's icon, its date line, and the Alert's "Ask the AI" press; a merged Alert shows
// those under its heading.
export function AlertPart(props: {
  part: AlertPartView;
  state: PartState;
  today: string;
  zone: string;
  onNotAProblem(part: AlertPartView): void;
  kind?: AlertView["kind"];
  meta?: ReactNode;
  ask?: AskAi;
}) {
  const { part, state } = props;
  const pressed = part.notAProblem[0];
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-line-soft pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-[1_1_320px]">
        <p className={props.kind === undefined ? undefined : "font-semibold"}>
          {props.kind === undefined ? null : <KindIcon kind={props.kind} />}
          {keepAmountsWhole(part.text)}
        </p>
        {part.advice === null ? null : (
          <p className="mt-1 text-sm text-ink-soft">
            <AiMark /> {part.advice}
          </p>
        )}
        {props.meta}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {props.ask === undefined ? null : <AskAiButton ask={props.ask} />}
        <Button
          type="button"
          variant="outlined"
          disabled={state.busy === true || pressed !== undefined}
          onClick={() => props.onNotAProblem(part)}
        >
          Not a problem
        </Button>
        {pressed === undefined ? null : (
          <span className="text-small text-muted">
            marked {dateLabel(calendarDateIn(new Date(pressed.pressedAt), props.zone), props.today)}
          </span>
        )}
      </div>
      <ErrorLine error={state.error} />
      <ErrorLine error={props.ask?.state.error} />
    </li>
  );
}

export function AlertRows(props: {
  alerts: readonly AlertView[];
  states: Readonly<Record<string, PartState>>;
  // Each Alert's "Ask the AI" state, by the Alert's ID.
  asks: Readonly<Record<string, PartState>>;
  today: string;
  zone: string;
  onNotAProblem(part: AlertPartView): void;
  onAskAi(alert: AlertView): void;
}) {
  if (props.alerts.length === 0) {
    return (
      <Card>
        <p className="text-muted">No Alerts yet.</p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {newestFirst(props.alerts).map((alert) => {
        const meta = <AlertMeta alert={alert} today={props.today} zone={props.zone} />;
        const merged = alert.heading !== null;
        const ask: AskAi = { state: props.asks[alert.id] ?? {}, onAsk: () => props.onAskAi(alert) };
        return (
          <li
            key={alert.id}
            className="rounded-card border border-line bg-white px-4 py-4 min-[900px]:px-5"
            data-kind={alert.kind}
          >
            {merged ? (
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <div className="min-w-0 flex-[1_1_320px]">
                  <p className="font-semibold">
                    <KindIcon kind={alert.kind} />
                    {alert.heading}
                  </p>
                  {meta}
                </div>
                <AskAiButton ask={ask} />
                <ErrorLine error={ask.state.error} />
              </div>
            ) : null}
            <ul>
              {alert.parts.map((part, index) => (
                <AlertPart
                  key={part.id}
                  part={part}
                  state={props.states[part.id] ?? {}}
                  today={props.today}
                  zone={props.zone}
                  onNotAProblem={props.onNotAProblem}
                  {...(merged || index > 0 ? {} : { kind: alert.kind, meta, ask })}
                />
              ))}
            </ul>
          </li>
        );
      })}
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
  const [asks, setAsks] = useState<Record<string, PartState>>({});
  const [error, setError] = useState<string | undefined>();
  const navigate = useNavigate();
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

  async function askAi(alert: AlertView) {
    setAsks((all) => ({ ...all, [alert.id]: { busy: true } }));
    const asked = await askAiAbout(alert.id);
    if ("threadId" in asked) return navigate(`/chat/${asked.threadId}`);
    setAsks((all) => ({ ...all, [alert.id]: { error: asked.error } }));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    void load();
  }, []);

  return (
    <Page>
      <PageHeading title="Alert list" />
      <p className="text-muted">Every Alert lands here, sent or not.</p>
      <ErrorLine error={error} />
      {alerts === undefined ? null : (
        <AlertRows
          alerts={alerts}
          states={states}
          asks={asks}
          today={today}
          zone={zone}
          onNotAProblem={(part) => void notAProblem(part)}
          onAskAi={(alert) => void askAi(alert)}
        />
      )}
      <p className="text-small text-muted">
        "Not a problem" counts for the whole Household. After it, the same Alert does not come back.
        Change the weekly cap and your channels in{" "}
        <Link className="text-accent underline hover:text-accent-dark" to="/settings/alerts">
          Settings → Alerts
        </Link>
        .
      </p>
    </Page>
  );
}
