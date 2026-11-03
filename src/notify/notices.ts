import { addNotice, type Database, endNoticeCondition, type NewNotice } from "../db/index.ts";
import { log } from "../log.ts";

// System notices (spec 06, System notices; spec 07, Header and status lines). Any part of the app
// raises one to every Member. A notice is about the app itself, such as a failed backup or a broken
// Connection, and never describes the Household's Spending. It is not an Alert, so it never counts
// against the weekly Alert cap.
// - An event notice, such as "Your history is ready", stays open until a Member closes it.
// - A condition notice, such as a broken Connection, stays open until endCondition(key) runs.
//   Raising an open condition again keeps its one notice.
// Each new notice gets one delivery record, which the email and push Delivery jobs send.

export type { NewNotice };

let services: { database: Database } | undefined;

// Gives the notify module app.db. The start calls it before jobs run.
export function startNotify(options: { database: Database }): { stop(): void } {
  if (services !== undefined) throw new Error("The notify module is already running.");
  const started = { database: options.database };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

function running(): { database: Database } {
  if (services === undefined) throw new Error("The notify module is not running.");
  return services;
}

// Notices change one at a time, so two raises of one condition at once keep one notice. The app is
// one Node process (ADR 0002), so this queue covers every caller.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

// Raises a System notice to every Member, and returns its ID. For an open condition, it returns
// the open notice's ID and adds nothing.
export async function raiseNotice(notice: NewNotice): Promise<string> {
  const { database } = running();
  if (notice.text.trim() === "") throw new Error("A System notice needs its text.");
  return oneAtATime(async () => {
    const id = await addNotice(database, notice, new Date());
    log.info("Raised a System notice", { noticeId: id, kind: notice.kind });
    return id;
  });
}

// Ends a condition: its open notice closes for every Member. Nothing happens when none is open.
export async function endCondition(key: string): Promise<void> {
  const { database } = running();
  return oneAtATime(async () => {
    if (await endNoticeCondition(database, key, new Date())) {
      log.info("Ended a System notice condition");
    }
  });
}
