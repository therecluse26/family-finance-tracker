import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { HouseholdFactsView } from "../../server/household-views.ts";
import { SETUP_EXTRAS, type SetupProgressView } from "../../server/setup-views.ts";
import { api } from "../api.ts";
import { BackupCodes, ErrorLine, NewTotp, TextField } from "../components/Fields.tsx";
import { StatusText } from "../components/Status.tsx";
import { grouped } from "../master-key.ts";
import { postJson, refusalText } from "../requests.ts";
import {
  codeFromHash,
  type FirstMemberDraft,
  fetchSetupProgress,
  fetchSetupState,
  forgetSetupCode,
  savedFirstMemberDraft,
  savedSetupCode,
  saveFirstMemberDraft,
  saveSetupCode,
  setupCodeRefused,
  skippedWizardSteps,
} from "../setup-gate.ts";
import {
  BackButton,
  BanksStep,
  BUTTON_ROW,
  confirmMasterKeySaved,
  DoneStepView,
  FinishStep,
  focusStepTitle,
  LEAD,
  PRIMARY_BUTTON,
  StepCard,
  Stepper,
  stepAfter,
  stepBefore,
  WIZARD_STEPS,
  WizardFrame,
  type WizardStep,
} from "./SetupSteps.tsx";
import { HouseholdFactsForm } from "./settings/Household.tsx";

// The first-run wizard (spec 12, The first-run wizard), in 6 steps. Step 1 takes the setup code
// from the setup link, step 2 makes the first Member's login, and step 3 shows the Master key until
// the Member says they saved it. Step 4 records the Household facts, which ends page gating. Steps
// 5, Banks, and 6, Finish, follow for the first Member only (SetupSteps.tsx). Back opens the step
// before; a step whose work is done for good, such as the login, then says so.

const WRONG_SETUP_CODE = "That setup code is wrong. Check the link that fft setup printed.";

// The setup boards' fields: a bold label over a 44 px box. The shared TextField keeps its parts, so
// the step's wrapper sets their look.
const FIELDS =
  "[&_input]:mt-1.5 [&_input]:h-11 [&_input]:rounded-[10px] [&_input]:text-[15px] [&_input]:font-normal [&_label]:mt-4 [&_label]:text-sm [&_label]:font-semibold";
// A code typed by hand: set in the code font, spaced out.
const CODE_FIELD = "[&_input]:font-mono [&_input]:tracking-[.08em]";
// The step's way on, at the right of its button row.
const NEXT = `${PRIMARY_BUTTON} ml-auto`;

// Step 1's answer to the setup link, as a status. The region is always there, so screen readers
// hear the answer as it lands.
export function SetupLinkWorked(props: { worked: boolean }) {
  return (
    <div role="status">
      {props.worked ? (
        <p className="mt-7 rounded-[10px] bg-[#E9F6EE] px-4 py-3.5 font-semibold">
          <StatusText tone="good">Your setup link worked. The code is filled in.</StatusText>
        </p>
      ) : null}
    </div>
  );
}

