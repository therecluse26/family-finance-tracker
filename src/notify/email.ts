import { createTransport } from "nodemailer";
import {
  type Database,
  readChannels,
  readSmtpSettings,
  SMTP_SETTINGS_ROW,
  type StoredSmtpSettings,
  storeChannels,
  storeSmtpSettings,
} from "../db/index.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import type {
  ChannelSettings,
  SendProblem,
  SmtpSettings,
  SmtpView,
  TestEmail,
} from "./email-view.ts";
import { askForDelivery } from "./notices.ts";

// Email through the Household's SMTP server (spec 06, Recipients and channels; spec 01, 11.
// Privacy). The server gets each message and nothing else. The password is a Master-key secret:
// the app encrypts it, and never shows or logs it again. This file is the only importer of
// nodemailer.

// The password's place. Its ciphertext decrypts only in smtp_settings' one row, in this column.
const PASSWORD_PLACE: SecretPlace = { rowId: SMTP_SETTINGS_ROW, column: "smtp_settings.password" };

// The name on each email, before the sender address.
export const SENDER_NAME = "Family Finance Tracker";

// A saved SMTP server, with its password decrypted.
export type SmtpServer = {
  host: string;
  port: number;
  username: string;
  password: string;
  sender: string;
};

// One email: plain text, to every recipient at once.
export type Mail = {
  from: { name: string; address: string };
  to: { name: string; address: string };
  bcc: string[];
  subject: string;
  text: string;
};

// The part of a nodemailer transport the app uses. Tests give a stub, so no test opens a
// connection to a mail server.
export type MailTransport = { sendMail(mail: Mail): Promise<unknown> };
export type TransportMaker = (server: SmtpServer) => MailTransport;

// Port 465 speaks TLS from the start. On any other port the server must offer STARTTLS, so the
// password never crosses the network in plain text.
const IMPLICIT_TLS_PORT = 465;
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

export const smtpTransport: TransportMaker = (server) =>
  createTransport({
    host: server.host,
    port: server.port,
    secure: server.port === IMPLICIT_TLS_PORT,
    requireTLS: server.port !== IMPLICIT_TLS_PORT,
    auth: { user: server.username, pass: server.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // A message is plain text the app wrote: it never reads a file or a URL.
    disableFileAccess: true,
    disableUrlAccess: true,
  });

// The saved SMTP server with its password; undefined when none is saved; "unreadable" when its
// password cannot be decrypted, as after a restore under another Master key. Decrypting registers
// the password with the logger, which refuses it from then on.
export async function readSmtpServer(
  database: Database,
  secrets: Secrets,
  logger: Logger = log,
): Promise<SmtpServer | "unreadable" | undefined> {
  const stored = await readSmtpSettings(database);
  if (stored === undefined) return undefined;
  const password = readPassword(stored, secrets, logger);
  return password === undefined ? "unreadable" : { ...stored, password };
}

function readPassword(
  stored: StoredSmtpSettings,
  secrets: Secrets,
  logger: Logger,
): string | undefined {
  try {
    const password = secrets.decrypt(stored.password, PASSWORD_PLACE);
    registerSecretValue(password);
    return password;
  } catch {
    logger.warn("The stored SMTP password cannot be read");
    return undefined;
  }
}

// nodemailer's error codes, by what they mean for the Member.
const SIGN_IN_CODES = new Set(["EAUTH", "ENOAUTH", "EOAUTH2"]);
const NO_ANSWER_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "EPROTOCOL",
  "EGREETING",
]);

// What a failed send means, from nodemailer's error. Only its code and the server's reply code are
// read: the message can quote the server's reply, which can hold an address or the sign-in name.
export function sendProblem(error: unknown): {
  problem: Exclude<SendProblem, "not set up" | "password unreadable">;
  errorCode: string | null;
  responseCode: number | null;
} {
  const fields = typeof error === "object" && error !== null ? error : {};
  const code = "code" in fields && typeof fields.code === "string" ? fields.code : null;
  const errorCode = code !== null && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
  const reply =
    "responseCode" in fields && typeof fields.responseCode === "number"
      ? fields.responseCode
      : null;
  const responseCode = reply !== null && Number.isInteger(reply) ? reply : null;
  const problem =
    errorCode !== null && SIGN_IN_CODES.has(errorCode)
      ? "sign-in refused"
      : errorCode !== null && NO_ANSWER_CODES.has(errorCode)
        ? "no answer"
        : "message refused";
  return { problem, errorCode, responseCode };
}

