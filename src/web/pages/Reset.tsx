import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { BackupCodes, ErrorLine, NewTotp } from "../components/Fields.tsx";
import { postJson } from "../requests.ts";
import { tokenFromHash } from "./Join.tsx";
import { AUTH_BUTTON, AuthField, AuthFrame } from "./SignIn.tsx";

// The reset page (spec 09, Login reset): a Member opens a reset link, <APP_URL>/reset#token=…, and
// sets a new password and new TOTP, then gets 10 new backup codes. The token sits after "#", so the
// browser never sends it in the request line; the page sends it only in the body of its requests
// to /api/auth/login-reset/.

const NOT_OPEN =
  "This reset link does not work. It was used or replaced, or it is more than 24 hours old. Ask a Member for a new one.";

// The requests the page sends, each with a JSON body: the routes take only JSON.
export const checkLoginReset = (token: string) =>
  postJson("/api/auth/login-reset/check", { token });
export const newLoginResetTotp = (token: string) =>
  postJson("/api/auth/login-reset/new-totp", { token });
export const finishLoginReset = (login: { token: string; password: string; totpCode: string }) =>
  postJson("/api/auth/login-reset/finish", login);

// The server's own words for a refusal, such as a wrong code.
async function refusalOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  if (typeof body.message === "string") return body.message;
  return res.status === 429 ? "Too many tries. Wait, then try again." : "That did not work.";
}

function NewLogin(props: { token: string; email: string }) {
  const navigate = useNavigate();
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
      const res = await newLoginResetTotp(props.token);
      if (!res.ok) return setError(await refusalOf(res));
      setTotpURI(((await res.json()) as { totpURI: string }).totpURI);
    });
  }

  function finish(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await finishLoginReset({
        token: props.token,
        password,
        totpCode: totpCode.trim(),
      });
      if (!res.ok) return setError(await refusalOf(res));
      setPassword("");
      setBackupCodes(((await res.json()) as { backupCodes: string[] }).backupCodes);
    });
  }

  if (backupCodes !== undefined) {
    return (
      <div className="mt-2">
        <p>Your new login is set, and you are signed in.</p>
        <BackupCodes codes={backupCodes} />
        <button
          className={AUTH_BUTTON}
          type="button"
          onClick={() => void navigate("/", { replace: true })}
        >
          I saved my backup codes
        </button>
      </div>
    );
  }

  if (totpURI !== undefined) {
    return (
      <form className="mt-2" onSubmit={finish}>
        <p>Set up TOTP again. Your old authenticator entry no longer works.</p>
        <NewTotp totpURI={totpURI} />
        <AuthField
          label="The 6-digit code your authenticator app shows"
          autoComplete="one-time-code"
          value={totpCode}
          onChange={setTotpCode}
        />
        <button className={AUTH_BUTTON} type="submit" disabled={busy}>
          Set my new login
        </button>
        <ErrorLine error={error} />
      </form>
    );
  }

  return (
    <form className="mt-2" onSubmit={startTotp}>
      <p>
        Your login was reset. Set a new password and new TOTP for {props.email}. Your old password,
        TOTP, and backup codes no longer work.
      </p>
      <input type="hidden" autoComplete="username" value={props.email} readOnly />
      <AuthField
        label="New password, at least 12 characters"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
      />
      <button className={AUTH_BUTTON} type="submit" disabled={busy}>
        Next
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function Reset() {
  const [open, setOpen] = useState<{ token: string; email: string } | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // The token stays out of the address bar and the browser history once the page has it.
    const fromLink = tokenFromHash(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (fromLink === undefined) return setError(NOT_OPEN);
    checkLoginReset(fromLink)
      .then(async (res) => {
        if (res.ok) {
          const { email } = (await res.json()) as { email: string };
          return setOpen({ token: fromLink, email });
        }
        setError(res.status === 403 ? NOT_OPEN : await refusalOf(res));
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <AuthFrame title="Set a new login">
      {open === undefined ? null : <NewLogin token={open.token} email={open.email} />}
      <ErrorLine error={error} />
    </AuthFrame>
  );
}
