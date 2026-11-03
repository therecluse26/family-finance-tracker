import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api.ts";
import { BackupCodes, BUTTON, ErrorLine, NewTotp, TextField } from "../components/Fields.tsx";
import { postJson, refusalText } from "../requests.ts";
import { codeFromHash, fetchSetupState } from "../setup-gate.ts";

// The first-run wizard (spec 12, The first-run wizard). Step 1 takes the setup code from the setup
// link, and step 2 makes the first Member. Steps 3 and 4 come with their own tickets.

type Step = "setup link" | "first member" | "master key" | "household facts";

const TITLES: Record<Step, string> = {
  "setup link": "Step 1: Setup link",
  "first member": "Step 2: First Member",
  "master key": "Step 3: Master key",
  "household facts": "Step 4: Household facts",
};

const WRONG_SETUP_CODE = "That setup code is wrong. Check the link that fft setup printed.";

function SetupLink(props: { initialCode: string | undefined; onDone: (code: string) => void }) {
  const { initialCode, onDone } = props;
  const [code, setCode] = useState(initialCode ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function check(entered: string) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await postJson("/api/auth/first-member/check-code", { setupCode: entered });
      if (!res.ok) return setError(await refusalText(res, WRONG_SETUP_CODE));
      onDone(entered);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  // The code from the link's part after "#" is checked at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: check once, for the link's code.
  useEffect(() => {
    if (initialCode !== undefined) void check(initialCode);
  }, [initialCode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void check(code);
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <p>Enter the setup code from the setup link that fft setup printed.</p>
      <TextField
        label="Setup code, such as 7KQ2-M9XD-4TRF"
        autoComplete="off"
        value={code}
        onChange={setCode}
      />
      <button className={BUTTON} type="submit" disabled={busy}>
        Next
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

function FirstMember(props: { setupCode: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string | undefined>();
  const [totpCode, setTotpCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

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
      setPassword("");
      setBackupCodes(((await res.json()) as { backupCodes: string[] }).backupCodes);
    });
  }

  if (backupCodes !== undefined) {
    return (
      <div className="mt-4">
        <p>You are the first Member, and you are signed in.</p>
        <BackupCodes codes={backupCodes} />
        <button className={BUTTON} type="button" onClick={props.onDone}>
          I saved my backup codes
        </button>
      </div>
    );
  }

  if (totpURI !== undefined) {
    return (
      <form className="mt-4" onSubmit={create}>
        <p>Every Member signs in with a password plus TOTP.</p>
        <NewTotp totpURI={totpURI} />
        <TextField
          label="The 6-digit code your authenticator app shows"
          autoComplete="one-time-code"
          value={totpCode}
          onChange={setTotpCode}
        />
        <button className={BUTTON} type="submit" disabled={busy}>
          Make my login
        </button>
        <ErrorLine error={error} />
      </form>
    );
  }

  return (
    <form className="mt-4" onSubmit={startTotp}>
      <p>Make the login for the first Member of the Household.</p>
      <TextField label="Name" autoComplete="name" value={name} onChange={setName} />
      <TextField
        label="Email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={setEmail}
      />
      <TextField
        label="Password, at least 12 characters"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
      />
      <button className={BUTTON} type="submit" disabled={busy}>
        Next
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function Setup() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step | undefined>();
  const [linkCode, setLinkCode] = useState<string | undefined>();
  const [setupCode, setSetupCode] = useState<string | undefined>();

  // Opens the first step that is neither done nor skipped. Steps 3 and 4 need the first Member
  // signed in.
  async function load() {
    const state = await fetchSetupState();
    if (!state.wizard || state.next === null) return navigate("/", { replace: true });
    const next = state.next as Step;
    if (next !== "setup link" && (await api.ping.$get()).status === 401) {
      return navigate("/sign-in", { replace: true });
    }
    setStep(next);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, when the page opens.
  useEffect(() => {
    // The code stays out of the address bar and the browser history once the page has it.
    const fromLink = codeFromHash(window.location.hash);
    if (fromLink !== undefined) {
      setLinkCode(fromLink);
      window.history.replaceState(null, "", window.location.pathname);
    }
    load().catch(() => {});
  }, []);

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">Set up Family Finance Tracker</h1>
      {step === undefined ? null : <h2 className="mt-2 text-xl">{TITLES[step]}</h2>}
      {step === "setup link" ? (
        <SetupLink
          initialCode={linkCode}
          onDone={(code) => {
            setSetupCode(code);
            setStep("first member");
          }}
        />
      ) : null}
      {step === "first member" && setupCode !== undefined ? (
        <FirstMember setupCode={setupCode} onDone={() => void load()} />
      ) : null}
      {step === "master key" || step === "household facts" ? (
        <p className="mt-4 text-gray-600">This step is not built yet.</p>
      ) : null}
    </main>
  );
}
