import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { BackupCodes, ErrorLine, NewTotp } from "../components/Fields.tsx";
import { postJson } from "../requests.ts";
import { AUTH_BUTTON, AuthField, AuthFrame } from "./SignIn.tsx";

// The join page (spec 09, Invites): a new Member opens an invite link, <APP_URL>/join#token=…, and
// makes their own login: a name, an email address, a password, and TOTP, then gets backup codes.
// They never see the first-run wizard. The token sits after "#", so the browser never sends it in
// the request line; the page sends it only in the body of its requests to /api/auth/invite/.

const NOT_OPEN =
  "This invite link does not work. It was used or cancelled, or it is more than 7 days old. Ask a Member for a new one.";

// The token from the link's part after "#", such as "#token=…".
export function tokenFromHash(hash: string): string | undefined {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token")?.trim();
  return token === undefined || token === "" ? undefined : token;
}

// The requests the page sends, each with a JSON body: the routes take only JSON.
export const checkInvite = (token: string) => postJson("/api/auth/invite/check", { token });
export const newInviteTotp = (token: string, email: string) =>
  postJson("/api/auth/invite/new-totp", { token, email });
export const acceptInvite = (login: {
  token: string;
  name: string;
  email: string;
  password: string;
  totpCode: string;
}) => postJson("/api/auth/invite/accept", login);

// The server's own words for a refusal, such as a wrong code or an email address in use.
async function refusalOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  if (typeof body.message === "string") return body.message;
  return res.status === 429 ? "Too many tries. Wait, then try again." : "That did not work.";
}

function MakeLogin(props: { token: string }) {
  const navigate = useNavigate();
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
      const res = await newInviteTotp(props.token, email);
      if (!res.ok) return setError(await refusalOf(res));
      setTotpURI(((await res.json()) as { totpURI: string }).totpURI);
    });
  }

  function join(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await acceptInvite({
        token: props.token,
        name,
        email,
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
        <p>You are a Member now, and you are signed in.</p>
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
      <form className="mt-2" onSubmit={join}>
        <p>Every Member signs in with a password plus TOTP.</p>
        <NewTotp totpURI={totpURI} />
        <AuthField
          label="The 6-digit code your authenticator app shows"
          autoComplete="one-time-code"
          value={totpCode}
          onChange={setTotpCode}
        />
        <button className={AUTH_BUTTON} type="submit" disabled={busy}>
          Make my login
        </button>
        <ErrorLine error={error} />
      </form>
    );
  }

  return (
    <form className="mt-2" onSubmit={startTotp}>
      <p>You were invited to the Household. Make your login.</p>
      <AuthField label="Name" autoComplete="name" value={name} onChange={setName} />
      <AuthField
        label="Email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={setEmail}
      />
      <AuthField
        label="Password, at least 12 characters"
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

export function Join() {
  const [token, setToken] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // The token stays out of the address bar and the browser history once the page has it.
    const fromLink = tokenFromHash(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (fromLink === undefined) return setError(NOT_OPEN);
    checkInvite(fromLink)
      .then(async (res) => {
        if (res.ok) return setToken(fromLink);
        setError(res.status === 403 ? NOT_OPEN : await refusalOf(res));
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <AuthFrame title="Join Family Finance Tracker">
      {token === undefined ? null : <MakeLogin token={token} />}
      <ErrorLine error={error} />
    </AuthFrame>
  );
}
