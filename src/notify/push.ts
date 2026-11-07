import { parse as legacyParse } from "node:url";
import webpush from "web-push";
import {
  countPushFailure,
  type Database,
  finishPushes,
  handOutPushes,
  listWaitingPushes,
  type PushDeviceFields,
  readPushDeviceMember,
  readSetupSteps,
  readVapidKeys,
  removeMemberPushDevices,
  removePushDevice,
  removePushDevices,
  removeWaitingPushes,
  replaceVapidKeys,
  type StoredVapidKeys,
  storePushDevice,
  VAPID_KEYS_ROW,
} from "../db/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { daily } from "../jobs/index.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import { endCondition, raiseNotice, running } from "./notices.ts";
import type { PushSettings } from "./push-view.ts";

// Web push (spec 06, Recipients and channels; Quiet hours; System notices; spec 09, Security mode;
// Encryption at rest). Only over HTTPS: in plain-HTTP mode email is the only channel. A push holds
// the Alert's kind as its title and its template text as its body, or a System notice's text, and
// nothing else: no AI advice. This file is the only importer of web-push, which stays unmodified.
// - The VAPID keys are Master-key secrets. The app makes them itself, once the first-run wizard's
//   step 3 is done, and never shows or logs the private key.
// - Push waits from 9 PM to 8 AM, Household time. A Delivery job then starts for 8 AM.
// - A device the push service reports gone is removed.
// - A push that fails counts a try, and the Delivery job throws, so Sidequest runs it again. At
//   its cap the app gives up on that push and raises one System notice. A later run that sends and
//   gives up on nothing ends it.

// The System notice raised when the stored VAPID keys cannot be read, so the app made new ones
// and removed every device.
export const PUSH_KEYS_REPLACED =
  "The app could not read its push keys, so it made new ones and turned Alerts off on every device. Turn Alerts on again on each device in Settings, Alerts.";

// A push gives up after this many failed tries in a row.
export const PUSH_TRIES_CAP = 3;

// The System notice condition while the app has given up on a push.
export const PUSH_STOPPED = "push stopped";

// Each key's place. Its ciphertext decrypts only in vapid_keys' one row, in this column.
const PUBLIC_KEY_PLACE: SecretPlace = { rowId: VAPID_KEYS_ROW, column: "vapid_keys.public_key" };
const PRIVATE_KEY_PLACE: SecretPlace = { rowId: VAPID_KEYS_ROW, column: "vapid_keys.private_key" };

export type VapidKeys = { publicKey: string; privateKey: string };

// What each push service gets with a push: the VAPID keys, and APP_URL's origin as the subject,
// which names the app. Never a Member's email address.
export type Vapid = VapidKeys & { subject: string };

// Sends one push to one device, and throws when the push service refuses it. Tests give a stub, so
// no test reaches a push service.
export type PushSender = (device: PushDeviceFields, payload: string, vapid: Vapid) => Promise<void>;

// A push the push service cannot hand to the device within a day is dropped.
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 15_000;

// What web-push takes for one push to one device. The stub sender in tests builds the same request.
export function pushRequest(
  device: PushDeviceFields,
  vapid: Vapid,
): [webpush.PushSubscription, webpush.RequestOptions] {
  return [
    { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
    {
      vapidDetails: vapid,
      TTL: PUSH_TTL_SECONDS,
      timeout: PUSH_TIMEOUT_MS,
      contentEncoding: "aes128gcm",
      urgency: "normal",
    },
  ];
}

export const webPushSender: PushSender = async (device, payload, vapid) => {
  const [subscription, options] = pushRequest(device, vapid);
  await webpush.sendNotification(subscription, payload, options);
};

// The push services the app sends to: Chrome's and the browsers built on it, Firefox's, Safari's,
// and Edge's. A browser's endpoint names one of them. The app sends to no other address, so a
// stored endpoint cannot point it at another server.
const PUSH_SERVICE_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const PUSH_SERVICE_DOMAINS = [".push.apple.com", ".notify.windows.com"];
const MAX_ENDPOINT_LENGTH = 2048;

// A host name of plain ASCII labels, in lower case: no IP literal with a port, no percent-escape,
// and none of the characters at which the two URL parsers below end a host differently.
const PLAIN_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

// True when the endpoint names a push service, read the same way by the URL parser and by the
// older one web-push sends with (url.parse). The endpoint must already be in the form the URL
// parser writes, so nothing is decoded, trimmed or folded on the way: what is checked is what is
// stored and sent.
export function isPushServiceEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.href !== endpoint) return false;
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname;
  if (!PLAIN_HOST.test(host)) return false;
  const listed =
    PUSH_SERVICE_HOSTS.has(host) || PUSH_SERVICE_DOMAINS.some((domain) => host.endsWith(domain));
  if (!listed) return false;
  const sent = legacyParse(endpoint);
  return (
    sent.protocol === "https:" && sent.hostname === host && sent.port === null && sent.auth === null
  );
}

