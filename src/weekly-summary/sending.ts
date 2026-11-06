import {
  countWeeklySummaryFailures,
  type Database,
  finishWeeklySummary,
  listWeeklySummaryMembers,
  readLatestWeeklySummary,
  readSmtpSettings,
  readWeeklySummarySwitch,
  storeWeeklySummarySwitch,
  takeWeeklySummaries,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import { endCondition, mailProblem, memberMail, raiseNotice } from "../notify/index.ts";
import { addDays } from "../recurring/index.ts";
import { buildWeeklySummary, type WeeklySummaryEmail } from "./build.ts";
import type { WeeklySummarySettings, WeeklySummaryView } from "./view.ts";
import { type SummaryWeek, summaryWeek, weekFrom } from "./week.ts";

// The weekly summary email's job (spec 06, Weekly summary email). Only the schedule starts it, on
// Sunday at 8:00 AM, Household time; a run missed while the app was off runs at the next start. A
// run that has failed sends starts its own retry, later, for the same week.
// - It sends the week's summary to each Member who turned it on, to their login email alone,
//   through the Household's SMTP server. With no server saved, or a password the app cannot read,
//   it sends nothing, and never sends that week later.
// - It builds the text once a run, before it takes any Member's week, so a stop during the build
//   loses no week. Every Member gets the same text.
// - At most one summary per Member and week: each Member's week is taken in app.db before the
//   send, in the same write as the check, so two runs at once, or a run after a restart, send no
//   second copy. A stop during a send leaves that week unsent.
// - A failed build or send counts a try for each Member it was for. With tries left, the run
//   starts a retry of the same week after WEEKLY_SUMMARY_RETRY_DELAYS_MS, so a short SMTP outage
//   does not cost the week. At WEEKLY_SUMMARY_TRIES_CAP tries the app gives up on that Member's
//   week and raises one System notice. A later run that sends and gives up on nothing ends it.
// - A retry sends only while its week is the current one: after the next Sunday 8:00 AM it sends
//   nothing.
// - The log holds counts and error codes, never an email address or the text.

// A Member's summary for a week gives up after this many failed tries.
export const WEEKLY_SUMMARY_TRIES_CAP = 3;

// How long a retry waits after a failed try: the first, then the second.
export const WEEKLY_SUMMARY_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;

// The System notice condition while the app has given up on a weekly summary.
export const WEEKLY_SUMMARY_STOPPED = "weekly summary stopped";

type Services = {
  database: Database;
  now: () => Date;
  logger: Logger;
  startRetry: (weekStart: string, at: Date) => Promise<void>;
};

let services: Services | undefined;

// Gives the weekly summary's job app.db. The start calls it before jobs run. It needs the notify
// module running too, for the SMTP server.
export function startWeeklySummary(options: {
  database: Database;
  now?: () => Date;
  logger?: Logger;
  // Starts a retry of a week's summary at `at`. Tests pass their own.
  startRetry?: (weekStart: string, at: Date) => Promise<void>;
}): { stop(): void } {
  if (services !== undefined) throw new Error("The weekly summary is already running.");
  const started: Services = {
    database: options.database,
    now: options.now ?? (() => new Date()),
    logger: options.logger ?? log,
    startRetry:
      options.startRetry ?? ((weekStart, at) => startJob(WeeklySummaryJob, [weekStart], { at })),
  };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// The schedule starts it with no argument, for the current week. A retry names its week's Sunday.
export class WeeklySummaryJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    const [weekStart] = args;
    if (weekStart !== undefined && typeof weekStart !== "string") {
      throw new Error("WeeklySummaryJob takes a week's first date, or nothing.");
    }
    await sendWeeklySummaries(weekStart);
  }
}

