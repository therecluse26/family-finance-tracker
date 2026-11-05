import { useEffect, useState } from "react";
import type { PushSubscriptionFields, PushView } from "../../../notify/push-view.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine } from "../../components/Fields.tsx";
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
    <section className="mt-6">
      <h3 className="font-semibold">Push on this device</h3>
      <p className="mt-1 text-gray-600">
        Pushes show each Alert's kind and its text. They wait from 9 PM to 8 AM, Household time.
        Turn Alerts on for each device you want them on.
      </p>
      {state === "not supported" ? (
        <p className="mt-2">This browser cannot get pushes.</p>
      ) : state === "on" ? (
        <>
          <p className="mt-2">Alerts are on for this device.</p>
          <button className={BUTTON} type="button" disabled={busy} onClick={turnOff}>
            Turn off Alerts on this device
          </button>
        </>
      ) : (
        <button
          className={BUTTON}
          type="button"
          disabled={busy || state === "checking"}
          onClick={turnOn}
        >
          Turn on Alerts on this device
        </button>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

export function AlertPush(props: { push: PushView }) {
  const { push } = props;
  if (push.available) return <DevicePush publicKey={push.publicKey} />;
  if (push.why === "setup not done") return null;
  return (
    <section className="mt-6">
      <h3 className="font-semibold">Push and the installed app</h3>
      <p className="mt-1 text-gray-600">{PLAIN_HTTP_NOTE}</p>
    </section>
  );
}
