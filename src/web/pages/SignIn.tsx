import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PASSKEYS_PLAIN_HTTP_NOTE, passkeyState, signInWithPasskey } from "../passkeys.ts";
import { openWizardIfNeeded } from "../setup-gate.ts";

// Sign-in takes the password, then a TOTP code or a backup code. Over HTTPS a passkey alone signs
// the Member in instead. Better Auth answers under /api/auth/; the web app talks to it with plain
// requests, since only src/auth may import it.

type Step = "password" | "code";

// The sign-in card's pieces, from the approved Sign-in board. Join and Reset use them too.
export const AUTH_LABEL = "mt-4 block text-sm font-semibold";
export const AUTH_INPUT =
  "mt-1.5 block h-[46px] w-full rounded-[10px] border border-field bg-white px-3.5 text-[15px] font-normal text-ink";
const FULL_BUTTON =
  "flex h-[46px] w-full items-center justify-center rounded-[10px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
export const AUTH_BUTTON = `mt-5 ${FULL_BUTTON} bg-accent text-white hover:bg-accent-dark`;
export const AUTH_BUTTON_OUTLINED = `${FULL_BUTTON} border border-field bg-white text-ink hover:bg-page`;

// The app's mark, as the menu shows it.
function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true">
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

// A page outside the app's menu, such as sign-in: the app's name, then one white card with the
// page's heading. `note` sits under the card.
export function AuthFrame(props: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-10 sm:py-14">
      <p className="flex items-center gap-2.5 text-lg font-semibold">
        <BrandMark />
        Family Finance Tracker
      </p>
      <div className="mt-8 w-full max-w-[400px] rounded-2xl border border-line bg-white px-5 pt-7 pb-6 sm:px-7">
        <h1 className="text-[22px] font-bold">{props.title}</h1>
        {props.children}
      </div>
      {props.note === undefined ? null : (
        <p className="mt-8 max-w-[560px] text-center text-small text-muted">{props.note}</p>
      )}
    </main>
  );
}

// A text field with its label above it, on the sign-in card.
export function AuthField(props: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className={AUTH_LABEL}>
      {props.label}
      <input
        className={AUTH_INPUT}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        required
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

const TOTP_CODE = /^\d{6}$/;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

// The words to show for a refused step.
async function refusal(res: Response, wrong: string): Promise<string> {
  if (res.status === 401) return wrong;
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return typeof body.message === "string"
      ? body.message
      : "Too many tries. Wait, then try again.";
  }
  if (res.status === 403)
    return "This Member has no TOTP yet, so they cannot sign in. Ask another Member in the Household for help.";
  return "Sign-in did not work. Try again.";
}

export function SignIn() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Before the first Member exists, no one can sign in, so the page leads to the wizard.
  useEffect(() => {
    openWizardIfNeeded(navigate, "sign-in").catch(() => {});
  }, [navigate]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await post("/sign-in/email", { email, password, rememberMe: true });
      if (!res.ok) return setError(await refusal(res, "Wrong email or password."));
      setPassword("");
      setStep("code");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = code.trim();
      const res = TOTP_CODE.test(trimmed)
        ? await post("/two-factor/verify-totp", { code: trimmed })
        : await post("/two-factor/verify-backup-code", { code: trimmed });
      if (!res.ok) return setError(await refusal(res, "Wrong code."));
      await navigate("/", { replace: true });
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function signInByPasskey() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await signInWithPasskey();
      if (!res.ok) return setError("That passkey did not sign you in. Use your password instead.");
      await navigate("/", { replace: true });
    } catch {
      setError("No passkey was used. Try again, or use your password.");
    } finally {
      setBusy(false);
    }
  }

  const passkeys = passkeyState();

  return (
    <AuthFrame
      title={step === "password" ? "Sign in" : "Enter your code"}
      note="This is the only place the app asks for a code. Saving keys, exporting data and removing a bank never ask again."
    >
      {step === "password" ? (
        <form onSubmit={submitPassword}>
          <label className={AUTH_LABEL}>
            Email
            <input
              className={AUTH_INPUT}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className={AUTH_LABEL}>
            Password
            <input
              className={AUTH_INPUT}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className={AUTH_BUTTON} type="submit" disabled={busy}>
            Continue
          </button>
          {passkeys === "offered" ? (
            <>
              <p className="my-[18px] flex items-center gap-2.5 text-small text-muted">
                <span className="h-px flex-1 bg-line" aria-hidden="true" />
                or
                <span className="h-px flex-1 bg-line" aria-hidden="true" />
              </p>
              <button
                className={AUTH_BUTTON_OUTLINED}
                type="button"
                disabled={busy}
                onClick={() => void signInByPasskey()}
              >
                Sign in with a passkey
              </button>
              <p className="mt-3.5 text-center text-small text-muted">
                A passkey skips the code screen.
              </p>
            </>
          ) : null}
          {passkeys === "plain HTTP" ? (
            <p className="mt-4 text-small text-muted">{PASSKEYS_PLAIN_HTTP_NOTE}</p>
          ) : null}
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <p className="mt-1.5 text-muted">
            Open your authenticator app. Type the 6-digit code for Family Finance Tracker.
          </p>
          <label className={AUTH_LABEL}>
            Code
            <input
              className={`${AUTH_INPUT} text-center text-[22px] tracking-[.2em] tabular-nums`}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <p className="mt-1.5 text-small text-muted">
            Lost your phone? Type one of your backup codes here instead.
          </p>
          <button className={AUTH_BUTTON} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      )}
      {error === undefined ? null : (
        <p className="mt-3 text-critical" role="alert">
          {error}
        </p>
      )}
    </AuthFrame>
  );
}
