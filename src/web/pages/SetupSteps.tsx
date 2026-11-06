import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { PlaidView } from "../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import type { SetupExtra, SetupProgressView } from "../../server/setup-views.ts";
import { api } from "../api.ts";
import { BUTTON, ErrorLine } from "../components/Fields.tsx";
import { FINISH_SETUP_LINKS } from "../setup-gate.ts";
import { PlaidKeysForm } from "./settings/Banks.tsx";
import { ConnectionList, FakeBankLink, LinkBank } from "./settings/Connections.tsx";

// The first-run wizard's frame and its steps 5 and 6 (spec 12, The first-run wizard). The wizard
// has 6 steps, each with "Step N of 6" and Back. Step 5, Banks, is done once app.db holds a
// Connection, so Continue waits until there is one; "Skip for now" leaves it for the "Finish setup"
// list. Step 6 says that history is loading, and lists the optional extras.

export const WIZARD_STEPS = [
  "setup link",
  "first member",
  "master key",
  "household facts",
  "banks",
  "finish",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Record<WizardStep, string> = {
  "setup link": "Setup link",
  "first member": "Your login",
  "master key": "Master key",
  "household facts": "Household",
  banks: "Banks",
  finish: "Finish",
};

// The step before this one, which Back opens.
export function stepBefore(step: WizardStep): WizardStep | undefined {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1];
}

// The step after this one, which Continue opens from a step already done.
export function stepAfter(step: WizardStep): WizardStep | undefined {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1];
}

