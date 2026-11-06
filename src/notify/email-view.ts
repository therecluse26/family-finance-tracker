// The SMTP settings and a Member's channels, as Settings → Alerts sees them (spec 06, Recipients
// and channels). The SMTP password is never in them: a saved server always has one. This file
// imports nothing, so the web app's type check can follow it.

export type SmtpView = { host: string; port: number; username: string; sender: string };

export type SmtpFields = SmtpView & {
  // Left out to keep the stored password.
  password?: string;
};

// Why a save stored nothing: changing the password, or the server or sign-in name it goes to,
// takes a fresh TOTP or backup code; and a new server or sign-in name needs its password.
export type SmtpRefusal = "password needed";

export type SmtpSave = { saved: true; smtp: SmtpView } | { saved: false; refusal: SmtpRefusal };

// Why an email did not send: no SMTP server is saved, the saved password cannot be decrypted (as
// after a restore under another Master key), the server refused the sign-in name or password, the
// app could not reach it, or it refused the message.
export type SendProblem =
  | "not set up"
  | "password unreadable"
  | "sign-in refused"
  | "no answer"
  | "message refused";

export type TestEmail = { sent: true } | { sent: false; problem: SendProblem };

export type SmtpSettings = {
  view(): Promise<SmtpView | null>;
  save(fields: SmtpFields): Promise<SmtpSave>;
  // Sends a test email to this address, the signed-in Member's.
  sendTest(to: string): Promise<TestEmail>;
};

// A Member's channels: push, email, both, or none. `emailSetUp` is false while no SMTP server is
// saved, so the app skips email.
export type Channels = { push: boolean; email: boolean };
export type ChannelsView = Channels & { emailSetUp: boolean };

export type ChannelSettings = {
  view(memberId: string): Promise<ChannelsView>;
  set(memberId: string, channels: Channels): Promise<ChannelsView>;
};
