import { readSmtpServer, sendEmail, sendProblem, smtpTransport } from "./email.ts";
import { running } from "./notices.ts";

// Email to one Member at a time, through the Household's SMTP server, for the weekly summary email
// (spec 06, Weekly summary email). Each email goes to that Member alone, as a Bcc recipient, as
// every email the app sends does.

export type MemberMail = {
  // The absolute address of a path in the app, APP_URL's.
  address: (path: string) => string;
  // Sends one email to this address. It throws as nodemailer does: read the error only with
  // mailProblem, since its message can quote the server's reply.
  send(to: string, email: { subject: string; text: string }): Promise<void>;
};

// The way to email a Member, or why there is none: no SMTP server is saved, or its password cannot
// be decrypted.
export async function memberMail(): Promise<MemberMail | "not set up" | "password unreadable"> {
  const { database, delivery } = running();
  if (delivery === undefined) throw new Error("The notify module has no Delivery services.");
  const server = await readSmtpServer(database, delivery.secrets);
  if (server === undefined) return "not set up";
  if (server === "unreadable") return "password unreadable";
  const transport = (delivery.makeTransport ?? smtpTransport)(server);
  return {
    address: delivery.address,
    send: (to, email) => sendEmail(transport, server, [to], email),
  };
}

// What a failed send means, from nodemailer's error: only its code and the server's reply code.
export const mailProblem = sendProblem;