// Step 1. A code from the setup link is checked at once. One kept from before a reload goes on to
// step 2 at once; one from the link waits for Continue.
function SetupLink(props: {
  initialCode: string | undefined;
  goOnAtOnce: boolean;
  onDone: (code: string) => void;
}) {
  const { initialCode, goOnAtOnce, onDone } = props;
  const [code, setCode] = useState(initialCode ?? "");
  // The code the server took, while the field still holds it.
  const [checked, setChecked] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function check(entered: string, goOn: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await postJson("/api/auth/first-member/check-code", { setupCode: entered });
      if (!res.ok) {
        if (setupCodeRefused(res.status)) forgetSetupCode();
        return setError(await refusalText(res, WRONG_SETUP_CODE));
      }
      // The code is kept exactly as the server took it, and sent again as it is.
      saveSetupCode(entered);
      if (goOn) return onDone(entered);
      setChecked(entered);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: check once, for the first code.
  useEffect(() => {
    if (initialCode !== undefined) void check(initialCode, goOnAtOnce);
  }, [initialCode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (checked !== undefined && checked === code) return onDone(code);
    void check(code, true);
  }

  const worked = checked !== undefined && checked === code;
  return (
    <StepCard step="setup link">
      <form onSubmit={submit}>
        <p className={LEAD}>
          Setup takes about 5 minutes. You make your login, save the Master key, and connect your
          banks.
        </p>
        <SetupLinkWorked worked={worked} />
        {worked ? null : (
          <p className="mt-6">Enter the setup code from the setup link that fft setup printed.</p>
        )}
        <div className={`${FIELDS} ${CODE_FIELD} [&_input]:h-12 [&_input]:text-base`}>
          <TextField
            label="Setup code, such as 7KQ2-M9XD-4TRF"
            autoComplete="off"
            value={code}
            onChange={setCode}
          />
        </div>
        <p className="mt-2 text-small text-muted">
          The code stays if you reload this page. You only need the terminal again if you close the
          tab.
        </p>
        <div className={BUTTON_ROW}>
          <button className={NEXT} type="submit" disabled={busy}>
            Continue to your login
          </button>
        </div>
        <ErrorLine error={error} />
      </form>
    </StepCard>
  );
}

// Step 2: name, email, and password, then TOTP, then the backup codes. Name and Email survive a
// reload, with the setup code; the password does not.
export function FirstMember(props: { setupCode: string; onBack: () => void; onDone: () => void }) {
  const [draft, setDraft] = useState(savedFirstMemberDraft);
  const { name, email } = draft;
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | undefined>();
  const [totpCode, setTotpCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Each new screen of the step takes the focus on the step's title, as a new step does.
  const screen =
    backupCodes !== undefined ? "backup codes" : totpURI !== undefined ? "authenticator" : "login";
  const screenBefore = useRef(screen);
  useEffect(() => {
    if (screenBefore.current === screen) return;
    screenBefore.current = screen;
    focusStepTitle(document.querySelector("main"));
  }, [screen]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  function change(next: FirstMemberDraft) {
    setDraft(next);
    saveFirstMemberDraft(next);
  }

  function startTotp(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) return setError("A password has at least 12 characters.");
    void run(async () => {
      const res = await postJson("/api/auth/first-member/new-totp", {
        setupCode: props.setupCode,
        email,
      });
      if (!res.ok) return setError(await refusalText(res, WRONG_SETUP_CODE));
      setTotpURI(((await res.json()) as { totpURI: string }).totpURI);
    });
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await postJson("/api/auth/first-member/create", {
        setupCode: props.setupCode,
        name,
        email,
        password,
        totpCode: totpCode.trim(),
      });
      if (!res.ok) return setError(await refusalText(res, "Wrong code."));
      // The setup code no longer works once the first Member exists.
      forgetSetupCode();
      setPassword("");
      setBackupCodes(((await res.json()) as { backupCodes: string[] }).backupCodes);
    });
  }

  if (backupCodes !== undefined) {
    return (
      <StepCard step="first member">
        <p className={`${LEAD} font-semibold`}>
          <StatusText tone="good">You are the first Member, and you are signed in.</StatusText>
        </p>
        <BackupCodes codes={backupCodes} />
        <div className={BUTTON_ROW}>
          <button className={NEXT} type="button" onClick={props.onDone}>
            I saved my backup codes. Continue to the Master key
          </button>
        </div>
      </StepCard>
    );
  }

  if (totpURI !== undefined) {
    return (
      <StepCard step="first member">
        <form onSubmit={create}>
          <h2 className="mt-5 text-heading font-bold">Add this login to your authenticator app</h2>
          <p className="mt-1.5 text-ink-soft">
            Scan the code. You enter a code from the app each time you sign in, and only then.
          </p>
          <NewTotp totpURI={totpURI} />
          <div className={`${FIELDS} ${CODE_FIELD} [&_input]:max-w-[11.25rem] [&_input]:text-lg`}>
            <TextField
              label="6-digit code from the app"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={setTotpCode}
            />
          </div>
          <div className={BUTTON_ROW}>
            <BackButton onBack={() => setTotpURI(undefined)} disabled={busy} />
            <button className={NEXT} type="submit" disabled={busy}>
              Make my login
            </button>
          </div>
          <ErrorLine error={error} />
        </form>
      </StepCard>
    );
  }

  return (
    <StepCard step="first member">
      <form onSubmit={startTotp}>
        <p className={LEAD}>You are the first Member. You can invite the others later.</p>
        <div className={`${FIELDS} mt-2`}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              label="Name"
              autoComplete="name"
              value={name}
              onChange={(next) => change({ name: next, email })}
            />
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(next) => change({ name, email: next })}
            />
          </div>
          <TextField
            label="Password, at least 12 characters"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
          />
        </div>
        <div className={BUTTON_ROW}>
          <BackButton onBack={props.onBack} disabled={busy} />
          <button className={NEXT} type="submit" disabled={busy}>
            Continue to the authenticator app
          </button>
        </div>
        <ErrorLine error={error} />
      </form>
    </StepCard>
  );
}

