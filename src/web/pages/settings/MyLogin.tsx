import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import type { DeviceView } from "../../../server/devices-views.ts";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { api } from "../../api.ts";
import { browserZone } from "../../browser-zone.ts";
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
// passkeys; adding one asks for the current password too. Signed-in devices lists the Member's own
// sessions, with Sign out on each, through the app's routes under /api/my-login/.

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

// The requests Signed-in devices sends, each with a JSON body, even an empty one: the routes take
// only JSON. The routes read their body themselves, so each body goes in through a separate object.
export function signOutDevice(id: string) {
  const signOut = { param: { id }, json: {} };
  return api["my-login"].devices[":id"]["sign-out"].$post(signOut);
}
export function signOutOtherDevices() {
  const signOut = { json: {} };
  return api["my-login"]["sign-out-other-devices"].$post(signOut);
}

// "Signed in Nov 6, 9:30 AM", in the Household time zone (spec 07, Dates and Times).
export function signedInLine(signedInAt: string, zone: string, now: Date): string {
  const at = new Date(signedInAt);
  const day = dateLabel(calendarDateIn(at, zone), calendarDateIn(now, zone));
  return `Signed in ${day}, ${timeLabel(at, zone)}`;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// The rows: each device's name, "this device" on this one, when it signed in, and Sign out.
export function DeviceRows(props: {
  devices: DeviceView[];
  zone: string;
  now: Date;
  busy: boolean;
  onSignOut: (device: DeviceView) => void;
}) {
  return (
    <ul className="mt-2.5">
      {props.devices.map((device) => (
        <li key={device.id} className={ROW}>
          <div className="min-w-0 flex-[1_1_220px]">
            <p>
              <span className="font-semibold">{device.name}</span>
              {device.thisDevice ? (
                <span className="text-small">
                  {" · "}
                  <StatusText tone="good">this device</StatusText>
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-small text-muted">
              {signedInLine(device.signedInAt, props.zone, props.now)}
            </p>
          </div>
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={props.busy}
            aria-label={device.thisDevice ? "Sign out this device" : `Sign out ${device.name}`}
            onClick={() => props.onSignOut(device)}
          >
            Sign out
          </Button>
        </li>
      ))}
    </ul>
  );
}

// Signed-in devices (spec 09): the Member's own sessions that have not expired. Sign out on this
// device's row signs out through Better Auth's /sign-out, which also clears the cookie; Sign out
// on another row ends that session. Until the list loads, or if it does not, the card still offers
// Sign out for this device.
function SignedInDevices() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DeviceView[] | undefined>();
  const [zone, setZone] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const load = useCallback(() => {
    api["my-login"].devices
      .$get()
      .then(async (res) => {
        if (res.status === 401) return navigate("/sign-in", { replace: true });
        if (!res.ok) return setError(await errorOf(res));
        setDevices((await res.json()).devices);
      })
      .catch(() => setError("The server did not answer."));
  }, [navigate]);

  useEffect(() => {
    load();
    api.household
      .$get()
      .then(async (res) => {
        if (!res.ok) return;
        setZone(((await res.json()) as { facts: HouseholdFactsView | null }).facts?.timeZone);
      })
      .catch(() => {});
  }, [load]);

  async function run(request: () => Promise<Response>, onOk: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await request();
      if (res.status === 401) return void (await navigate("/sign-in", { replace: true }));
      if (!res.ok) {
        setError(await errorOf(res));
        load();
        return;
      }
      await onOk();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  function signOutThisDevice() {
    void run(
      () => postJson("/api/auth/sign-out", {}),
      async () => void (await navigate("/sign-in", { replace: true })),
    );
  }

  function signOut(device: DeviceView) {
    if (device.thisDevice) return signOutThisDevice();
    void run(
      () => signOutDevice(device.id),
      async () => {
        setDone(`${device.name} is signed out.`);
        load();
      },
    );
  }

  function signOutOthers() {
    void run(signOutOtherDevices, async () => {
      setDone("Every other device is signed out.");
      load();
    });
  }

  const others = devices?.filter((device) => !device.thisDevice).length ?? 0;
  return (
    <SettingCard id="signed-in-devices" title="Signed-in devices">
      {devices === undefined ? (
        <div className={BUTTONS}>
          <Button type="button" variant="outlined" disabled={busy} onClick={signOutThisDevice}>
            Sign out
          </Button>
        </div>
      ) : (
        <DeviceRows
          devices={devices}
          zone={zone ?? browserZone()}
          now={new Date()}
          busy={busy}
          onSignOut={signOut}
        />
      )}
      {others > 0 ? (
        <div className={BUTTONS}>
          <Button type="button" variant="outlined" disabled={busy} onClick={signOutOthers}>
            Sign out everywhere else
          </Button>
        </div>
      ) : null}
      <ErrorLine error={error} />
      <DoneLine done={done} />
      {devices === undefined ? null : (
        <p className="mt-3 text-small text-muted">
          Sign out needs no code. If you do not know a device, sign it out and change your password.
        </p>
      )}
    </SettingCard>
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
      <SignedInDevices />
    </>
  );
}
