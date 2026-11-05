import { createTransport } from "nodemailer";
import type { SmtpServer, TransportMaker } from "./email.ts";

// Test support: a stubbed SMTP server. nodemailer builds each message as it would for a real
// server, and a stub transport keeps it instead of opening a connection. No test reaches a mail
// server.

export type StubbedEmail = {
  from: string;
  // The addresses in the To header, which every recipient sees.
  to: string[];
  // The Bcc recipients, which no header names.
  bcc: string[];
  // Every address the server would deliver to.
  envelope: string[];
  subject: string;
  text: string;
  // The whole message as nodemailer wrote it, headers included.
  raw: string;
};

export class StubSmtp {
  readonly emails: StubbedEmail[] = [];
  // The server each transport was made for, password included.
  readonly servers: SmtpServer[] = [];
  // When set, every send fails with this error, as nodemailer's would.
  failWith: Error | undefined;
  // When set, only sends whose subject is in it fail.
  failSubjects: Set<string> | undefined;

  readonly makeTransport: TransportMaker = (server) => {
    this.servers.push(server);
    return createTransport({
      name: "stub",
      version: "1",
      send: (mail, callback) => {
        const subject = String(mail.data.subject ?? "");
        const failure =
          this.failSubjects === undefined || this.failSubjects.has(subject)
            ? this.failWith
            : undefined;
        if (failure !== undefined) return callback(failure, undefined);
        mail.message.build((error, raw) => {
          if (error !== null) return callback(error, undefined);
          const envelope = mail.message.getEnvelope();
          const addresses = mail.message.getAddresses();
          this.emails.push({
            from: envelope.from === false ? "" : envelope.from,
            to: (addresses.to ?? []).map((each) => each.address ?? ""),
            bcc: (addresses.bcc ?? []).map((each) => each.address ?? ""),
            envelope: envelope.to,
            subject,
            text: String(mail.data.text ?? ""),
            raw: raw.toString("utf8"),
          });
          callback(null, { envelope });
        });
      },
    });
  };
}

// An error as nodemailer gives one, whose message quotes the server's reply.
export function smtpError(code: string, responseCode: number, message: string): Error {
  return Object.assign(new Error(message), { code, responseCode });
}