// What a failed send means. Only the push service's status code is read: web-push's error also
// holds the endpoint, the reply's headers and body. 404 and 410 mean the device is gone.
export function pushProblem(error: unknown): { gone: boolean; statusCode: number | null } {
  const fields = typeof error === "object" && error !== null ? error : {};
  const status =
    "statusCode" in fields && typeof fields.statusCode === "number" ? fields.statusCode : null;
  const statusCode = status !== null && Number.isInteger(status) ? status : null;
  return { gone: statusCode === 404 || statusCode === 410, statusCode };
}

// A push's body holds at most this many characters, so the encrypted push stays under the 4 KB
// that push services take.
export const MAX_PUSH_BODY = 500;

// What the service worker shows: the title, the body, and the page a tap opens. The tag is the
// push's own, so a push sent again replaces the notification it already showed.
export function pushPayload(push: {
  id: number;
  kind: "alert" | "notice";
  title: string;
  body: string;
}): string {
  const characters = Array.from(push.body);
  const body =
    characters.length > MAX_PUSH_BODY
      ? `${characters.slice(0, MAX_PUSH_BODY - 1).join("")}…`
      : push.body;
  return JSON.stringify({
    title: push.title,
    body,
    url: push.kind === "alert" ? "/alert-list" : "/",
    tag: `push-${push.id}`,
  });
}

const QUIET_HOURS_END = daily("08:00");
const QUIET_HOURS_START = daily("21:00");

// Whether `at` is in quiet hours: from 9 PM to 8 AM in the Household time zone.
export function inQuietHours(at: Date, timeZone: string): boolean {
  return QUIET_HOURS_END.next(at, timeZone) < QUIET_HOURS_START.next(at, timeZone);
}

// Keys change one at a time, so two first uses at once make one pair. The app is one Node process
// (ADR 0002), so this queue covers every caller.
let keyQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = keyQueue.then(work);
  keyQueue = run.catch(() => {});
  return run;
}

function readKeys(
  stored: StoredVapidKeys,
  secrets: Secrets,
  logger: Logger,
): VapidKeys | undefined {
  try {
    const privateKey = secrets.decrypt(stored.privateKey, PRIVATE_KEY_PLACE);
    registerSecretValue(privateKey);
    return { publicKey: secrets.decrypt(stored.publicKey, PUBLIC_KEY_PLACE), privateKey };
  } catch {
    logger.warn("The stored VAPID keys cannot be read");
    return undefined;
  }
}

// The app's VAPID keys. It makes them when none are stored, and when the stored ones cannot be
// decrypted, as after a restore without the Master key: new keys remove every device, and each
// Member turns Alerts on again. It checks the first-run wizard's step 3 itself, whoever calls it:
// before step 3 is done it makes no keys, stores no Master-key secret, and returns undefined.
export function vapidKeysOf(
  database: Database,
  secrets: Secrets,
  logger: Logger = log,
): Promise<VapidKeys | undefined> {
  return oneAtATime(async () => {
    const stored = await readVapidKeys(database);
    const read = stored === undefined ? undefined : readKeys(stored, secrets, logger);
    if (read !== undefined) return read;
    if ((await readSetupSteps(database)).get("master key") !== "done") return undefined;
    const made = webpush.generateVAPIDKeys();
    registerSecretValue(made.privateKey);
    const removedDevices = await replaceVapidKeys(database, {
      publicKey: secrets.encrypt(made.publicKey, PUBLIC_KEY_PLACE),
      privateKey: secrets.encrypt(made.privateKey, PRIVATE_KEY_PLACE),
    });
    logger.info("Made the VAPID keys", { removedDevices });
    if (stored !== undefined) {
      await raiseNotice({ kind: "event", text: PUSH_KEYS_REPLACED });
    }
    return made;
  });
}

