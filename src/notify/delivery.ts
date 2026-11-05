import {
  countEmailFailure,
  type DeliveryRef,
  finishEmails,
  listEmailRecipients,
  listWaitingEmails,
  type WaitingEmail,
} from "../db/index.ts";
import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import {
  alertEmail,
  noticeEmail,
  readSmtpServer,
  sendEmail,
  sendProblem,
  smtpTransport,
} from "./email.ts";
import { endCondition, raiseNotice, running } from "./notices.ts";

// The Delivery job (spec 06, Recipients and channels; Quiet hours; System notices). It sends every
// message that waits: each sent Alert and each new System notice. Every Member gets every message,
// by the channels that Member picked.
// - Email goes at once, even in quiet hours, as one email to every Member whose channels hold
//   email. The app skips email while no SMTP server is saved, and a message it skips is not sent
//   later. Push comes with its own ticket.
// - A condition notice whose condition ended before its email went out is not sent.
// - Each message's email is done once it is sent, so running the job twice sends no second email.
// - A message whose email fails counts a try, and the job throws, so Sidequest runs it again. At
//   its cap the app gives up on that message and raises one System notice, even when another email
//   sent in the same run. A later run that sends and gives up on nothing ends it.
// - Each Member is a Bcc recipient, so no Member sees another's address.
// - A saved password that cannot be decrypted raises its own System notice, and email is skipped
//   until a Member enters the password again.

// A message's email gives up after this many failed tries in a row.
export const EMAIL_TRIES_CAP = 3;

// The System notice condition while the app has given up on an email.
export const EMAIL_STOPPED = "email stopped";

// The System notice condition while the saved SMTP password cannot be decrypted.
export const SMTP_PASSWORD_UNREADABLE = "smtp password unreadable";

export class DeliveryJob extends Job {
  override async run(): Promise<void> {
    await deliverWaiting();
  }
}

// Starts a Delivery job, unless one already waits: the waiting job sends every message waiting
// when it runs. True when it started one.
export function requestDelivery(): Promise<boolean> {
  return startJobUnlessWaiting(DeliveryJob, []);
}

const refOf = (message: WaitingEmail): DeliveryRef =>
  message.kind === "notice"
    ? { kind: "notice", id: message.id }
    : { kind: "alert", id: message.id };

// Sends every message waiting. Safe to run twice.
export async function deliverWaiting(now = () => new Date()): Promise<void> {
  const { database, delivery } = running();
  if (delivery === undefined) throw new Error("The notify module has no Delivery services.");
  const saved = await readSmtpServer(database, delivery.secrets);
  if (saved === "unreadable") {
    await raiseNotice({
      kind: "condition",
      condition: SMTP_PASSWORD_UNREADABLE,
      text: "The app cannot read the saved SMTP password, so it sends no email. Enter the SMTP password again in Settings, Alerts.",
    });
  } else {
    await endCondition(SMTP_PASSWORD_UNREADABLE);
  }
  const server = saved === "unreadable" ? undefined : saved;
  const waiting = await listWaitingEmails(database);
  if (waiting.length === 0) return;
  const recipients = server === undefined ? [] : await listEmailRecipients(database);
  const ended = waiting.filter((message) => message.kind === "notice" && message.ended);
  if (server === undefined || recipients.length === 0) {
    await finishEmails(database, waiting.map(refOf), now());
    log.info("Skipped email", {
      messages: waiting.length,
      reason:
        saved === "unreadable"
          ? "SMTP password unreadable"
          : server === undefined
            ? "no SMTP server"
            : "no Member chose email",
    });
    return;
  }
  await finishEmails(database, ended.map(refOf), now());

  const transport = (delivery.makeTransport ?? smtpTransport)(server);
  const done = { sent: 0, gaveUp: 0, failed: 0 };
  for (const message of waiting) {
    if (message.kind === "notice" && message.ended) continue;
    const email =
      message.kind === "notice"
        ? noticeEmail(message.text, delivery.address)
        : alertEmail(message, delivery.address);
    try {
      await sendEmail(transport, server, recipients, email);
    } catch (error) {
      const tries = await countEmailFailure(database, refOf(message));
      const { problem, errorCode, responseCode } = sendProblem(error);
      log.warn("An email did not send", {
        message: message.kind,
        tries,
        problem,
        errorCode,
        responseCode,
      });
      if (tries < EMAIL_TRIES_CAP) {
        done.failed += 1;
      } else {
        await finishEmails(database, [refOf(message)], now());
        done.gaveUp += 1;
      }
      continue;
    }
    await finishEmails(database, [refOf(message)], now());
    done.sent += 1;
  }
  log.info("Delivered by email", { ...done, recipients: recipients.length });
  // A give-up raises the notice even when another email sent in the same run. Only a run that
  // sends and gives up on nothing ends it.
  if (done.gaveUp > 0) {
    await raiseNotice({
      kind: "condition",
      condition: EMAIL_STOPPED,
      text: "The app could not send some emails, and gave up on them. Check the SMTP settings in Settings, Alerts.",
    });
  } else if (done.sent > 0) {
    await endCondition(EMAIL_STOPPED);
  }
  if (done.failed > 0) throw new Error("Some emails did not send. The Delivery job tries again.");
}
