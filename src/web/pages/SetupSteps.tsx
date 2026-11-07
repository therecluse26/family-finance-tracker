import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { PlaidView } from "../../bank/plaid-view.ts";
import type { StatusTone } from "../../format.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import type { SetupExtra, SetupProgressView } from "../../server/setup-views.ts";
import { api } from "../api.ts";
import { ErrorLine } from "../components/Fields.tsx";
import { StatusText } from "../components/Status.tsx";
import { answerOrder } from "../polling.ts";
import { SignedOut } from "../requests.ts";
import { FINISH_SETUP_LINKS } from "../setup-gate.ts";
import { PlaidKeysForm } from "./settings/Banks.tsx";
import { CONNECTIONS_READS, NewBankLinks, readJson } from "./settings/Connections.tsx";
import {
  CONNECTIONS_UNREAD,
  type ConnectionsPageView,
  type ConnectionsReads,
  createConnectionsPage,
  Refused,
} from "./settings/connections-page.ts";

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

// Each step's heading, the page's one <h1>. Each step's card shows it, whether or not its own reads
// have answered.
export const STEP_TITLES: Record<WizardStep, string> = {
  "setup link": "Welcome. Let's set up your Household.",
  "first member": "Make your login",
  "master key": "Save your Master key",
  "household facts": "About your Household",
  banks: "Connect your banks",
  finish: "You are set up",
};

// The heading while the page reads which step to open.
const OPENING_TITLE = "Set up Family Finance Tracker";

// The wizard's buttons, from the setup boards: taller than the app's, so the one way on stands out.
// The primary button is the step's way on; it sits on the right of the step's button row.
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50";
export const PRIMARY_BUTTON = `inline-flex min-h-12 items-center justify-center rounded-[10px] bg-accent px-5 py-2 text-center text-base font-semibold text-white hover:bg-accent-dark sm:px-7 ${FOCUS} ${DISABLED}`;
export const SECOND_BUTTON = `inline-flex min-h-11 items-center justify-center rounded-[10px] border border-field bg-white px-[18px] py-2 text-center text-[15px] text-ink hover:bg-page ${FOCUS} ${DISABLED}`;
// A step's buttons: Back on the left, the way on at the right.
export const BUTTON_ROW = "mt-7 flex flex-wrap items-center gap-3";
// The line under a step's heading.
export const LEAD = "mt-2 text-base leading-[1.55] text-ink-soft";

// The app's mark, as the menu column draws it.
function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <rect width="28" height="28" rx="7" className="fill-accent" />
      <path
        d="M8 18l4-5 3 3 5-7"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Whether the step's title takes the focus: only when the Member moves from one step to another
// (Continue, Back, "I saved it"), not when the page first opens a step. The button they pressed is
// gone with the step, so the focus would fall to the page.
export function movesFocusToTitle(before: WizardStep | undefined, now: WizardStep | undefined) {
  return before !== undefined && now !== undefined && before !== now;
}

type Focusable = Pick<HTMLElement, "hasAttribute" | "setAttribute" | "focus">;

