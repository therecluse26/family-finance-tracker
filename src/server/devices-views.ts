// What the Signed-in devices routes answer (spec 09, Signed-in devices). This file imports nothing,
// so the web app's type check can follow it through api.ts.

export type DeviceView = {
  // The session row's ID, which "Sign out" sends back. It is not the session token, and it signs
  // no one in.
  id: string;
  // A short browser and system name, such as "Firefox on Linux", or "Unknown browser".
  name: string;
  // When that device signed in, as an ISO 8601 time.
  signedInAt: string;
  // True for the session that asks.
  thisDevice: boolean;
};

export type DeviceSignOutResult = "signed out" | "this device" | "already signed out";

export type DeviceRoutes = {
  // The signed-in Member's own sessions that have not expired, this device first.
  devices(memberId: string, sessionId: string): Promise<DeviceView[]>;
  // "Sign out" on another device.
  signOut(memberId: string, sessionId: string, deviceId: string): Promise<DeviceSignOutResult>;
  // "Sign out everywhere else".
  signOutOthers(memberId: string, sessionId: string): Promise<void>;
};
