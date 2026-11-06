import { type ReactNode, useEffect, useState } from "react";
import type { SmtpView } from "../../notify/email-view.ts";
import type { PushView } from "../../notify/push-view.ts";
import type { OptionalSetupStep, SetupProgressView } from "../../server/setup-views.ts";
import { api } from "../api.ts";
import { BUTTON, ErrorLine } from "../components/Fields.tsx";
import { AiSettingsFields } from "./settings/Ai.tsx";
import { SmtpForm, TestEmailButton } from "./settings/AlertEmail.tsx";
import { AlertPush } from "./settings/AlertPush.tsx";
import { BankSources } from "./settings/Banks.tsx";
import { MakeInvite } from "./settings/Members.tsx";

// The first-run wizard's steps 5 to 9 (spec 12, The first-run wizard). Steps 5 to 8 hold the
// screens Settings uses, and each has Skip. The server says when a step is done, from what app.db
// holds, so Next goes on only once it is. Step 9 says that history is loading.

// The page's writes, exactly as it sends them. Each sends a JSON body: the server answers 415 to a
// write without one.
export function skipStep(step: OptionalSetupStep) {
  // The Hono client puts the step into the path as it is, and "invite members" holds a space.
  const skip = { param: { step: encodeURIComponent(step) }, json: {} };
  return api.setup.steps[":step"].skip.$post(skip);
}
export const finishWizard = () => api.setup.finish.$post({ json: {} });

// What Next says while the server does not yet count the step as done.
export const NOT_DONE: Record<OptionalSetupStep, string> = {
  banks: "Add a Connection, an Unconnected account, or a Manual loan first, or skip this step.",
  ai: "Save an AI provider first, or skip this step.",
  alerts: "Send a test email first: the step is done only once one goes out. Or skip this step.",
  "invite members": "Make an invite link first, or skip this step.",
};

// The estimate for the first AI run on all history (spec 08, The first run). It is a fixed figure:
// the app makes no AI call to work it out.
export const FIRST_RUN_ESTIMATE =
  "The first AI run on all history costs about $0.20. It counts against the AI cost cap.";

// "Add to Home Screen" (spec 12, Step 7, Alerts): on an iPhone, only an app on the Home Screen
// gets pushes, so the step explains it first. The installed app opens standalone, and needs no
// such note.
export function needsHomeScreen(userAgent: string, standalone: boolean): boolean {
  return /\biPhone\b/.test(userAgent) && !standalone;
}

export const HOME_SCREEN_NOTE =
  "On an iPhone, Alerts come only to the app on your Home Screen. In Safari, tap Share, then Add to Home Screen. Open the app from your Home Screen, sign in, and turn on Alerts there.";

