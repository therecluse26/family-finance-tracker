import {
  countWeeklySummaryFailures,
  type Database,
  finishWeeklySummary,
  listWeeklySummaryMembers,
  readLastWeeklySummary,
  readSmtpSettings,
  readWeeklySummarySwitch,
  storeWeeklySummarySwitch,
  takeWeeklySummaries,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { Job } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import { endCondition, mailProblem, memberMail, raiseNotice } from "../notify/index.ts";
import { addDays } from "../recurring/index.ts";
import { buildWeeklySummary, type WeeklySummaryEmail } from "./build.ts";
import type { WeeklySummarySettings, WeeklySummaryView } from "./view.ts";
import { type SummaryWeek, summaryWeek } from "./week.ts";

// The weekly summary email's job (spec 06, Weekly summary email). Only the schedule starts it, on
// Sunday at 8:00 AM, Household time; a run missed while the app was off runs at the next start.
// - It sends the week's summary to each Member who turned it on, to their login email alone,
//   through the Household's SMTP server. With no server saved, or a password the app cannot read,
//   it sends nothing, and never sends that week later.
// - At most one summary per Member and week: each Member's week is taken in app.db before the
//   send, in the same write as the check, so two runs at once, or a run after a restart, send no
//   second copy. A stop during a send leaves that week unsent.
// - It builds the text once a run. Every Member gets the same text.
// - A failed build or send counts a try for each Member it was for, and the job throws, so
//   Sidequest runs it again. At WEEKLY_SUMMARY_TRIES_CAP tries the app gives up on that Member's
//   week and raises one System notice. A later run that sends and gives up on nothing ends it.
// - The log holds counts, never an email address or the text.

// A Member's summary for a week gives up after this many failed tries.
export const WEEKLY_SUMMARY_TRIES_CAP = 3;

// The System notice condition while the app has given up on a weekly summary.
export const WEEKLY_SUMMARY_STOPPED = "weekly summary stopped";

type Services = { database: Database; now: () => Date; logger: Logger };

let services: Services | undefined;

// Gives the weekly summary's job app.db. The start calls it before jobs run. It needs the notify
// module running too, for the SMTP server.
export function startWeeklySummary(options: {
  database: Database;
  now?: () => Date;
  logger?: Logger;
}): { stop(): void } {
  if (services !== undefined) throw new Error("The weekly summary is already running.");
  const started: Services = {
    database: options.database,
    now: options.now ?? (() => new Date()),
    logger: options.logger ?? log,
  };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

export class WeeklySummaryJob extends Job {
  override async run(): Promise<void> {
    await sendWeeklySummaries();
  }
}

// What one run did. `skipped` says why it sent nothing at all.
export type SummaryRun = {
  week: SummaryWeek;
  sent: number;
  // Failed with tries left: the job runs again.
  failed: number;
  gaveUp: number;
  skipped?: "no Member" | "not set up" | "password unreadable" | "all taken";
};

// Sends the week's summary to each Member who wants it and has not had it. Safe to run twice, and
// twice at once.
export async function sendWeeklySummaries(): Promise<SummaryRun> {
  if (services === undefined) throw new Error("The weekly summary is not running.");
  const { database, logger } = services;
  const now = services.now();
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const week = summaryWeek(now, timeZone);
  const done: SummaryRun = { week, sent: 0, failed: 0, gaveUp: 0 };

  const wanting = await listWeeklySummaryMembers(database);
  if (wanting.length === 0) return { ...done, skipped: "no Member" };
  const mail = await memberMail();
  if (typeof mail === "string") {
    logger.info("Skipped the weekly summary", { reason: mail, members: wanting.length });
    return { ...done, skipped: mail };
  }
  const taken = new Set(
    await takeWeeklySummaries(
      database,
      wanting.map((member) => member.id),
      week.from,
      now,
    ),
  );
  const members = wanting.filter((member) => taken.has(member.id));
  if (members.length === 0) return { ...done, skipped: "all taken" };

  let email: WeeklySummaryEmail | undefined;
  try {
    email = await buildWeeklySummary({ database, week, timeZone, address: mail.address, now });
  } catch (error) {
    logger.warn("The weekly summary did not build", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }

  const failed: string[] = [];
  if (email === undefined) {
    failed.push(...members.map((member) => member.id));
  } else {
    for (const member of members) {
      try {
        await mail.send(member.email, email);
      } catch (error) {
        const { problem, errorCode, responseCode } = mailProblem(error);
        logger.warn("A weekly summary email did not send", { problem, errorCode, responseCode });
        failed.push(member.id);
        continue;
      }
      await finishWeeklySummary(database, member.id, week.from, now);
      done.sent += 1;
    }
  }
  for (const counted of await countWeeklySummaryFailures(
    database,
    failed,
    week.from,
    WEEKLY_SUMMARY_TRIES_CAP,
    now,
  )) {
    if (counted.state === "gave up") done.gaveUp += 1;
    else done.failed += 1;
  }
  logger.info("Sent the weekly summary", {
    sent: done.sent,
    failed: done.failed,
    gaveUp: done.gaveUp,
  });
  // A give-up raises the notice even when another summary sent in the same run. Only a run that
  // sends and gives up on nothing ends it.
  if (done.gaveUp > 0) {
    await raiseNotice({
      kind: "condition",
      condition: WEEKLY_SUMMARY_STOPPED,
      text: "The app could not send some weekly summary emails, and gave up on them. Check the SMTP settings in Settings, Alerts.",
    });
  } else if (done.sent > 0) {
    await endCondition(WEEKLY_SUMMARY_STOPPED);
  }
  if (done.failed > 0) {
    throw new Error("Some weekly summary emails did not send. The job tries again.");
  }
  return done;
}

// The signed-in Member's own switch for Settings, Alerts. Every write names the Member from the
// session, so a Member changes only their own.
export function weeklySummarySettings(database: Database): WeeklySummarySettings {
  async function view(memberId: string): Promise<WeeklySummaryView> {
    const timeZone = (await householdTimeZone(database)) ?? "UTC";
    const last = await readLastWeeklySummary(database, memberId);
    return {
      on: await readWeeklySummarySwitch(database, memberId),
      emailSetUp: (await readSmtpSettings(database)) !== undefined,
      last:
        last === undefined
          ? null
          : {
              from: last.weekStart,
              to: addDays(last.weekStart, 6),
              state: last.state,
              on: calendarDateIn(last.at, timeZone),
            },
    };
  }
  return {
    view,
    async set(memberId, on) {
      await storeWeeklySummarySwitch(database, memberId, on);
      return view(memberId);
    },
  };
}
