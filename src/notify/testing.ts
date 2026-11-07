import { createTransport } from "nodemailer";
import webpush from "web-push";
import type { SmtpServer, TransportMaker } from "./email.ts";
import { type PushSender, pushRequest } from "./push.ts";
import type { PushSubscriptionFields } from "./push-view.ts";

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
  // When set, only sends to an address in it fail.
  failRecipients: Set<string> | undefined;

  readonly makeTransport: TransportMaker = (server) => {
    this.servers.push(server);
    return createTransport({
      name: "stub",
      version: "1",
      send: (mail, callback) => {
        const subject = String(mail.data.subject ?? "");
        const recipients = mail.message.getEnvelope().to;
        const failure =
          (this.failSubjects === undefined || this.failSubjects.has(subject)) &&
          (this.failRecipients === undefined ||
            recipients.some((each) => this.failRecipients?.has(each)))
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

// A stubbed push service. Each send builds the request web-push would make, payload encryption and
// VAPID header included, and keeps it instead of sending it. No test reaches a push service.

export type StubbedPush = {
  endpoint: string;
  // The payload as the service worker reads it.
  shown: { title: string; body: string; url: string; tag: string };
  payload: string;
  // The request's headers, the VAPID Authorization header included.
  headers: Record<string, string>;
  subject: string;
  publicKey: string;
};

export class StubPushService {
  readonly pushes: StubbedPush[] = [];
  // Every send to these endpoints fails with this status code, as the push service would answer.
  readonly failWith = new Map<string, number>();

  readonly send: PushSender = async (device, payload, vapid) => {
    const status = this.failWith.get(device.endpoint);
    if (status !== undefined) {
      throw new webpush.WebPushError(
        "Received unexpected response code",
        status,
        {},
        `The push service's reply for ${device.endpoint}`,
        device.endpoint,
      );
    }
    const [subscription, options] = pushRequest(device, vapid);
    const request = webpush.generateRequestDetails(subscription, payload, options);
    this.pushes.push({
      endpoint: device.endpoint,
      shown: JSON.parse(payload),
      payload,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
      ),
      subject: vapid.subject,
      publicKey: vapid.publicKey,
    });
  };
}

const randomText = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

// A browser's push subscription, as a browser makes one: its endpoint at a push service, a P-256
// public key, and a 16-byte auth secret, all made when the test runs.
export function newSubscription(
  service = "https://fcm.googleapis.com/fcm/send/",
): PushSubscriptionFields {
  // A VAPID key pair is a P-256 key pair too: its public key is a browser key's 65 bytes.
  const browserKey = webpush.generateVAPIDKeys();
  return {
    endpoint: `${service}${randomText(24)}`,
    keys: { p256dh: browserKey.publicKey, auth: randomText(16) },
  };
}

export { TickJob } from "../jobs/sidequest.ts";
export { DeliveryJob, MorningDeliveryJob } from "./delivery.ts";

// The job list for tests that run Delivery jobs in Sidequest.
export const TEST_NOTIFY_JOB_LIST = import.meta.url;
