import { addNotice, type Database, endNoticeCondition, type NewNotice } from "../db/index.ts";
import { log } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import type { TransportMaker } from "./email.ts";

// System notices (spec 06, System notices; spec 07, Header and status lines). Any part of the app
// raises one to every Member. A notice is about the app itself, such as a failed backup or a broken
// Connection, and never describes the Household's Spending. It is not an Alert, so it never counts
// against the weekly Alert cap.
// - An event notice, such as "Your history is ready", stays open until a Member closes it.
// - A condition notice, such as a broken Connection, stays open until endCondition(key) runs.
//   Raising an open condition again keeps its one notice.
// Each new notice gets one delivery record, and asks for the Delivery job, which sends it by each
// Member's channels. Notices skip the weekly cap.

export type { NewNotice };

// What the Delivery job needs: the Master-key secrets for the SMTP password, the absolute address
// of a path in the app (APP_URL's), and the way to start a Delivery job: requestDelivery in the
// app. Tests give a stub SMTP transport.
export type DeliveryServices = {
  secrets: Secrets;
  address: (path: string) => string;
  startJob: () => Promise<unknown>;
  makeTransport?: TransportMaker;
};

export type NotifyServices = { database: Database; delivery?: DeliveryServices };

let services: NotifyServices | undefined;

// Gives the notify module app.db, and what delivery needs. The start calls it before jobs run.
// Without `delivery`, as in tests of other modules, notices are stored and no Delivery job starts.
export function startNotify(options: NotifyServices): { stop(): void } {
  if (services !== undefined) throw new Error("The notify module is already running.");
  const started = { ...options };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

export function running(): NotifyServices {
  if (services === undefined) throw new Error("The notify module is not running.");
  return services;
}

// Starts a Delivery job, unless one already waits. The Delivery job sends every message waiting,
// so when this start fails, the next one also sends what waits now. It never throws: a message is
// stored before it asks, and its caller goes on. Before the notify module starts, or without
// `delivery`, as in tests of other modules, it starts nothing; the next Delivery job sends what waits.
export async function askForDelivery(): Promise<void> {
  const delivery = services?.delivery;
  if (delivery === undefined) return;
  try {
    await delivery.startJob();
  } catch (error) {
    log.error("The Delivery job did not start", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
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
  const { id, added } = await oneAtATime(async () => {
    const raised = await addNotice(database, notice, new Date());
    log.info("Raised a System notice", { noticeId: raised.id, kind: notice.kind });
    return raised;
  });
  if (added) await askForDelivery();
  return id;
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
