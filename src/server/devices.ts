import type { Auth } from "../auth/index.ts";
import type { DeviceRoutes } from "./devices-views.ts";

// Settings, My login, Signed-in devices (spec 09): the signed-in Member's own sessions, and Sign
// out on one of them or on every other one. The auth module reads and ends the sessions.
export function deviceRoutes(auth: Auth): DeviceRoutes {
  return {
    async devices(memberId, sessionId) {
      const devices = await auth.signedInDevices(memberId, sessionId, new Date());
      return devices.map((device) => ({
        id: device.id,
        name: device.name,
        signedInAt: device.signedInAt.toISOString(),
        thisDevice: device.thisDevice,
      }));
    },
    signOut: (memberId, sessionId, deviceId) =>
      auth.signOutDevice(memberId, sessionId, deviceId, new Date()),
    signOutOthers: (memberId, sessionId) => auth.signOutOtherDevices(memberId, sessionId),
  };
}