// Web push for Settings → Alerts. `available` is false in plain-HTTP mode.
export function pushSettings(options: {
  database: Database;
  secrets: Secrets;
  available: boolean;
  logger?: Logger;
}): PushSettings {
  const { database, secrets, available, logger = log } = options;
  return {
    async view() {
      if (!available) return { available: false, why: "plain HTTP" };
      const keys = await vapidKeysOf(database, secrets, logger);
      if (keys === undefined) return { available: false, why: "setup not done" };
      return { available: true, publicKey: keys.publicKey };
    },

    async addDevice(memberId, subscription) {
      if (!available) return { added: false, refusal: "plain HTTP" };
      if (!isPushServiceEndpoint(subscription.endpoint)) {
        return { added: false, refusal: "unknown push service" };
      }
      if ((await vapidKeysOf(database, secrets, logger)) === undefined) {
        return { added: false, refusal: "setup not done" };
      }
      const stored = await storePushDevice(
        database,
        memberId,
        { endpoint: subscription.endpoint, ...subscription.keys },
        new Date(),
      );
      if (!stored) return { added: false, refusal: "another Member's device" };
      logger.info("Turned Alerts on for a device");
      return { added: true };
    },

    async deviceOwner(memberId, endpoint) {
      const owner = await readPushDeviceMember(database, endpoint);
      if (owner === undefined) return "no Member";
      return owner === memberId ? "this Member" : "another Member";
    },

    async removeDevice(memberId, endpoint) {
      const removed = await removePushDevice(database, memberId, endpoint);
      if (removed) logger.info("Turned Alerts off for a device");
      return removed;
    },
  };
}

// Removes every device of one Member, with the pushes that wait for them, as when the Member is
// removed. Returns how many it removed.
export async function removeMemberDevices(database: Database, memberId: string): Promise<number> {
  const removed = await removeMemberPushDevices(database, memberId);
  if (removed > 0) log.info("Removed a Member's devices", { devices: removed });
  return removed;
}

// What push needs in the Delivery job, given only in HTTPS mode: APP_URL's origin as the VAPID
// subject, and the way to start a Delivery job at a later time: requestDeliveryAt in the app.
// Tests give a stub sender.
export type PushServices = {
  subject: string;
  startJobAt: (at: Date) => Promise<unknown>;
  send?: PushSender;
};

// Hands out and sends every push that waits, unless quiet hours hold them. True when a push failed
// and has tries left, so the Delivery job runs again.
export async function deliverPushes(now: Date): Promise<boolean> {
  const { database, delivery } = running();
  if (delivery === undefined) throw new Error("The notify module has no Delivery services.");
  const push = delivery.push;
  const handed = await handOutPushes(database, { pushOn: push !== undefined, at: now });
  if (push === undefined) {
    const removed = await removeWaitingPushes(database);
    if (handed.messages + removed > 0) {
      log.info("Skipped push", { messages: handed.messages, reason: "plain HTTP" });
    }
    return false;
  }
  const waiting = await listWaitingPushes(database);
  if (waiting.length === 0) return false;

  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  if (inQuietHours(now, timeZone)) {
    const at = QUIET_HOURS_END.next(now, timeZone);
    try {
      await push.startJobAt(at);
    } catch (error) {
      // The pushes stay stored: the next Delivery job after 8 AM sends them.
      log.error("The 8 AM Delivery job did not start", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    log.info("Held push for quiet hours", { pushes: waiting.length });
    return false;
  }

  const keys = await vapidKeysOf(database, delivery.secrets);
  if (keys === undefined) return false;
  // Read again: new keys remove every device with its pushes.
  const stillWaiting = await listWaitingPushes(database);
  const vapid: Vapid = { ...keys, subject: push.subject };
  const send = push.send ?? webPushSender;
  const gone = new Set<number>();
  const done = { sent: 0, gaveUp: 0, failed: 0, gone: 0, skipped: 0 };
  for (const each of stillWaiting) {
    if (gone.has(each.device.id)) continue;
    // Checked again before each send, for a row stored before the check was as strict as now.
    if (!isPushServiceEndpoint(each.device.endpoint)) {
      gone.add(each.device.id);
      await removePushDevices(database, [each.device.id]);
      log.warn("Removed a device whose push service the app does not send to");
      continue;
    }
    if (each.ended || !each.pushOn) {
      await finishPushes(database, [each.id]);
      done.skipped += 1;
      continue;
    }
    try {
      await send(each.device, pushPayload(each), vapid);
    } catch (error) {
      const { gone: isGone, statusCode } = pushProblem(error);
      if (isGone) {
        gone.add(each.device.id);
        await removePushDevices(database, [each.device.id]);
        done.gone += 1;
        continue;
      }
      const tries = await countPushFailure(database, each.id);
      log.warn("A push did not send", { message: each.kind, tries, statusCode });
      if (tries < PUSH_TRIES_CAP) {
        done.failed += 1;
      } else {
        await finishPushes(database, [each.id]);
        done.gaveUp += 1;
      }
      continue;
    }
    await finishPushes(database, [each.id]);
    done.sent += 1;
  }
  log.info("Delivered by push", { ...done, removedDevices: gone.size });
  if (done.gaveUp > 0) {
    await raiseNotice({
      kind: "condition",
      condition: PUSH_STOPPED,
      text: "The app could not send some pushes, and gave up on them. Turn Alerts off and on again on your devices in Settings, Alerts.",
    });
  } else if (done.sent > 0) {
    await endCondition(PUSH_STOPPED);
  }
  return done.failed > 0;
}
