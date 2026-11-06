import { useEffect, useState } from "react";
import type { PushSubscriptionFields, PushView } from "../../../notify/push-view.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { SERVICE_WORKER } from "../../install.ts";

// Settings, Alerts: push on this device (spec 06, Recipients and channels; spec 09, Security mode).
// Each Member turns Alerts on for each of their devices, over HTTPS only. In plain-HTTP mode push
// and the install prompt are hidden, and a note says why.

// The page's writes, exactly as it sends them. Each sends a JSON body: the server answers 415 to a
// write without one.
export const addDevice = (json: PushSubscriptionFields) => api.push.devices.$post({ json });
export const removeDevice = (endpoint: string) => api.push.devices.$delete({ json: { endpoint } });

// The words to show for a refused request: the server's own.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// A part of the My channels card, under a line.
const PART = "mt-4 border-t border-line-soft pt-3.5";

export const PLAIN_HTTP_NOTE =
  "Push and installing the app need HTTPS. This app runs in plain-HTTP mode: its address starts with http://, and browsers allow push only over HTTPS. So Alerts and System notices come by email only.";

// The VAPID public key, from base64url to the bytes the browser takes.
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  const found = await navigator.serviceWorker.getRegistration("/");
  if (found !== undefined) return found;
  await navigator.serviceWorker.register(SERVICE_WORKER, { scope: "/" });
  return navigator.serviceWorker.ready;
}

// This browser's subscription under the app's current key. One made under older keys, as before a
// restore without the Master key, no longer works: it is dropped.
async function currentSubscription(publicKey: string): Promise<PushSubscription | null> {
  const found = await (await registration()).pushManager.getSubscription();
  if (found === null) return null;
  const key = found.options.applicationServerKey;
  if (key !== null && sameBytes(new Uint8Array(key), keyBytes(publicKey))) return found;
  await found.unsubscribe();
  return null;
}

type DeviceState = "checking" | "on" | "off" | "not supported";

export function DevicePush(props: { publicKey: string; initial?: DeviceState }) {
  const { publicKey } = props;
  const [state, setState] = useState<DeviceState>(props.initial ?? "checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!pushSupported()) return setState("not supported");
    currentSubscription(publicKey)
      .then((found) => setState(found === null ? "off" : "on"))
      .catch(() => setState("not supported"));
  }, [publicKey]);

  async function turnOn() {
    setBusy(true);
    setError(undefined);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        return setError(
          "The browser blocks notifications for this app. Allow them in the browser's settings for this site, then try again.",
        );
      }
      const subscription =
        (await currentSubscription(publicKey)) ??
        (await (
          await registration()
        ).pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }));
      const { keys } = subscription.toJSON();
      const res = await addDevice({
        endpoint: subscription.endpoint,
        keys: { p256dh: keys?.p256dh ?? "", auth: keys?.auth ?? "" },
      });
      if (!res.ok) {
        await subscription.unsubscribe();
        return setError(await refusal(res));
      }
      setState("on");
    } catch {
      setError("Alerts did not turn on for this device.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(undefined);
    try {
      const subscription = await currentSubscription(publicKey);
      if (subscription !== null) {
        const res = await removeDevice(subscription.endpoint);
        if (!res.ok) return setError(await refusal(res));
        await subscription.unsubscribe();
      }
      setState("off");
    } catch {
      setError("Alerts did not turn off for this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={PART} aria-labelledby="push-on-this-device">
      <h4 id="push-on-this-device" className="font-semibold">
        Push on this device
      </h4>
      <p className="mt-0.5 text-small text-muted">
        Pushes show each Alert's kind and its text. They wait from 9 PM to 8 AM, Household time.
        Turn Alerts on for each device you want them on.
      </p>
      {state === "not supported" ? (
        <p className="mt-2">This browser cannot get pushes.</p>
      ) : state === "on" ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <p className="text-small">
            <StatusText tone="good">Alerts are on for this device.</StatusText>
          </p>
          <Button type="button" variant="outlined" size="small" disabled={busy} onClick={turnOff}>
            Turn off Alerts on this device
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outlined"
          size="small"
          className="mt-2.5"
          disabled={busy || state === "checking"}
          onClick={turnOn}
        >
          Turn on Alerts on this device
        </Button>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

// "Add to Home Screen" (spec 06, Recipients and channels): on an iPhone, only an app on the Home
// Screen gets pushes, so the page explains it first. The installed app opens standalone, and needs
// no such note.
export function needsHomeScreen(userAgent: string, standalone: boolean): boolean {
  return /\biPhone\b/.test(userAgent) && !standalone;
}

export const HOME_SCREEN_NOTE =
  "On an iPhone, Alerts come only to the app on your Home Screen. In Safari, tap Share, then Add to Home Screen. Open the app from your Home Screen, sign in, and turn on Alerts there.";

// Whether this browser needs the Home Screen note: an iPhone outside the installed app.
export function homeScreenFirstHere(): boolean {
  if (typeof window === "undefined") return false;
  const apple = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const standalone = apple || window.matchMedia?.("(display-mode: standalone)").matches === true;
  return needsHomeScreen(navigator.userAgent, standalone);
}

// Push on this device: hidden in plain-HTTP mode, with the reason shown; on an iPhone, the Home
// Screen note comes first.
export function PushPart(props: { push: PushView; homeScreenFirst: boolean }) {
  return (
    <>
      {props.push.available && props.homeScreenFirst ? (
        <section className={PART} aria-labelledby="add-to-home-screen">
          <h4 id="add-to-home-screen" className="font-semibold">
            Add to Home Screen
          </h4>
          <p className="mt-0.5">{HOME_SCREEN_NOTE}</p>
        </section>
      ) : null}
      <AlertPush push={props.push} />
    </>
  );
}

export function AlertPush(props: { push: PushView }) {
  const { push } = props;
  if (push.available) return <DevicePush publicKey={push.publicKey} />;
  if (push.why === "setup not done") return null;
  return (
    <section className={PART} aria-labelledby="push-and-installed-app">
      <h4 id="push-and-installed-app" className="font-semibold">
        Push and the installed app
      </h4>
      <p className="mt-0.5 text-small text-muted">{PLAIN_HTTP_NOTE}</p>
    </section>
  );
}
