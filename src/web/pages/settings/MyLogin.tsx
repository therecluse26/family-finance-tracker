import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { BackupCodes, BUTTON, ErrorLine, NewTotp, TextField } from "../../components/Fields.tsx";
import {
  addPasskey,
  deletePasskey,
  listPasskeys,
  PASSKEYS_NOT_IN_BROWSER,
  PASSKEYS_PLAIN_HTTP_NOTE,
  type PasskeyRow,
  passkeyState,
} from "../../passkeys.ts";
import { postJson, refusalText } from "../../requests.ts";

// Settings, My login: the signed-in Member changes their own password, TOTP, and backup codes
// (spec 09, Members), through the routes under /api/auth/my-login/. TOTP is asked only at sign-in
// (spec 09, Sensitive actions): a password change asks for the current password, and a new TOTP
// asks for one code from the new authenticator. Over HTTPS the Member also adds and deletes
// passkeys; adding one asks for the current password too.

const CURRENT_PASSWORD_LABEL = "Your current password";
const WRONG_PASSWORD = "Your current password is wrong.";

// `wrong` is the words to show when the server answers 401, and `byCode` the words for a refusal
// with one of its codes.
function useAction(wrong: string, byCode?: Record<string, string>) {
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
      if (!res.ok) return setError(await refusalText(res, wrong, byCode));
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const action = useAction(WRONG_PASSWORD);

  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/change-password", { currentPassword, newPassword }),
      async () => {
        setCurrentPassword("");
        setNewPassword("");
        return "Your password is changed.";
      },
    );
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <h3 className="font-semibold">Password</h3>
      <TextField
        label={CURRENT_PASSWORD_LABEL}
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={setCurrentPassword}
      />
      <TextField
        label="New password, at least 12 characters"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={setNewPassword}
      />
      <button className={BUTTON} type="submit" disabled={action.busy}>
        Change password
      </button>
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
    </form>
  );
}

// The second TOTP step: the new TOTP to scan or type in, and the field for its first code.
export function ConfirmNewTotp(props: {
  totpURI: string;
  code: string;
  onCodeChange: (code: string) => void;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form onSubmit={props.onSubmit}>
      <NewTotp totpURI={props.totpURI} />
      <TextField
        label="The 6-digit code the new TOTP shows"
        autoComplete="one-time-code"
        value={props.code}
        onChange={props.onCodeChange}
      />
      <button className={BUTTON} type="submit" disabled={props.busy}>
        Use the new TOTP
      </button>
    </form>
  );
}

function ChangeTotp() {
  const [totpURI, setTotpURI] = useState<string | undefined>();
  const [newCode, setNewCode] = useState("");
  const action = useAction("Wrong code.");

  function start(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/new-totp", {}),
      async (res) => {
        const body = (await res.json()) as { totpURI: string };
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
          <button className={BUTTON} type="submit" disabled={action.busy}>
            Set up a new TOTP
          </button>
        </form>
      ) : (
        <ConfirmNewTotp
          totpURI={totpURI}
          code={newCode}
          onCodeChange={setNewCode}
          busy={action.busy}
          onSubmit={confirm}
        />
      )}
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
    </div>
  );
}

function ChangeBackupCodes() {
  const [codes, setCodes] = useState<string[] | undefined>();
  const action = useAction("That did not work.");

  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => postJson("/api/auth/my-login/new-backup-codes", {}),
      async (res) => {
        const body = (await res.json()) as { backupCodes: string[] };
        setCodes(body.backupCodes);
        return "Your old backup codes no longer work.";
      },
    );
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h3 className="font-semibold">Backup codes</h3>
      <button className={BUTTON} type="submit" disabled={action.busy}>
        Make new backup codes
      </button>
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
      {codes === undefined ? null : <BackupCodes codes={codes} />}
    </form>
  );
}

function Passkeys() {
  const state = passkeyState();
  const [rows, setRows] = useState<PasskeyRow[] | undefined>();
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const action = useAction(WRONG_PASSWORD, {
    MEMBER_NOT_VERIFIED:
      "The passkey did not check that it was you, by a PIN or a fingerprint. Try again.",
  });

  const load = useCallback(() => {
    listPasskeys()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (state === "offered") load();
  }, [state, load]);

  if (state !== "offered") {
    return (
      <section className="mt-6">
        <h3 className="font-semibold">Passkeys</h3>
        <p className="mt-1 text-gray-600">
          {state === "plain HTTP" ? PASSKEYS_PLAIN_HTTP_NOTE : PASSKEYS_NOT_IN_BROWSER}
        </p>
      </section>
    );
  }

  function add(event: FormEvent) {
    event.preventDefault();
    void action.run(
      () => addPasskey({ currentPassword, name: name.trim() }),
      async () => {
        setName("");
        setCurrentPassword("");
        load();
        return "Your passkey is added. It signs you in with no code.";
      },
    );
  }

  function remove(id: string) {
    void action.run(
      () => deletePasskey(id),
      async () => {
        load();
        return "The passkey is deleted.";
      },
    );
  }

  return (
    <section className="mt-6">
      <h3 className="font-semibold">Passkeys</h3>
      <p className="mt-1 text-gray-600">
        A passkey signs you in on its own, with no password and no code. It works only at this app's
        address.
      </p>
      {rows === undefined ? null : rows.length === 0 ? (
        <p className="mt-2">You have no passkeys.</p>
      ) : (
        <ul className="mt-2">
          {rows.map((row) => (
            <li key={row.id} className="mt-1 flex items-center gap-3">
              <span>
                {row.name ?? "Passkey"}, added {new Date(row.createdAt).toLocaleDateString()}
              </span>
              <button
                className="rounded border border-gray-300 px-2 py-1 disabled:opacity-50"
                type="button"
                disabled={action.busy}
                onClick={() => remove(row.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add}>
        <TextField
          label="A name for it, such as your phone's (optional)"
          value={name}
          onChange={setName}
          optional
        />
        <TextField
          label={CURRENT_PASSWORD_LABEL}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <button className={BUTTON} type="submit" disabled={action.busy}>
          Add a passkey
        </button>
      </form>
      <ErrorLine error={action.error} />
      {action.done === undefined ? null : <p className="mt-3">{action.done}</p>}
    </section>
  );
}

function SignOut() {
  const navigate = useNavigate();
  const action = useAction("That did not work.");
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
      <Passkeys />
      <SignOut />
    </>
  );
}