// What Copy did, as a status that screen readers hear: the key is on the clipboard, or the Member
// copies it by hand.
export function CopiedLine(props: { copied: "copied" | "cannot copy" | undefined }) {
  return (
    <p className="mt-2 text-small font-semibold" role="status">
      {props.copied === "copied" ? (
        <StatusText tone="good">Copied. Paste it into your password manager now.</StatusText>
      ) : props.copied === "cannot copy" ? (
        <StatusText tone="serious">
          This browser cannot copy here. Select the key and copy it.
        </StatusText>
      ) : null}
    </p>
  );
}

// Step 3: the Master key, shown on each visit until the Member says they saved it. The app asks
// for no paste-back.
function MasterKey(props: { onBack: () => void; onDone: () => void }) {
  const [masterKey, setMasterKey] = useState<string | undefined>();
  // What Copy did: the key is on the clipboard, or the Member copies it by hand.
  const [copied, setCopied] = useState<"copied" | "cannot copy" | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api.setup["master-key"]
      .$get()
      .then(async (res) => {
        if (res.status === 200) setMasterKey((await res.json()).masterKey);
        else setError("The Master key cannot be shown.");
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  // The clipboard needs HTTPS or localhost. Elsewhere the Member copies the key by hand.
  function copy() {
    if (masterKey === undefined) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) return setCopied("cannot copy");
    clipboard
      .writeText(masterKey)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("cannot copy"));
  }

  function saved() {
    setBusy(true);
    setError(undefined);
    confirmMasterKeySaved()
      .then(async (res) => {
        if (res.ok) return props.onDone();
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(typeof body.error === "string" ? body.error : "That did not work.");
      })
      .catch(() => setError("The server did not answer."))
      .finally(() => setBusy(false));
  }

  return (
    <StepCard step="master key">
      <p className={LEAD}>
        The Master key locks the bank and AI keys the app stores, here and in each backup. Put it in
        your password manager, off this server. Without it, every Connection must be made again.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-page px-5 py-4">
        <p className="min-w-0 flex-[1_1_18rem] font-mono text-base leading-[1.8] tracking-[.04em] break-all">
          {masterKey === undefined ? null : grouped(masterKey)}
        </p>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-control bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          disabled={masterKey === undefined}
          onClick={copy}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="5"
              y="5"
              width="9"
              height="9"
              rx="2"
              stroke="#fff"
              strokeWidth="1.6"
              fill="none"
            />
            <path
              d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5"
              stroke="#fff"
              strokeWidth="1.6"
              fill="none"
            />
          </svg>
          Copy
        </button>
      </div>
      <CopiedLine copied={copied} />
      <p className="mt-4 text-sm text-muted">
        After this step, the app never shows the Master key again.
      </p>
      <div className={BUTTON_ROW}>
        <BackButton onBack={props.onBack} disabled={busy} />
        <button
          className={NEXT}
          type="button"
          disabled={busy || masterKey === undefined}
          onClick={saved}
        >
          I saved it
        </button>
      </div>
      <ErrorLine error={error} />
    </StepCard>
  );
}

// Step 4: the Household facts, filled in with the saved ones when Back opens the step again.
function HouseholdStep(props: { onBack: () => void; onSaved: () => void }) {
  const [facts, setFacts] = useState<HouseholdFactsView | null | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api.household
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError("The Household facts did not load.");
        setFacts(((await res.json()) as { facts: HouseholdFactsView | null }).facts);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  // The form is Settings, Household's own, with its own Save button, so Back sits under it.
  return (
    <StepCard step="household facts">
      <p className={LEAD}>The app uses these to compare your spending with similar households.</p>
      <ErrorLine error={error} />
      {facts === undefined ? null : (
        <HouseholdFactsForm
          facts={facts}
          submitLabel="Save and continue to Banks"
          onSaved={props.onSaved}
        />
      )}
      <div className={BUTTON_ROW}>
        <BackButton onBack={props.onBack} />
      </div>
    </StepCard>
  );
}

// The list of steps. The server's progress says which steps were skipped, so a skipped Banks step
// shows as not done after Skip for now and after a reload alike.
export function WizardHeader(props: {
  shown: WizardStep;
  reached: WizardStep;
  progress: SetupProgressView | undefined;
}) {
  return (
    <Stepper
      shown={props.shown}
      reached={props.reached}
      skipped={skippedWizardSteps(props.progress)}
    />
  );
}