// What one run did. `skipped` says why it sent nothing at all.
export type SummaryRun = {
  week: SummaryWeek;
  sent: number;
  // Failed with tries left: a retry runs later.
  failed: number;
  gaveUp: number;
  skipped?: "no Member" | "not set up" | "password unreadable" | "all taken" | "week over";
  // When the retry runs, for a run with failed sends.
  retryAt?: Date;
};

// Sends the week's summary to each Member who wants it and has not had it. Safe to run twice, and
// twice at once. `weekStart` names a retry's week: it sends only while that week is the current one.
export async function sendWeeklySummaries(weekStart?: string): Promise<SummaryRun> {
  if (services === undefined) throw new Error("The weekly summary is not running.");
  const { database, logger, startRetry } = services;
  const now = services.now();
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const week = summaryWeek(now, timeZone);
  const done: SummaryRun = { week, sent: 0, failed: 0, gaveUp: 0 };
  if (weekStart !== undefined && weekStart !== week.from) {
    logger.info("Skipped the weekly summary", { reason: "week over" });
    return { ...done, week: weekFrom(weekStart), skipped: "week over" };
  }

  const wanting = await listWeeklySummaryMembers(database);
  if (wanting.length === 0) return { ...done, skipped: "no Member" };
  const mail = await memberMail();
  if (typeof mail === "string") {
    logger.info("Skipped the weekly summary", { reason: mail, members: wanting.length });
    return { ...done, skipped: mail };
  }

  // The build only reads, so it comes before the take: a stop during it leaves no week taken.
  let email: WeeklySummaryEmail | undefined;
  try {
    email = await buildWeeklySummary({ database, week, timeZone, address: mail.address, now });
  } catch (error) {
    logger.warn("The weekly summary did not build", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
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
  let fewestTries: number | undefined;
  for (const counted of await countWeeklySummaryFailures(
    database,
    failed,
    week.from,
    WEEKLY_SUMMARY_TRIES_CAP,
    now,
  )) {
    if (counted.state === "gave up") {
      done.gaveUp += 1;
    } else {
      done.failed += 1;
      fewestTries = Math.min(fewestTries ?? counted.tries, counted.tries);
    }
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
  // A failed send with tries left: the retry waits for the Member with the fewest tries so far.
  if (fewestTries !== undefined) {
    const delay =
      WEEKLY_SUMMARY_RETRY_DELAYS_MS[fewestTries - 1] ?? WEEKLY_SUMMARY_RETRY_DELAYS_MS.at(-1);
    done.retryAt = new Date(now.getTime() + (delay ?? 0));
    await startRetry(week.from, done.retryAt);
  }
  return done;
}

// A summary still "sending" or "failed" this long after its last change has no retry coming: the
// app stopped during a send, or the email server went away between tries. It did not send.
export const WEEKLY_SUMMARY_STALE_MS = 60 * 60_000;

// The signed-in Member's own switch for Settings, Alerts. Every write names the Member from the
// session, so a Member changes only their own. The row shows the Member's latest week: sent, still
// sending (a retry may come), or not sent.
export function weeklySummarySettings(
  database: Database,
  now: () => Date = () => new Date(),
): WeeklySummarySettings {
  async function view(memberId: string): Promise<WeeklySummaryView> {
    const timeZone = (await householdTimeZone(database)) ?? "UTC";
    const latest = await readLatestWeeklySummary(database, memberId);
    const stateOf = (row: NonNullable<typeof latest>) => {
      if (row.state === "sent") return "sent" as const;
      if (row.state === "gave up") return "did not send" as const;
      return now().getTime() - row.at.getTime() < WEEKLY_SUMMARY_STALE_MS
        ? ("sending" as const)
        : ("did not send" as const);
    };
    return {
      on: await readWeeklySummarySwitch(database, memberId),
      emailSetUp: (await readSmtpSettings(database)) !== undefined,
      last:
        latest === undefined
          ? null
          : {
              from: latest.weekStart,
              to: addDays(latest.weekStart, 6),
              state: stateOf(latest),
              on: calendarDateIn(latest.at, timeZone),
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
