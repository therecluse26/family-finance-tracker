import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { BackupCodes, BUTTON, ErrorLine, NewTotp, TextField } from "../../components/Fields.tsx";
import { postJson, refusalText } from "../../requests.ts";

// Settings, My login: the signed-in Member changes their own password, TOTP, and backup codes
// (spec 09, Members). Each change asks for a fresh TOTP code or backup code, through the routes
// under /api/auth/my-login/. Passkeys come with their own ticket.

const CODE_LABEL = "A code from your authenticator app, or a backup code";
const WRONG_CODE = "Wrong code.";

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  // Runs a request; `onOk` gets its answer and returns the words to show.
  async function run(request: () => Promise<Response>, onOk: (res: Response) => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await request();
      if (!res.ok) return setError(await refusalText(res, WRONG_CODE));
      setDone(await onOk(res));
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, done, run };
}

function ChangePassword() {
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const action = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/change-password", { newPassword, code: code.trim() }),
      async () => {
        setNewPassword("");
        setCode("");
        return "Your password is changed.";
      },
    );
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <h3 className="font-semibold">Password</h3>
      <TextField
        label="New password, at least 12 characters"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={setNewPassword}
      />
      <TextField label={CODE_LABEL} autoComplete="one-time-code" value={code} onChange={setCode} />
      <button className={BUTTON} type="submit" disabled={action.busy}>
        Change password
      </button>
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
    </form>
  );
}

function ChangeTotp() {
  const [code, setCode] = useState("");
  const [totpURI, setTotpURI] = useState<string | undefined>();
  const [newCode, setNewCode] = useState("");
  const action = useAction();

  function start(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/new-totp", { code: code.trim() }),
      async (res) => {
        const body = (await res.json()) as { totpURI: string };
        setCode("");
        setTotpURI(body.totpURI);
        return "Enter a code from the new TOTP to finish.";
      },
    );
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/confirm-totp", { code: newCode.trim() }),
      async () => {
        setTotpURI(undefined);
        setNewCode("");
        return "Your TOTP is changed. The old one no longer works.";
      },
    );
  }

  return (
    <div className="mt-6">
      <h3 className="font-semibold">TOTP</h3>
      {totpURI === undefined ? (
        <form onSubmit={start}>
          <TextField
            label={CODE_LABEL}
            autoComplete="one-time-code"
            value={code}
            onChange={setCode}
          />
          <button className={BUTTON} type="submit" disabled={action.busy}>
            Set up a new TOTP
          </button>
        </form>
      ) : (
        <form onSubmit={confirm}>
          <NewTotp totpURI={totpURI} />
          <TextField
            label="The 6-digit code the new TOTP shows"
            autoComplete="one-time-code"
            value={newCode}
            onChange={setNewCode}
          />
          <button className={BUTTON} type="submit" disabled={action.busy}>
            Use the new TOTP
          </button>
        </form>
      )}
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
    </div>
  );
}

function ChangeBackupCodes() {
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | undefined>();
  const action = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/new-backup-codes", { code: code.trim() }),
      async (res) => {
        const body = (await res.json()) as { backupCodes: string[] };
        setCode("");
        setCodes(body.backupCodes);
        return "Your old backup codes no longer work.";
      },
    );
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h3 className="font-semibold">Backup codes</h3>
      <TextField label={CODE_LABEL} autoComplete="one-time-code" value={code} onChange={setCode} />
      <button className={BUTTON} type="submit" disabled={action.busy}>
        Make new backup codes
      </button>
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
      {codes === undefined ? null : <BackupCodes codes={codes} />}
    </form>
  );
}

function SignOut() {
  const navigate = useNavigate();
  const action = useAction();
  return (
    <button
      className="mt-6 rounded border border-gray-300 px-4 py-2 disabled:opacity-50"
      type="button"
      disabled={action.busy}
      onClick={() =>
        void action.run(
          () => postJson("/api/auth/sign-out", {}),
          async () => {
            await navigate("/sign-in", { replace: true });
            return "";
          },
        )
      }
    >
      Sign out
    </button>
  );
}

export function MyLogin() {
  return (
    <>
      <h2 className="text-xl font-semibold">My login</h2>
      <ChangePassword />
      <ChangeTotp />
      <ChangeBackupCodes />
      <SignOut />
    </>
  );
}
