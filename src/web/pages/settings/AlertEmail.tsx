import { type FormEvent, useEffect, useState } from "react";
import type { Channels, ChannelsView, SmtpFields, SmtpView } from "../../../notify/email-view.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// Settings, Alerts: how Alerts and System notices reach each Member (spec 06, Recipients and
// channels). Each Member picks their own channels. Any Member sets the Household's SMTP server and
// sends a test email to themselves. The SMTP password is write-only: the page shows only that one
// is saved.

// The page's writes, exactly as it sends them. Each sends a JSON body: the server answers 415 to a
// write without one.
export const saveChannels = (channels: Channels) => api["alert-channels"].$put({ json: channels });
export const saveSmtp = (json: SmtpFields & { code?: string }) => api.smtp.settings.$post({ json });
export const sendTestEmail = () => api.smtp.test.$post({ json: {} });

const CODE_LABEL = "A code from your authenticator app, or a backup code";

// The words to show for a refused request: the server's own, such as "Wrong code.".
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "numeric" | "email";
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="mt-3 block">
      {props.label}
      <input
        className={FIELD}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete ?? "off"}
        placeholder={props.placeholder}
        required={props.required ?? false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

const CHOICES: { label: string; channels: Channels }[] = [
  { label: "Push and email", channels: { push: true, email: true } },
  { label: "Push only", channels: { push: true, email: false } },
  { label: "Email only", channels: { push: false, email: true } },
  { label: "None", channels: { push: false, email: false } },
];

const choiceOf = (channels: Channels) =>
  CHOICES.findIndex(
    (choice) => choice.channels.push === channels.push && choice.channels.email === channels.email,
  );

export function ChannelsForm(props: {
  channels: ChannelsView;
  onSaved: (channels: ChannelsView) => void;
}) {
  const [choice, setChoice] = useState(choiceOf(props.channels));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const picked = CHOICES[choice];
    if (picked === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await saveChannels(picked.channels);
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { channels: ChannelsView }).channels);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <fieldset>
        <legend className="font-semibold">My channels</legend>
        <p className="mt-1 text-gray-600">
          How Alerts and System notices reach you. Email goes out at once, even in quiet hours.
        </p>
        {CHOICES.map((each, index) => (
          <label key={each.label} className="mt-2 flex items-center gap-2">
            <input
              type="radio"
              name="channels"
              checked={choice === index}
              onChange={() => setChoice(index)}
            />
            {each.label}
          </label>
        ))}
      </fieldset>
      {props.channels.emailSetUp || !CHOICES[choice]?.channels.email ? null : (
        <p className="mt-2 text-gray-600">
          No SMTP server is saved, so the app skips email until one is.
        </p>
      )}
      <button className={BUTTON} type="submit" disabled={busy}>
        Save my channels
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function SmtpForm(props: { smtp: SmtpView | null; onSaved: (smtp: SmtpView) => void }) {
  const { smtp } = props;
  const [host, setHost] = useState(smtp?.host ?? "");
  const [port, setPort] = useState(String(smtp?.port ?? 587));
  const [username, setUsername] = useState(smtp?.username ?? "");
  const [password, setPassword] = useState("");
  const [sender, setSender] = useState(smtp?.sender ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const portNumber = Number(port.trim());
  const sameServer =
    smtp !== null &&
    smtp.host === host.trim() &&
    smtp.port === portNumber &&
    smtp.username === username.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      return setError("Enter a port from 1 to 65535.");
    }
    setBusy(true);
    try {
      const res = await saveSmtp({
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        ...(password === "" ? {} : { password }),
        sender: sender.trim(),
        ...(code.trim() === "" ? {} : { code: code.trim() }),
      });
      setCode("");
      if (!res.ok) return setError(await refusal(res));
      setPassword("");
      props.onSaved(((await res.json()) as { smtp: SmtpView }).smtp);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h3 className="font-semibold">Email server (SMTP)</h3>
      <p className="mt-1 text-gray-600">
        The Household's mail server, which sends Alerts and System notices to each Member who picks
        email. The app always uses TLS: port 465 from the start, any other port with STARTTLS.
      </p>
      <Field label="Host" value={host} onChange={setHost} required />
      <Field label="Port" inputMode="numeric" value={port} onChange={setPort} required />
      <Field label="Sign-in name" value={username} onChange={setUsername} required />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        required={!sameServer}
        placeholder={sameServer ? "Saved. Enter a new password to change it." : "Not saved"}
      />
      <Field
        label="Sender address"
        type="email"
        inputMode="email"
        value={sender}
        onChange={setSender}
        required
      />
      <Field
        label={`${CODE_LABEL}, to set or change the password`}
        autoComplete="one-time-code"
        value={code}
        onChange={setCode}
      />
      <button className={BUTTON} type="submit" disabled={busy}>
        Save the email server
      </button>
      <ErrorLine error={error} />
    </form>
  );
}

export function TestEmailButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: boolean; line: string } | undefined>();

  async function send() {
    setBusy(true);
    setResult(undefined);
    try {
      const res = await sendTestEmail();
      setResult(
        res.ok
          ? { sent: true, line: "The test email is sent. Check your inbox." }
          : { sent: false, line: await refusal(res) },
      );
    } catch {
      setResult({ sent: false, line: "The server did not answer." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className={BUTTON} type="button" disabled={busy} onClick={send}>
        Send a test email
      </button>
      <p className="mt-1 text-gray-600">It goes to your own email address.</p>
      {result === undefined ? null : result.sent ? (
        <p className="mt-3">{result.line}</p>
      ) : (
        <ErrorLine error={result.line} />
      )}
    </div>
  );
}

export function AlertEmail() {
  const [channels, setChannels] = useState<ChannelsView | undefined>();
  const [smtp, setSmtp] = useState<SmtpView | null | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([api["alert-channels"].$get(), api.smtp.settings.$get()])
      .then(async ([channelsRes, smtpRes]) => {
        if (!channelsRes.ok || !smtpRes.ok) return setError("The channel settings did not load.");
        setChannels(((await channelsRes.json()) as { channels: ChannelsView }).channels);
        setSmtp(((await smtpRes.json()) as { smtp: SmtpView | null }).smtp);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <ErrorLine error={error} />
      {channels === undefined ? null : (
        <ChannelsForm
          channels={channels}
          onSaved={(saved) => {
            setChannels(saved);
            setDone("Your channels are saved.");
          }}
        />
      )}
      {smtp === undefined ? null : (
        <SmtpForm
          smtp={smtp}
          onSaved={(saved) => {
            setSmtp(saved);
            if (channels !== undefined) setChannels({ ...channels, emailSetUp: true });
            setDone("The email server is saved.");
          }}
        />
      )}
      {smtp === undefined ? null : <TestEmailButton />}
      {done === undefined ? null : <p className="mt-3">{done}</p>}
    </>
  );
}
