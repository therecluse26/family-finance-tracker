import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";

// Sign-in takes the password, then a TOTP code or a backup code. Better Auth answers under
// /api/auth/; the web app talks to it with plain requests, since only src/auth may import it.

type Step = "password" | "code";

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

  const field = "mt-1 block w-full rounded border border-gray-300 px-3 py-2";
  const button = "mt-4 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50";

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {step === "password" ? (
        <form className="mt-4" onSubmit={submitPassword}>
          <label className="block">
            Email
            <input
              className={field}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="mt-3 block">
            Password
            <input
              className={field}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className={button} type="submit" disabled={busy}>
            Next
          </button>
        </form>
      ) : (
        <form className="mt-4" onSubmit={submitCode}>
          <label className="block">
            The 6-digit code from your authenticator app, or a backup code
            <input
              className={field}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className={button} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      )}
      {error === undefined ? null : (
        <p className="mt-3 text-red-700" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
