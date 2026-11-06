import { useEffect, useState } from "react";
import type { PushView } from "../../../notify/push-view.ts";
import { BUTTON, ErrorLine } from "../../components/Fields.tsx";
import { SERVICE_WORKER } from "../../install.ts";
import {
  type BrowserPush,
  type DeviceChange,
  type DeviceState,
  deviceState,
  turnOffDevice,
  turnOnDevice,
} from "../../push-device.ts";

// Settings, Alerts: push on this device (spec 06, Recipients and channels; spec 09, Security mode).
// Each Member turns Alerts on for each of their devices, over HTTPS only. In plain-HTTP mode push
// and the install prompt are hidden, and a note says why.

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

const browserPush = (publicKey: string): BrowserPush => ({
  current: () => currentSubscription(publicKey),
  subscribe: async () =>
    (await registration()).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }),
});

// Push on a device belongs to the one Member who turned it on (spec 06, Recipients and channels).
export const ANOTHER_MEMBERS_PUSH =
  "Push on this device is on for another Member. Only they can turn it off, in Settings, Alerts, while signed in.";

export function DevicePush(props: { publicKey: string; initial?: DeviceState }) {
  const { publicKey } = props;
  const [state, setState] = useState<DeviceState>(props.initial ?? "checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!pushSupported()) return setState("not supported");
    deviceState(browserPush(publicKey))
      .then(setState)
      .catch(() => setState("not supported"));
  }, [publicKey]);

  async function change(run: () => Promise<DeviceChange>, failed: string) {
    setBusy(true);
    setError(undefined);
    try {
      const changed = await run();
      setState(changed.state);
      setError(changed.error);
    } catch {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  const turnOn = () =>
    change(async () => {
      if ((await Notification.requestPermission()) !== "granted") {
        return {
          state: "off",
          error:
            "The browser blocks notifications for this app. Allow them in the browser's settings for this site, then try again.",
        };
      }
      return turnOnDevice(browserPush(publicKey));
    }, "Alerts did not turn on for this device.");

  const turnOff = () =>
    change(() => turnOffDevice(browserPush(publicKey)), "Alerts did not turn off for this device.");

  return (
    <section className="mt-6">
      <h3 className="font-semibold">Push on this device</h3>
      <p className="mt-1 text-gray-600">
        Pushes show each Alert's kind and its text. They wait from 9 PM to 8 AM, Household time.
        Turn Alerts on for each device you want them on.
      </p>
      {state === "not supported" ? (
        <p className="mt-2">This browser cannot get pushes.</p>
      ) : state === "another Member" ? (
        <p className="mt-2">{ANOTHER_MEMBERS_PUSH}</p>
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
