import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button.tsx";
import { BackupCodes, ErrorLine, NewTotp } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
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
import {
  BUTTONS,
  DoneLine,
  Field,
  HINT,
  Lead,
  ROW,
  SettingCard,
  TabHeading,
} from "./settings-ui.tsx";

// Settings, My login: the signed-in Member changes their own password, TOTP, and backup codes
// (spec 09, Members), through the routes under /api/auth/my-login/. TOTP is asked only at sign-in
// (spec 09, Sensitive actions): a password change asks for the current password, and a new TOTP
// asks for one code from the new authenticator. Over HTTPS the Member also adds and deletes
// passkeys; adding one asks for the current password too.

const CURRENT_PASSWORD_LABEL = "Current password";
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
    <SettingCard id="change-password" title="Change password">
      <form onSubmit={submit}>
        <Field
          label={CURRENT_PASSWORD_LABEL}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
          required
        />
        <p className={HINT}>At least 12 characters.</p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={action.busy}>
            Change password
          </Button>
        </div>
        <ErrorLine error={action.error} />
        <DoneLine done={action.done} />
      </form>
      <p className="mt-3 text-small text-muted">
        No code is needed. Your current password proves it is you.
      </p>
    </SettingCard>
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
      <Field
        label="The 6-digit code the new TOTP shows"
        autoComplete="one-time-code"
        value={props.code}
        onChange={props.onCodeChange}
        required
      />
      <div className={BUTTONS}>
        <Button type="submit" disabled={props.busy}>
          Use the new TOTP
        </Button>
      </div>
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
    <SettingCard
      id="authenticator-app"
      title="Authenticator app"
      // Every Member signs in with TOTP (spec 09), so it is always on.
      status={<StatusText tone="good">On</StatusText>}
    >
      <Lead>Sign-in asks for a code from this app.</Lead>
      {totpURI === undefined ? (
        <form onSubmit={start}>
          <div className={BUTTONS}>
            <Button type="submit" variant="outlined" disabled={action.busy}>
              Set up a new TOTP
            </Button>
          </div>
          <p className="mt-2 text-small text-muted">
            You scan a new QR code, then type one code from the new app to finish.
          </p>
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
      <DoneLine done={action.done} />
    </SettingCard>
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
    <SettingCard id="backup-codes" title="Backup codes">
      <Lead>Use one at sign-in if you lose your phone. Each code works once.</Lead>
      <form onSubmit={submit}>
        <div className={BUTTONS}>
          <Button type="submit" variant="outlined" disabled={action.busy}>
            Make new backup codes
          </Button>
        </div>
        <ErrorLine error={action.error} />
        <DoneLine done={action.done} />
        {codes === undefined ? null : <BackupCodes codes={codes} />}
      </form>
    </SettingCard>
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
      <SettingCard id="passkeys" title="Passkeys">
        <Lead>{state === "plain HTTP" ? PASSKEYS_PLAIN_HTTP_NOTE : PASSKEYS_NOT_IN_BROWSER}</Lead>
      </SettingCard>
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
    <SettingCard id="passkeys" title="Passkeys">
      <Lead>
        A passkey signs you in on its own, with no password and no code. It works only at this app's
        address.
      </Lead>
      {rows === undefined ? null : rows.length === 0 ? (
        <p className="mt-3">You have no passkeys.</p>
      ) : (
        <ul className="mt-2.5">
          {rows.map((row) => (
            <li key={row.id} className={ROW}>
              <div className="min-w-0 flex-[1_1_220px]">
                <p className="font-semibold">{row.name ?? "Passkey"}</p>
                <p className="mt-0.5 text-small text-muted">
                  Added {new Date(row.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                type="button"
                variant="outlined"
                size="small"
                disabled={action.busy}
                onClick={() => remove(row.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-1" onSubmit={add}>
        <Field
          label="A name for it, such as your phone's (optional)"
          value={name}
          onChange={setName}
        />
        <Field
          label={CURRENT_PASSWORD_LABEL}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
        />
        <div className={BUTTONS}>
          <Button type="submit" variant="outlined" disabled={action.busy}>
            Add a passkey
          </Button>
        </div>
      </form>
      <ErrorLine error={action.error} />
      <DoneLine done={action.done} />
    </SettingCard>
  );
}

function SignOut() {
  const navigate = useNavigate();
  const action = useAction("That did not work.");
  return (
    <div>
      <Button
        type="button"
        variant="outlined"
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
      </Button>
    </div>
  );
}

export function MyLogin() {
  return (
    <>
      <TabHeading>My login</TabHeading>
      <ChangePassword />
      <ChangeTotp />
      <ChangeBackupCodes />
      <Passkeys />
      <SignOut />
    </>
  );
}