function standalone(): boolean {
  if (typeof window === "undefined") return false;
  const apple = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return apple || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

// Next and Skip, below each optional step.
export function StepButtons(props: {
  busy: boolean;
  notDone: string | undefined;
  error: string | undefined;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      <button className={BUTTON} type="button" disabled={props.busy} onClick={props.onNext}>
        Next
      </button>
      <button
        className="mt-4 rounded border border-gray-300 px-4 py-2 disabled:opacity-50"
        type="button"
        disabled={props.busy}
        onClick={props.onSkip}
      >
        Skip
      </button>
      <ErrorLine error={props.notDone ?? props.error} />
    </div>
  );
}

// Step 7's push part: hidden in plain-HTTP mode, with the reason shown; on an iPhone, the Home
// Screen note comes first.
export function PushPart(props: { push: PushView; homeScreenFirst: boolean }) {
  return (
    <>
      {props.push.available && props.homeScreenFirst ? (
        <section className="mt-6">
          <h3 className="font-semibold">Add to Home Screen</h3>
          <p className="mt-1">{HOME_SCREEN_NOTE}</p>
        </section>
      ) : null}
      <AlertPush push={props.push} />
    </>
  );
}

// Step 7, Alerts: the email server and "Send a test email", then push on this device.
export function AlertsStepView(props: {
  smtp: SmtpView | null;
  push: PushView;
  homeScreenFirst: boolean;
  onSmtpSaved: (smtp: SmtpView) => void;
}) {
  return (
    <>
      <p className="mt-4">
        Alerts and System notices come by email and by push. Email needs the Household's SMTP
        server. The step is done once a test email goes out.
      </p>
      <SmtpForm smtp={props.smtp} onSaved={props.onSmtpSaved} />
      <TestEmailButton />
      <PushPart push={props.push} homeScreenFirst={props.homeScreenFirst} />
    </>
  );
}

function AlertsStep() {
  const [smtp, setSmtp] = useState<SmtpView | null | undefined>();
  const [push, setPush] = useState<PushView | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([api.smtp.settings.$get(), api.push.$get()])
      .then(async ([smtpRes, pushRes]) => {
        if (!smtpRes.ok || !pushRes.ok) return setError("The Alert settings did not load.");
        setSmtp(((await smtpRes.json()) as { smtp: SmtpView | null }).smtp);
        setPush(((await pushRes.json()) as { push: PushView }).push);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <ErrorLine error={error} />
      {smtp === undefined || push === undefined ? null : (
        <AlertsStepView
          smtp={smtp}
          push={push}
          homeScreenFirst={needsHomeScreen(navigator.userAgent, standalone())}
          onSmtpSaved={setSmtp}
        />
      )}
    </>
  );
}

// Each optional step's own screen, as Settings shows it.
export function StepScreen(props: { step: OptionalSetupStep }) {
  switch (props.step) {
    case "banks":
      return (
        <>
          <p className="mt-4">
            Enter the Plaid keys, then connect your banks. For a bank Plaid cannot reach, add an
            Unconnected account. Add each loan the banks do not show as a Manual loan.
          </p>
          <BankSources />
        </>
      );
    case "ai":
      return (
        <>
          <p className="mt-4">{FIRST_RUN_ESTIMATE}</p>
          <AiSettingsFields />
        </>
      );
    case "alerts":
      return <AlertsStep />;
    case "invite members":
      return <MakeInvite onMade={() => {}} />;
  }
}

// One optional step, with Next and Skip. `onProgress` gets the server's answer, which names the
// step to open next.
export function OptionalStep(props: {
  step: OptionalSetupStep;
  onProgress: (progress: SetupProgressView) => void;
}) {
  const { step, onProgress } = props;
  const [busy, setBusy] = useState(false);
  const [notDone, setNotDone] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function run(work: () => Promise<Response>) {
    setBusy(true);
    setNotDone(undefined);
    setError(undefined);
    try {
      const res = await work();
      const body = (await res.json().catch(() => ({}))) as {
        progress?: SetupProgressView;
        error?: unknown;
      };
      if (!res.ok || body.progress === undefined) {
        return setError(typeof body.error === "string" ? body.error : "That did not work.");
      }
      if (body.progress.next === step) return setNotDone(NOT_DONE[step]);
      onProgress(body.progress);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  // Next asks the server whether the step is done. Skip marks it skipped, unless it is done.
  return (
    <>
      <StepScreen step={step} />
      <StepButtons
        busy={busy}
        notDone={notDone}
        error={error}
        onNext={() => void run(() => api.setup.progress.$get())}
        onSkip={() => void run(() => skipStep(step))}
      />
    </>
  );
}

// Step 9's words: history is loading, or, with no Connection, where the skipped steps wait.
export function finishLines(connections: number): string[] {
  if (connections === 0) {
    return [
      "The Household has no Connection yet, so no bank history is loading.",
      'Each step you skipped waits in the "Finish setup" list on the dashboard. Add your banks from there, or in Settings, Banks.',
    ];
  }
  return [
    "Your banks' history is loading. It can take a few hours.",
    "The dashboard shows the progress for each Connection.",
  ];
}

export function FinishStepView(props: {
  connections: number;
  busy: boolean;
  error: string | undefined;
  onOpen: () => void;
}): ReactNode {
  return (
    <div className="mt-4">
      {finishLines(props.connections).map((line) => (
        <p key={line} className="mt-2">
          {line}
        </p>
      ))}
      <button className={BUTTON} type="button" disabled={props.busy} onClick={props.onOpen}>
        Open the dashboard
      </button>
      <ErrorLine error={props.error} />
    </div>
  );
}

export function FinishStep(props: { connections: number; onFinished: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await finishWizard();
      if (res.ok) return props.onFinished();
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      setError(typeof body.error === "string" ? body.error : "That did not work.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FinishStepView
      connections={props.connections}
      busy={busy}
      error={error}
      onOpen={() => void open()}
    />
  );
}