// The new step takes the focus on its <h1>, or on the <main>, as the Shell does for a page chosen in
// the phone menu.
export function focusStepTitle(main: (Focusable & Pick<ParentNode, "querySelector">) | null) {
  if (main === null) return;
  const target: Focusable = main.querySelector<HTMLElement>("h1") ?? main;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

// The wizard's page: a white header with the app's name and a bar of the 6 steps, then the list of
// steps beside the step's card. On a phone the header shows the step on the screen, and the list of
// steps folds into lines above the card. The wizard has no menu and no tab bar.
export function WizardFrame(props: {
  shown: WizardStep | undefined;
  steps: ReactNode;
  children: ReactNode;
}) {
  const shownAt = props.shown === undefined ? -1 : WIZARD_STEPS.indexOf(props.shown);
  const main = useRef<HTMLElement>(null);
  const shownBefore = useRef(props.shown);
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = props.shown;
    if (movesFocusToTitle(before, props.shown)) focusStepTitle(main.current);
  }, [props.shown]);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-8 sm:py-5">
          <div className="flex min-w-0 items-center gap-2.5 font-semibold">
            <BrandMark />
            {/* Below 768 px the list of steps hides its "Step N of 6", so the header shows it. */}
            <span className="max-md:hidden">Family Finance Tracker</span>
            {props.shown === undefined ? (
              <span className="md:hidden">Family Finance Tracker</span>
            ) : (
              // The list of steps says the same to screen readers.
              <span className="min-w-0 md:hidden" aria-hidden="true">
                <span className="block text-xs font-semibold tracking-[.06em] text-muted uppercase">
                  Step {shownAt + 1} of {WIZARD_STEPS.length}
                </span>
                <span className="block">{STEP_LABELS[props.shown]}</span>
              </span>
            )}
          </div>
          <span className="text-sm text-muted">Setup</span>
        </div>
        <div className="flex gap-1 px-4 sm:gap-1.5 sm:px-8" aria-hidden="true">
          {WIZARD_STEPS.map((step, at) => (
            <div
              key={step}
              className={`h-1 flex-1 rounded-sm ${at <= shownAt ? "bg-accent" : "bg-line"}`}
              data-slot="step-bar"
            />
          ))}
        </div>
      </header>
      <main
        ref={main}
        className="mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-4 px-4 pt-5 pb-10 sm:pt-8 md:flex-row md:items-start md:gap-10 md:pt-10"
      >
        {props.steps}
        <div className="flex min-w-0 flex-1 flex-col gap-5">{props.children}</div>
      </main>
    </div>
  );
}