// "Step N of 6", then each step's name. Steps before `reached` are done, except a skipped step,
// which stays not done: it shows its number and "(skipped)", not a ✓.
export function Stepper(props: {
  shown: WizardStep;
  reached: WizardStep;
  skipped?: readonly WizardStep[];
}) {
  const shownAt = WIZARD_STEPS.indexOf(props.shown);
  const reachedAt = WIZARD_STEPS.indexOf(props.reached);
  const skipped = props.skipped ?? [];
  return (
    <nav aria-label="Setup steps" className="mt-2">
      <p className="text-gray-600">
        Step {shownAt + 1} of {WIZARD_STEPS.length}
      </p>
      <ol className="mt-1 flex flex-wrap gap-x-3 text-sm">
        {WIZARD_STEPS.map((step, at) => (
          <li
            key={step}
            aria-current={at === shownAt ? "step" : undefined}
            className={at === shownAt ? "font-semibold" : "text-gray-600"}
          >
            {at < reachedAt && !skipped.includes(step) ? "✓ " : `${at + 1}. `}
            {STEP_LABELS[step]}
            {skipped.includes(step) ? " (skipped)" : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export const SECOND_BUTTON = "mt-4 rounded border border-gray-300 px-4 py-2 disabled:opacity-50";

export function BackButton(props: { onBack: () => void; disabled?: boolean }) {
  return (
    <button
      className={SECOND_BUTTON}
      type="button"
      disabled={props.disabled}
      onClick={props.onBack}
    >
      Back
    </button>
  );
}

// A step already done, opened again with Back: what was done, then Back and Continue.
export function DoneStepView(props: {
  lines: string[];
  next: string;
  onBack?: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-4">
      {props.lines.map((line) => (
        <p key={line} className="mt-2">
          {line}
        </p>
      ))}
      <div className="flex flex-wrap gap-3">
        {props.onBack === undefined ? null : <BackButton onBack={props.onBack} />}
        <button className={BUTTON} type="button" onClick={props.onNext}>
          {props.next}
        </button>
      </div>
    </div>
  );
}

// The page's writes, exactly as it sends them. Each sends a JSON body: the server answers 415 to a
// write without one.
export function skipBanks() {
  const skip = { param: { step: "banks" }, json: {} };
  return api.setup.steps[":step"].skip.$post(skip);
}
export const finishWizard = () => api.setup.finish.$post({ json: {} });
export const confirmMasterKeySaved = () => api.setup["master-key"].$post({ json: {} });

// What Continue says while the server does not yet count Banks as done.
export const BANKS_NOT_DONE = "Link a bank first, or press Skip for now.";

// Step 5's buttons: Back, "Skip for now", and Continue, which waits for a Connection.
export function BanksButtons(props: {
  busy: boolean;
  linked: boolean;
  notDone: string | undefined;
  error: string | undefined;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      <BackButton onBack={props.onBack} disabled={props.busy} />
      <button className={SECOND_BUTTON} type="button" disabled={props.busy} onClick={props.onSkip}>
        Skip for now
      </button>
      <button
        className={BUTTON}
        type="button"
        disabled={props.busy || !props.linked}
        onClick={props.onContinue}
      >
        Continue to Finish
      </button>
      <ErrorLine error={props.notDone ?? props.error} />
    </div>
  );
}

// Step 5's screen: the Plaid keys, then the banks linked so far and the ways to link one: Plaid
// Link, and under `pnpm dev` the fake bank. Unconnected accounts, Manual loans, and Import Plaid
// Connection wait in Settings, Banks.
export function BanksStepView(props: {
  plaid: PlaidView;
  connections: ConnectionView[];
  accounts: AccountView[];
  fakeBank: boolean;
  onPlaidSaved: (plaid: PlaidView) => void;
  onLinked: () => void;
}) {
  return (
    <>
      <p className="mt-4">
        The app reads your Transactions through Plaid. First save your Plaid keys, then link each
        bank.
      </p>
      <PlaidKeysForm plaid={props.plaid} onSaved={props.onPlaidSaved} />
      <section className="mt-6">
        <h3 className="font-semibold">Link your banks</h3>
        <p className="mt-2 text-gray-600">
          Save the keys first. Then link each bank once, and pick every Account at that bank.
        </p>
        <ConnectionList connections={props.connections} accounts={props.accounts} />
        <LinkBank
          plaid={props.plaid}
          connections={props.connections}
          accounts={props.accounts}
          onLinked={props.onLinked}
        />
        <FakeBankLink offered={props.fakeBank} onLinked={props.onLinked} />
      </section>
      <p className="mt-4 text-gray-600">
        For a bank Plaid cannot reach, or a loan the banks do not show, use Settings, Banks after
        setup.
      </p>
    </>
  );
}

// The words to show for a refused request: the server's own.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// Step 5, Banks. `onProgress` gets the server's answer, which names the step to open next.
export function BanksStep(props: {
  onBack: () => void;
  onProgress: (progress: SetupProgressView) => void;
}) {
  const { onProgress } = props;
  const [plaid, setPlaid] = useState<PlaidView | undefined>();
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [fakeBank, setFakeBank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notDone, setNotDone] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    Promise.all([api.plaid.settings.$get(), api.connections.$get(), api.accounts.$get()])
      .then(async ([plaidRes, connectionsRes, accountsRes]) => {
        for (const res of [plaidRes, connectionsRes, accountsRes]) {
          if (!res.ok) return setError(await refusal(res));
        }
        setPlaid(((await plaidRes.json()) as { plaid: PlaidView }).plaid);
        const listed = (await connectionsRes.json()) as {
          connections: ConnectionView[];
          fakeBank: boolean;
        };
        // A removed Connection covers no bank, so the step lists only the others.
        setConnections(listed.connections.filter((connection) => !connection.removed));
        setFakeBank(listed.fakeBank);
        setAccounts(((await accountsRes.json()) as { accounts: AccountView[] }).accounts);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  useEffect(load, [load]);

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
      if (body.progress.next === "banks") return setNotDone(BANKS_NOT_DONE);
      onProgress(body.progress);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {plaid === undefined ? null : (
        <BanksStepView
          plaid={plaid}
          connections={connections}
          accounts={accounts}
          fakeBank={fakeBank}
          onPlaidSaved={setPlaid}
          onLinked={load}
        />
      )}
      {/* Continue asks the server whether Banks is done. Skip for now marks it skipped, unless it
          is done. */}
      <BanksButtons
        busy={busy}
        linked={connections.length > 0}
        notDone={notDone}
        error={error}
        onBack={props.onBack}
        onSkip={() => void run(skipBanks)}
        onContinue={() => void run(() => api.setup.progress.$get())}
      />
    </>
  );
}

// Step 6's words: history is loading, or, with no Connection, where Banks waits.
export function finishLines(connections: number): string[] {
  if (connections === 0) {
    return [
      "The Household has no Connection yet, so no bank history is loading.",
      'Link your banks from the "Finish setup" list on the dashboard, or in Settings, Banks.',
    ];
  }
  return [
    "Your banks' history is loading now. You can use the app while it loads.",
    "A full load can take a few hours. The dashboard shows the progress for each Connection.",
  ];
}

// The optional extras, as step 6 lists them. Each opens its Settings section.
export const EXTRA_LINES: Record<SetupExtra, { title: string; text: string; action: string }> = {
  ai: {
    title: "AI helper",
    text: "Sorts Transactions into Categories and answers questions. Needs an AI provider. The first AI run on all history costs about $0.20. It counts against the AI cost cap.",
    action: "Set up AI",
  },
  alerts: {
    title: "Alerts by email",
    text: "Big charges, low balances, and bank problems. Needs an SMTP account.",
    action: "Set up Alerts",
  },
  "invite members": {
    title: "Invite Members",
    text: "Every Member sees the whole Household.",
    action: "Make an invite link",
  },
};

export function FinishStepView(props: {
  connections: number;
  extras: readonly SetupExtra[];
  busy: boolean;
  error: string | undefined;
  onBack: () => void;
  onOpen: () => void;
  onExtra: (path: string) => void;
}): ReactNode {
  return (
    <div className="mt-4">
      {finishLines(props.connections).map((line) => (
        <p key={line} className="mt-2">
          {line}
        </p>
      ))}
      <div className="flex flex-wrap gap-3">
        <BackButton onBack={props.onBack} disabled={props.busy} />
        <button className={BUTTON} type="button" disabled={props.busy} onClick={props.onOpen}>
          Open the dashboard
        </button>
      </div>
      <ErrorLine error={props.error} />
      {props.extras.length === 0 ? null : (
        <section className="mt-8">
          <h3 className="font-semibold">Optional extras</h3>
          <p className="mt-1 text-gray-600">
            Do these now or later. They also wait in the dashboard's "Finish setup" list.
          </p>
          <ul className="mt-2 flex flex-col gap-3">
            {props.extras.map((extra) => (
              <li key={extra}>
                <p className="font-semibold">{EXTRA_LINES[extra].title}</p>
                <p className="text-gray-600">{EXTRA_LINES[extra].text}</p>
                <button
                  className="text-blue-700 underline disabled:opacity-50"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onExtra(FINISH_SETUP_LINKS[extra].path)}
                >
                  {EXTRA_LINES[extra].action}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Step 6, Finish. Open the dashboard and each extra's link end the wizard first, so the next visit
// does not open it again.
export function FinishStep(props: {
  connections: number;
  extras: readonly SetupExtra[];
  onBack: () => void;
  onFinished: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function finish(path: string) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await finishWizard();
      if (res.ok) return props.onFinished(path);
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
      extras={props.extras}
      busy={busy}
      error={error}
      onBack={props.onBack}
      onOpen={() => void finish("/")}
      onExtra={(path) => void finish(path)}
    />
  );
}
