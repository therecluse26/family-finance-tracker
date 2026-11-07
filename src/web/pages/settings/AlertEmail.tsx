import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { Channels, ChannelsView, SmtpFields, SmtpView } from "../../../notify/email-view.ts";
import type { PushView } from "../../../notify/push-view.ts";
import type { WeeklySummaryView } from "../../../weekly-summary/view.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { homeScreenFirstHere, PushPart } from "./AlertPush.tsx";
import { BUTTONS, CHOICE, DoneLine, Field, HINT, SettingCard } from "./settings-ui.tsx";
import { WeeklySummaryRow } from "./WeeklySummary.tsx";

// Settings, Alerts: how Alerts and System notices reach each Member (spec 06, Recipients and
// channels). Each Member picks their own channels, and turns push on for each device
// (AlertPush.tsx). In plain-HTTP mode email is the only channel (spec 09, Security mode). Any Member
// sets the Household's SMTP server and sends a test email to themselves. The SMTP password is
// write-only: the page shows only that one is saved.

// The page's writes, exactly as it sends them. Each sends a JSON body: the server answers 415 to a
// write without one.
export const saveChannels = (channels: Channels) => api["alert-channels"].$put({ json: channels });
export const saveSmtp = (json: SmtpFields) => api.smtp.settings.$post({ json });
export const sendTestEmail = () => api.smtp.test.$post({ json: {} });

// The words to show for a refused request: the server's own, such as "Enter the SMTP password.".
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

const CHOICES: { label: string; channels: Channels }[] = [
  { label: "Push and email", channels: { push: true, email: true } },
  { label: "Push only", channels: { push: true, email: false } },
  { label: "Email only", channels: { push: false, email: true } },
  { label: "None", channels: { push: false, email: false } },
];

// In plain-HTTP mode email is the only channel.
const EMAIL_CHOICES: { label: string; channels: Channels }[] = [
  { label: "Email", channels: { push: false, email: true } },
  { label: "None", channels: { push: false, email: false } },
];

const choiceOf = (channels: Channels, pushOffered: boolean) =>
  pushOffered
    ? CHOICES.findIndex(
        (choice) =>
          choice.channels.push === channels.push && choice.channels.email === channels.email,
      )
    : channels.email
      ? 0
      : 1;

export function ChannelsForm(props: {
  channels: ChannelsView;
  // False in plain-HTTP mode, where push is hidden.
  pushOffered?: boolean;
  onSaved: (channels: ChannelsView) => void;
}) {
  const pushOffered = props.pushOffered ?? true;
  const choices = pushOffered ? CHOICES : EMAIL_CHOICES;
  const [choice, setChoice] = useState(choiceOf(props.channels, pushOffered));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const picked = choices[choice];
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
    <form onSubmit={submit}>
      <fieldset>
        <legend className="sr-only">My channels</legend>
        <p className="mt-1.5 text-muted">
          How Alerts and System notices reach you. Email goes out at once, even in quiet hours.
          {pushOffered ? " Push waits from 9 PM to 8 AM, Household time." : null}
        </p>
        <div className="mt-1">
          {choices.map((each, index) => (
            <label key={each.label} className={CHOICE}>
              <input
                type="radio"
                name="channels"
                checked={choice === index}
                onChange={() => setChoice(index)}
              />
              {each.label}
            </label>
          ))}
        </div>
      </fieldset>
      {props.channels.emailSetUp || !choices[choice]?.channels.email ? null : (
        <p className={HINT}>No SMTP server is saved, so the app skips email until one is.</p>
      )}
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Save my channels
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

// `children` sits beside Save, such as "Send a test email".
export function SmtpForm(props: {
  smtp: SmtpView | null;
  onSaved: (smtp: SmtpView) => void;
  children?: ReactNode;
}) {
  const { smtp } = props;
  const [host, setHost] = useState(smtp?.host ?? "");
  const [port, setPort] = useState(String(smtp?.port ?? 587));
  const [username, setUsername] = useState(smtp?.username ?? "");
  const [password, setPassword] = useState("");
  const [sender, setSender] = useState(smtp?.sender ?? "");
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
      });
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
    <form onSubmit={submit}>
      <p className="mt-1.5 text-muted">
        The Household's mail server, which sends Alerts and System notices to each Member who picks
        email. The app always uses TLS: port 465 from the start, any other port with STARTTLS.
      </p>
      <div className="grid gap-x-5 sm:grid-cols-2">
        <Field label="Host" value={host} onChange={setHost} required className="max-w-none" />
        <Field
          label="Port"
          inputMode="numeric"
          value={port}
          onChange={setPort}
          required
          className="max-w-30 tabular-nums"
        />
        <Field
          label="Sign-in name"
          value={username}
          onChange={setUsername}
          required
          className="max-w-none"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          required={!sameServer}
          placeholder={sameServer ? "Saved. Enter a new password to change it." : "Not saved"}
          className="max-w-none"
        />
        <Field
          label="Sender address"
          type="email"
          inputMode="email"
          value={sender}
          onChange={setSender}
          required
          className="max-w-none"
        />
      </div>
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Save the email server
        </Button>
        {props.children}
      </div>
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
    <>
      <Button type="button" variant="outlined" disabled={busy} onClick={send}>
        Send a test email
      </Button>
      <p className="w-full text-small text-muted">It goes to your own email address.</p>
      {result === undefined ? null : result.sent ? (
        <p className="w-full text-small" role="status">
          <StatusText tone="good">{result.line}</StatusText>
        </p>
      ) : (
        <div className="w-full">
          <ErrorLine error={result.line} />
        </div>
      )}
    </>
  );
}

