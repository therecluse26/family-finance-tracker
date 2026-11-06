import type { DeviceOwner, PushSubscriptionFields } from "../notify/push-view.ts";
import { api } from "./api.ts";

// Settings, Alerts: push on this device (spec 06, Recipients and channels). Push on a device
// belongs to the one Member who turned it on. When another Member uses that browser, nothing they
// do ends the first Member's push. It holds no JSX, so the server's tests run it against the app.

// The page's requests, exactly as it sends them. Each sends a JSON body: the server answers 415 to
// a write without one. The endpoint goes in the body, never in the URL.
export const addDevice = (json: PushSubscriptionFields) => api.push.devices.$post({ json });
export const removeDevice = (endpoint: string) => api.push.devices.$delete({ json: { endpoint } });
export const askDeviceOwner = (endpoint: string) =>
  api.push.devices.owner.$post({ json: { endpoint } });

// The words to show for a refused request: the server's own.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// The browser's push subscription, as the page uses it.
export type DeviceSubscription = {
  endpoint: string;
  toJSON(): { keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
};
export type BrowserPush = {
  // This browser's subscription, or null when it has none.
  current(): Promise<DeviceSubscription | null>;
  subscribe(): Promise<DeviceSubscription>;
};

// "another Member": this browser's push is another Member's, and nothing on the page ends it.
export type DeviceState = "checking" | "on" | "off" | "another Member" | "not supported";

// Whether this browser's push is on, and for whom. The server knows whose device it is.
export async function deviceState(browser: BrowserPush): Promise<DeviceState> {
  const subscription = await browser.current();
  if (subscription === null) return "off";
  const res = await askDeviceOwner(subscription.endpoint);
  if (!res.ok) return "off";
  const { owner } = (await res.json()) as { owner: DeviceOwner };
  return owner === "this Member" ? "on" : owner === "another Member" ? "another Member" : "off";
}

export type DeviceChange = { state: DeviceState; error?: string };

// "Turn on Alerts on this device". A refused subscription is dropped only when this press made
// it: one the browser already had may be another Member's push.
export async function turnOnDevice(browser: BrowserPush): Promise<DeviceChange> {
  const had = await browser.current();
  const subscription = had ?? (await browser.subscribe());
  const { keys } = subscription.toJSON();
  const res = await addDevice({
    endpoint: subscription.endpoint,
    keys: { p256dh: keys?.p256dh ?? "", auth: keys?.auth ?? "" },
  });
  if (res.ok) return { state: "on" };
  const error = await refusal(res);
  if (had === null) {
    await subscription.unsubscribe();
    return { state: "off", error };
  }
  return { state: await deviceState(browser), error };
}

// "Turn off Alerts on this device". The browser drops its subscription only when the server
// removed this Member's own device.
export async function turnOffDevice(browser: BrowserPush): Promise<DeviceChange> {
  const subscription = await browser.current();
  if (subscription === null) return { state: "off" };
  const res = await removeDevice(subscription.endpoint);
  if (!res.ok) return { state: "on", error: await refusal(res) };
  const { removed } = (await res.json()) as { removed: boolean };
  if (!removed) return { state: await deviceState(browser) };
  await subscription.unsubscribe();
  return { state: "off" };
}
