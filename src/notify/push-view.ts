// Web push, as Settings → Alerts sees it (spec 06, Recipients and channels; spec 09, Security
// mode). The VAPID private key is never in it. This file imports nothing, so the web app's type
// check can follow it.

// Why push is not offered: plain-HTTP mode, where email is the only channel; or the first-run
// wizard's step 3 is not done, so the app has made no VAPID keys yet.
export type PushOff = "plain HTTP" | "setup not done";

// Over HTTPS, the VAPID public key, which a browser needs to turn Alerts on.
export type PushView = { available: true; publicKey: string } | { available: false; why: PushOff };

// A browser's push subscription, as PushSubscription.toJSON() gives it.
export type PushSubscriptionFields = { endpoint: string; keys: { p256dh: string; auth: string } };

// Why a device was not turned on: push is not offered; the subscription's endpoint is not one of
// the push services the app sends to; or the device is already on for another Member, who must
// turn it off first.
export type DeviceRefusal = PushOff | "unknown push service" | "another Member's device";

export type DeviceAdd = { added: true } | { added: false; refusal: DeviceRefusal };

export type PushSettings = {
  view(): Promise<PushView>;
  // Turns Alerts on for the signed-in Member's device.
  addDevice(memberId: string, subscription: PushSubscriptionFields): Promise<DeviceAdd>;
  // Turns Alerts off for one of the signed-in Member's own devices. False when they have none at
  // this endpoint.
  removeDevice(memberId: string, endpoint: string): Promise<boolean>;
};