export function Setup() {
  const navigate = useNavigate();
  // The furthest step the Member can open, and the step on the screen, which Back moves.
  const [reached, setReached] = useState<WizardStep | undefined>();
  const [shown, setShown] = useState<WizardStep | undefined>();
  const [firstCode, setFirstCode] = useState<{ code: string; goOnAtOnce: boolean } | undefined>();
  const [setupCode, setSetupCode] = useState<string | undefined>();
  const [progress, setProgress] = useState<SetupProgressView | undefined>();

  function open(step: WizardStep) {
    setReached(step);
    setShown(step);
  }

  // Opens the first step that is neither done nor skipped. Steps 3 to 6 need the first Member
  // signed in. Once steps 1 to 4 are done, the server names the next step for the signed-in
  // Member, and none for a Member other than the first.
  async function load() {
    const state = await fetchSetupState();
    if (state.wizard && state.next === "setup link") return open("setup link");
    // A Member exists, so the setup code no longer works.
    forgetSetupCode();
    if ((await api.ping.$get()).status === 401) return navigate("/sign-in", { replace: true });
    if (state.wizard && state.next !== null) return open(state.next as WizardStep);
    const found = await fetchSetupProgress();
    if (found === undefined) return navigate("/", { replace: true });
    show(found);
  }

  function show(found: SetupProgressView) {
    if (found.next === null) return void navigate("/", { replace: true });
    setProgress(found);
    open(found.next);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    // The code stays out of the address bar and the browser history once the page has it. A code
    // kept from before a reload goes on to step 2 at once.
    const fromLink = codeFromHash(window.location.hash);
    if (fromLink !== undefined) {
      setFirstCode({ code: fromLink, goOnAtOnce: false });
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      const kept = savedSetupCode();
      if (kept !== undefined) setFirstCode({ code: kept, goOnAtOnce: true });
    }
    load().catch(() => {});
  }, []);

  const back = (step: WizardStep) => () => setShown(stepBefore(step));
  const forward = (step: WizardStep) => () => setShown(stepAfter(step));
  const done = (step: WizardStep) =>
    reached !== undefined && WIZARD_STEPS.indexOf(reached) > WIZARD_STEPS.indexOf(step);

  return (
    <WizardFrame
      shown={shown}
      steps={
        shown === undefined || reached === undefined ? null : (
          <WizardHeader shown={shown} reached={reached} progress={progress} />
        )
      }
    >
      {/* The page reads which step to open. */}
      {shown === undefined ? <StepCard step={undefined} /> : null}
      {shown === "setup link" ? (
        <SetupLink
          key={setupCode ?? firstCode?.code ?? ""}
          initialCode={setupCode ?? firstCode?.code}
          goOnAtOnce={setupCode === undefined && firstCode?.goOnAtOnce === true}
          onDone={(code) => {
            setSetupCode(code);
            open("first member");
          }}
        />
      ) : null}
      {shown === "first member" && !done("first member") && setupCode !== undefined ? (
        <FirstMember
          setupCode={setupCode}
          onBack={back("first member")}
          onDone={() => void load()}
        />
      ) : null}
      {shown === "first member" && done("first member") ? (
        <DoneStepView
          step="first member"
          lines={["Your login is made, and you are signed in."]}
          next="Continue to the Master key"
          onNext={forward("first member")}
        />
      ) : null}
      {shown === "master key" && !done("master key") ? (
        <MasterKey onBack={back("master key")} onDone={() => void load()} />
      ) : null}
      {shown === "master key" && done("master key") ? (
        <DoneStepView
          step="master key"
          lines={[
            "You saved the Master key, so the app does not show it again.",
            'To test your saved copy, use "Check my Master key" in Settings, Backups and data.',
          ]}
          next="Continue to Household"
          onBack={back("master key")}
          onNext={forward("master key")}
        />
      ) : null}
      {shown === "household facts" ? (
        <HouseholdStep onBack={back("household facts")} onSaved={() => void load()} />
      ) : null}
      {shown === "banks" ? <BanksStep onBack={back("banks")} onProgress={show} /> : null}
      {shown === "finish" ? (
        <FinishStep
          connections={progress?.connections ?? 0}
          extras={SETUP_EXTRAS.filter((extra) => progress?.steps[extra] !== "done")}
          onBack={back("finish")}
          onFinished={(path) => void navigate(path, { replace: true })}
        />
      ) : null}
    </WizardFrame>
  );
}