// A step's white card, with the step's heading. `step` is undefined while the page reads which step
// to open.
export function StepCard(props: { step: WizardStep | undefined; children?: ReactNode }) {
  return (
    <section
      aria-labelledby="step-title"
      className="rounded-card border border-line bg-white px-5 py-6 sm:px-10 sm:py-9"
    >
      <h1 id="step-title" className="text-2xl font-bold tracking-[-.01em] sm:text-[28px]">
        {props.step === undefined ? OPENING_TITLE : STEP_TITLES[props.step]}
      </h1>
      {props.children}
    </section>
  );
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
    <nav aria-label="Setup steps" className="md:w-[220px] md:shrink-0">
      {/* Below 768 px the header shows it, at the same width as WizardFrame's. */}
      <p className="text-small font-semibold tracking-[.06em] text-muted uppercase max-md:sr-only">
        Step {shownAt + 1} of {WIZARD_STEPS.length}
      </p>
      <ol className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-small md:mt-4 md:flex-col md:gap-1 md:text-[15px]">
        {WIZARD_STEPS.map((step, at) => {
          const current = at === shownAt;
          const done = at < reachedAt && !skipped.includes(step);
          const mark = current
            ? "bg-accent text-white"
            : done
              ? "bg-[#DCE5FB] text-accent"
              : "border border-field";
          return (
            <li
              key={step}
              aria-current={current ? "step" : undefined}
              className={`flex items-center gap-1.5 md:gap-3 md:rounded-control md:px-3 md:py-2.5 ${current ? "font-semibold text-ink md:bg-nav-current" : done ? "text-ink" : "text-muted"}`}
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs md:size-6 md:text-[13px] ${mark}`}
              >
                {/* Spec 12's words: "5. Banks (skipped)". One text run, so the browser and screen
                    readers read "5." whole. */}
                {done ? "✓" : `${at + 1}.`}
              </span>{" "}
              <span>
                {STEP_LABELS[step]}
                {skipped.includes(step) ? " (skipped)" : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

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
  step: WizardStep;
  lines: string[];
  next: string;
  onBack?: () => void;
  onNext: () => void;
}) {
  return (
    <StepCard step={props.step}>
      {props.lines.map((line, at) => (
        <p key={line} className={at === 0 ? LEAD : "mt-3"}>
          {line}
        </p>
      ))}
      <div className={BUTTON_ROW}>
        {props.onBack === undefined ? null : <BackButton onBack={props.onBack} />}
        <button className={`${PRIMARY_BUTTON} ml-auto`} type="button" onClick={props.onNext}>
          {props.next}
        </button>
      </div>
    </StepCard>
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

// Step 5's buttons: Back, "Skip for now", and Continue, which waits for a Connection. On a phone,
// Skip for now and Continue share the row under Back, as the phone board draws them.
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
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <BackButton onBack={props.onBack} disabled={props.busy} />
        <div className="flex w-full items-center gap-2.5 sm:ml-auto sm:w-auto">
          <button
            className={`${SECOND_BUTTON} flex-1 sm:flex-none sm:border-transparent sm:bg-transparent sm:font-semibold sm:text-accent sm:hover:bg-transparent sm:hover:text-accent-dark sm:hover:underline`}
            type="button"
            disabled={props.busy}
            onClick={props.onSkip}
          >
            Skip for now
          </button>
          <button
            className={`${PRIMARY_BUTTON} flex-1 sm:flex-none`}
            type="button"
            disabled={props.busy || !props.linked}
            onClick={props.onContinue}
          >
            Continue to Finish
          </button>
        </div>
      </div>
      <ErrorLine error={props.notDone ?? props.error} />
    </div>
  );
}

// One part of step 5, numbered as the board draws it: 1 the Plaid keys, 2 the banks.
function BanksPart(props: { number: number; rule?: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 ${props.rule ? "mt-7 border-t border-line pt-6" : "mt-6"}`}
    >
      <span
        aria-hidden="true"
        className="mt-px flex size-6 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-white"
      >
        {props.number}
      </span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

// A linked bank's mark: "✓ Linked" once its Connection exists, or what it needs.
function bankMark(connection: ConnectionView): { tone: StatusTone; word: string } {
  if (connection.held) return { tone: "muted", word: "Not in use" };
  if (connection.health === "broken") return { tone: "critical", word: "Disconnected" };
  if (connection.health === "needs a member") return { tone: "serious", word: "Needs a sign-in" };
  return { tone: "good", word: "Linked" };
}

// What a linked bank's line says: its first sync, or its count of Accounts and its history.
function bankLine(connection: ConnectionView, accounts: number): string {
  if (connection.held) return "Another Connection already covers this bank, so it never syncs.";
  if (connection.health === "broken" || connection.health === "needs a member") {
    return "Fix it in Settings, Banks after setup.";
  }
  if (connection.lastSyncedAt === null) return "First sync running: getting the Accounts";
  const count = `${accounts} ${accounts === 1 ? "Account" : "Accounts"}`;
  return `${count} · ${connection.historyLoaded ? "history loaded" : "loading history"}`;
}

// The banks linked so far, one card each. The Accounts are counted, not listed: the Link panel
// lists a new bank's Accounts as they arrive, so the step shows each Account once.
export function LinkedBankList(props: { connections: ConnectionView[]; accounts: AccountView[] }) {
  if (props.connections.length === 0) {
    return <p className="mt-3 text-sm text-muted">No bank is connected yet.</p>;
  }
  return (
    <ul aria-label="Your banks" className="mt-3 flex flex-col gap-2.5">
      {props.connections.map((connection) => {
        const mark = bankMark(connection);
        const accounts = props.accounts.filter((a) => a.connectionId === connection.id).length;
        return (
          <li key={connection.id} className="rounded-[10px] border border-line px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 font-semibold">{connection.bankName}</p>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${mark.tone === "good" ? "bg-[#E9F6EE]" : "border border-line"}`}
              >
                <StatusText tone={mark.tone}>{mark.word}</StatusText>
              </span>
            </div>
            <p className="mt-1 text-small text-muted">{bankLine(connection, accounts)}</p>
          </li>
        );
      })}
    </ul>
  );
}

// Step 5's screen: the Plaid keys, then the banks linked so far and the ways to link one: Plaid
// Link, and under `pnpm dev` the fake bank. Unconnected accounts, Manual loans, and Import Plaid
// Connection wait in Settings, Banks. The Link panel is Settings → Banks' own (NewBankLinks), fed
// the same page view, so it follows a new Connection's first sync until its Accounts arrive.
export function BanksStepView(props: {
  plaid: PlaidView;
  view: ConnectionsPageView;
  onPlaidSaved: (plaid: PlaidView) => void;
  onLinked: () => void;
}) {
  return (
    <>
      <BanksPart number={1}>
        <PlaidKeysForm plaid={props.plaid} onSaved={props.onPlaidSaved} />
      </BanksPart>
      <BanksPart number={2} rule>
        <h3 className="text-heading font-bold">Link your banks</h3>
        <p className="mt-1.5 text-muted">
          Link each bank once, and pick every Account at that bank.
        </p>
        <LinkedBankList connections={linkedBanks(props.view)} accounts={props.view.accounts} />
        <NewBankLinks plaid={props.plaid} view={props.view} onLinked={props.onLinked} />
      </BanksPart>
      <p className="mt-7 text-sm text-muted">
        For a bank Plaid cannot reach, or a loan the banks do not show, use Settings, Banks after
        setup.
      </p>
    </>
  );
}

// The banks step 5 lists. A removed Connection covers no bank, so the step lists only the others.
export function linkedBanks(view: ConnectionsPageView): ConnectionView[] {
  return view.connections.filter((connection) => !connection.removed);
}

// Step 5's reads: Settings → Banks' three, and the Plaid keys and Item count. Each throws Refused
// for a refusal, and SignedOut for a 401.
export type BanksStepReads = ConnectionsReads & { plaid(): Promise<{ plaid: PlaidView }> };

export type BanksStepState = {
  // Unread until the first read answers.
  plaid: PlaidView | undefined;
  page: ConnectionsPageView;
  // Why the Plaid keys did not load.
  error: string | undefined;
};

export const BANKS_STEP_UNREAD: BanksStepState = {
  plaid: undefined,
  page: CONNECTIONS_UNREAD,
  error: undefined,
};

export type BanksStepPage = {
  load(): void;
  // A bank was linked: as in Settings → Banks, a fresh poll starts and reads until its Accounts
  // arrive. A Plaid link spends an Item, so the Plaid count is read again too.
  linked(): void;
  plaidSaved(plaid: PlaidView): void;
  // The step left: no read starts, and no answer shows.
  stop(): void;
};

// Step 5's reads, on Settings → Banks' page model (createConnectionsPage), so the wizard polls
// exactly as Settings → Banks does: with its cap, never after the step leaves, and not after a 401,
// which calls `signedOut` once.
export function openBanksStep(
  reads: BanksStepReads,
  show: (state: BanksStepState) => void,
  signedOut: () => void,
): BanksStepPage {
  let state = BANKS_STEP_UNREAD;
  let stopped = false;
  const plaidOrder = answerOrder();

  const set = (change: Partial<BanksStepState>) => {
    if (stopped) return;
    state = { ...state, ...change };
    show(state);
  };
  function stop() {
    stopped = true;
    page.stop();
  }
  function leave() {
    if (stopped) return;
    stop();
    signedOut();
  }
  const page = createConnectionsPage(reads, (view) => set({ page: view }), leave);

  const readPlaid = () => {
    const newest = plaidOrder.begin();
    reads
      .plaid()
      .then(({ plaid }) => {
        if (newest()) set({ plaid, error: undefined });
      })
      .catch((failure: unknown) => {
        if (failure instanceof SignedOut) return leave();
        set({ error: failure instanceof Refused ? failure.message : "The server did not answer." });
      });
  };

  return {
    load() {
      readPlaid();
      page.load();
    },
    linked() {
      page.linked();
      readPlaid();
    },
    plaidSaved(plaid) {
      if (plaidOrder.begin()()) set({ plaid, error: undefined });
    },
    stop,
  };
}

const BANKS_STEP_READS: BanksStepReads = {
  ...CONNECTIONS_READS,
  plaid: async () => readJson<{ plaid: PlaidView }>(await api.plaid.settings.$get()),
};

// Step 5, Banks. `onProgress` gets the server's answer, which names the step to open next. An ended
// session sends the Member to sign-in.
export function BanksStep(props: {
  onBack: () => void;
  onProgress: (progress: SetupProgressView) => void;
}) {
  const { onProgress } = props;
  const navigate = useNavigate();
  const [state, setState] = useState(BANKS_STEP_UNREAD);
  const [step, setStep] = useState<BanksStepPage | undefined>();
  const [busy, setBusy] = useState(false);
  const [notDone, setNotDone] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const { plaid, page } = state;

  useEffect(() => {
    const opened = openBanksStep(BANKS_STEP_READS, setState, () =>
      navigate("/sign-in", { replace: true }),
    );
    setStep(opened);
    opened.load();
    return opened.stop;
  }, [navigate]);

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
    <StepCard step="banks">
      <p className={LEAD}>
        The app reads your Transactions from your banks through Plaid. Save your Plaid keys before
        you link a real bank.
      </p>
      {plaid === undefined ? null : (
        <BanksStepView
          plaid={plaid}
          view={page}
          onPlaidSaved={(saved) => step?.plaidSaved(saved)}
          onLinked={() => step?.linked()}
        />
      )}
      {/* Continue asks the server whether Banks is done. Skip for now marks it skipped, unless it
          is done. */}
      <BanksButtons
        busy={busy}
        linked={linkedBanks(page).length > 0}
        notDone={notDone}
        error={error ?? state.error ?? page.error}
        onBack={props.onBack}
        onSkip={() => void run(skipBanks)}
        onContinue={() => void run(() => api.setup.progress.$get())}
      />
    </StepCard>
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
  const [lead, ...more] = finishLines(props.connections);
  return (
    <>
      <StepCard step="finish">
        <p className={LEAD}>{lead}</p>
        {more.map((line) => (
          <p key={line} className="mt-3 text-sm text-muted">
            {line}
          </p>
        ))}
        <div className={BUTTON_ROW}>
          <BackButton onBack={props.onBack} disabled={props.busy} />
          <button
            className={`${PRIMARY_BUTTON} ml-auto`}
            type="button"
            disabled={props.busy}
            onClick={props.onOpen}
          >
            Open the dashboard
          </button>
        </div>
        <ErrorLine error={props.error} />
      </StepCard>
      {props.extras.length === 0 ? null : (
        <section
          aria-labelledby="optional-extras"
          className="rounded-card border border-line bg-white px-5 py-5 sm:px-7 sm:py-6"
        >
          <h2 id="optional-extras" className="text-heading font-bold">
            Optional extras
          </h2>
          <p className="mt-1 text-sm text-muted">
            Do these now or later. They also wait in the dashboard's "Finish setup" list.
          </p>
          <ul className="mt-3">
            {props.extras.map((extra) => (
              <li
                key={extra}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-soft py-3"
              >
                <div className="min-w-0 flex-[1_1_16rem]">
                  <p className="font-semibold">{EXTRA_LINES[extra].title}</p>
                  <p className="mt-0.5 text-small text-muted">{EXTRA_LINES[extra].text}</p>
                </div>
                <button
                  className={`min-h-11 text-sm font-semibold text-accent hover:text-accent-dark hover:underline ${FOCUS} ${DISABLED}`}
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
    </>
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