// Sends one email from the server's sender address to every recipient.
export async function sendEmail(
  transport: MailTransport,
  server: SmtpServer,
  recipients: readonly string[],
  email: { subject: string; text: string },
): Promise<void> {
  // Each Member is a Bcc recipient, and the email is to the sender address, so no Member sees
  // another's address. nodemailer writes no Bcc header.
  const sender = { name: SENDER_NAME, address: server.sender };
  await transport.sendMail({
    from: sender,
    to: sender,
    bcc: [...recipients],
    subject: email.subject,
    text: email.text,
  });
}

// An Alert's email: the kind as its subject, then the template text, the AI's advice when there is
// any, and a link to the Alert list that starts with APP_URL.
export function alertEmail(
  alert: { title: string; text: string; advice: string | null },
  address: (path: string) => string,
): { subject: string; text: string } {
  const paragraphs = [alert.text, ...(alert.advice === null ? [] : [alert.advice])];
  paragraphs.push(`See it in the Alert list: ${address("/alert-list")}`);
  return { subject: alert.title, text: paragraphs.join("\n\n") };
}

// A System notice's email: the notice's text, and a link to the app.
export function noticeEmail(
  text: string,
  address: (path: string) => string,
): { subject: string; text: string } {
  return {
    subject: "System notice",
    text: [text, `Open the app: ${address("/")}`].join("\n\n"),
  };
}

function testEmail(address: (path: string) => string): { subject: string; text: string } {
  return {
    subject: "Test email",
    text: [
      "The app can send you email. Alerts and System notices come this way when your channels hold email.",
      `Change your channels in Settings, Alerts: ${address("/settings/alerts")}`,
    ].join("\n\n"),
  };
}

// The SMTP settings for Settings → Alerts.
export function smtpSettings(options: {
  database: Database;
  secrets: Secrets;
  address: (path: string) => string;
  makeTransport?: TransportMaker;
  logger?: Logger;
}): SmtpSettings {
  const { database, secrets, address, makeTransport = smtpTransport, logger = log } = options;

  async function view(): Promise<SmtpView | null> {
    const stored = await readSmtpSettings(database);
    if (stored === undefined) return null;
    const { password: _, ...shown } = stored;
    return shown;
  }

  return {
    view,

    async save(fields, { freshCode }) {
      const stored = await readSmtpSettings(database);
      // A stored password goes only to the server and sign-in name it was entered for: a new
      // server or sign-in name needs its password, and a new password needs a fresh code.
      const sameServer =
        stored !== undefined &&
        stored.host === fields.host &&
        stored.port === fields.port &&
        stored.username === fields.username;
      if (fields.password === undefined && !sameServer) {
        return { saved: false, refusal: "password needed" };
      }
      if (fields.password !== undefined && !freshCode) {
        return { saved: false, refusal: "code needed" };
      }
      let password = fields.password;
      if (password === undefined && stored !== undefined) {
        password = readPassword(stored, secrets, logger);
      } else if (password !== undefined) {
        registerSecretValue(password);
      }
      // A kept password that cannot be read must be entered again.
      if (password === undefined) return { saved: false, refusal: "password needed" };
      await storeSmtpSettings(database, {
        host: fields.host,
        port: fields.port,
        username: fields.username,
        password: secrets.encrypt(password, PASSWORD_PLACE),
        sender: fields.sender,
      });
      logger.info("Saved the SMTP settings");
      // The Delivery job ends the notice about an unreadable password, now that one is saved.
      await askForDelivery();
      const smtp = await view();
      if (smtp === null) throw new Error("The SMTP settings did not save.");
      return { saved: true, smtp };
    },

    async sendTest(to): Promise<TestEmail> {
      const server = await readSmtpServer(database, secrets, logger);
      if (server === undefined) return { sent: false, problem: "not set up" };
      if (server === "unreadable") return { sent: false, problem: "password unreadable" };
      try {
        await sendEmail(makeTransport(server), server, [to], testEmail(address));
      } catch (error) {
        const { problem, errorCode, responseCode } = sendProblem(error);
        logger.warn("The test email did not send", { problem, errorCode, responseCode });
        return { sent: false, problem };
      }
      logger.info("Sent a test email");
      return { sent: true };
    },
  };
}

// Each Member's own channels for Settings → Alerts.
export function channelSettings(database: Database): ChannelSettings {
  async function view(memberId: string) {
    const channels = await readChannels(database, memberId);
    return { ...channels, emailSetUp: (await readSmtpSettings(database)) !== undefined };
  }
  return {
    view,
    async set(memberId, channels) {
      await storeChannels(database, memberId, channels);
      return view(memberId);
    },
  };
}