export function AlertEmail() {
  const [channels, setChannels] = useState<ChannelsView | undefined>();
  const [smtp, setSmtp] = useState<SmtpView | null | undefined>();
  const [push, setPush] = useState<PushView | undefined>();
  const [weeklySummary, setWeeklySummary] = useState<WeeklySummaryView | undefined>();
  const [homeScreenFirst, setHomeScreenFirst] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [channelsDone, setChannelsDone] = useState<string | undefined>();
  const [smtpDone, setSmtpDone] = useState<string | undefined>();

  useEffect(() => {
    setHomeScreenFirst(homeScreenFirstHere());
    Promise.all([
      api["alert-channels"].$get(),
      api.smtp.settings.$get(),
      api.push.$get(),
      api["weekly-summary"].$get(),
    ])
      .then(async ([channelsRes, smtpRes, pushRes, weeklyRes]) => {
        if (!channelsRes.ok || !smtpRes.ok || !pushRes.ok || !weeklyRes.ok) {
          return setError("The channel settings did not load.");
        }
        setPush(((await pushRes.json()) as { push: PushView }).push);
        setChannels(((await channelsRes.json()) as { channels: ChannelsView }).channels);
        setSmtp(((await smtpRes.json()) as { smtp: SmtpView | null }).smtp);
        setWeeklySummary(
          ((await weeklyRes.json()) as { weeklySummary: WeeklySummaryView }).weeklySummary,
        );
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <ErrorLine error={error} />
      <SettingCard id="my-channels" title="My channels">
        {channels === undefined || push === undefined ? null : (
          <ChannelsForm
            channels={channels}
            pushOffered={push.available || push.why !== "plain HTTP"}
            onSaved={(saved) => {
              setChannels(saved);
              setChannelsDone("Your channels are saved.");
            }}
          />
        )}
        <DoneLine done={channelsDone} />
        {push === undefined ? null : <PushPart push={push} homeScreenFirst={homeScreenFirst} />}
        {weeklySummary === undefined ? null : <WeeklySummaryRow initial={weeklySummary} />}
      </SettingCard>
      <SettingCard
        id="email-server"
        title="Email server (SMTP)"
        status={
          smtp === undefined ? undefined : smtp === null ? (
            <StatusText tone="muted">Not saved</StatusText>
          ) : (
            <StatusText tone="good">Saved</StatusText>
          )
        }
      >
        {smtp === undefined ? null : (
          <SmtpForm
            smtp={smtp}
            onSaved={(saved) => {
              setSmtp(saved);
              if (channels !== undefined) setChannels({ ...channels, emailSetUp: true });
              if (weeklySummary !== undefined) {
                setWeeklySummary({ ...weeklySummary, emailSetUp: true });
              }
              setSmtpDone("The email server is saved.");
            }}
          >
            <TestEmailButton />
          </SmtpForm>
        )}
        <DoneLine done={smtpDone} />
        <p className="mt-3 text-small text-muted">
          No code is needed. You signed in with one already.
        </p>
      </SettingCard>
    </>
  );
}
