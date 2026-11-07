import { renderToString } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import type { DeviceView } from "../../../server/devices-views.ts";
import { ConfirmNewTotp, DeviceRows, signedInLine } from "./MyLogin.tsx";

// Settings, My login after "Move to a new phone": the new TOTP as a QR code drawn on the page, and the
// field for its first code (spec 09, Members). src/web/components/Fields.test.tsx checks the drawing.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// A made-up TOTP secret, new on each run, in an otpauth:// link of the form Better Auth makes.
function madeUpTotp() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (byte) => BASE32[byte % 32]).join("");
  const totpURI = `otpauth://totp/Family%20Finance%20Tracker:member%40example.test?secret=${secret}&issuer=Family+Finance+Tracker&digits=6&period=30`;
  return { secret, totpURI };
}

describe("Settings, My login, the new TOTP step", () => {
  it("shows the QR code of the new otpauth link, the secret, and the field for its first code", () => {
    const { secret, totpURI } = madeUpTotp();
    const html = renderToString(
      <ConfirmNewTotp
        totpURI={totpURI}
        code=""
        onCodeChange={() => {}}
        busy={false}
        onSubmit={() => {}}
      />,
    );
    const { size, data } = encode(totpURI, { border: 4 });

    expect(html).toContain('role="img" aria-label="QR code for your authenticator app"');
    expect(html).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(html.match(/h1v1h-1z/g)?.length).toBe(data.flat().filter(Boolean).length);
    expect(html).toContain(secret);
    expect(html).toContain("The 6-digit code the new TOTP shows");
    expect(html).toContain("Use the new TOTP");
    expect(html).not.toMatch(/<img|https?:\/\//);
  });
});

describe("Settings, My login, Signed-in devices", () => {
  const NOW = new Date("2026-11-06T19:00:00.000Z");
  const DEVICES: DeviceView[] = [
    {
      id: "a1",
      name: "Firefox on Linux",
      signedInAt: "2026-11-06T14:30:00.000Z",
      thisDevice: true,
    },
    {
      id: "b2",
      name: "Safari on iPhone",
      signedInAt: "2026-11-03T00:14:00.000Z",
      thisDevice: false,
    },
  ];

  it("writes the sign-in time in the Household time zone, with the year only for another year", () => {
    expect(signedInLine("2026-11-06T14:30:00.000Z", "America/New_York", NOW)).toBe(
      "Signed in Nov 6, 9:30 AM",
    );
    expect(signedInLine("2026-11-03T00:14:00.000Z", "America/New_York", NOW)).toBe(
      "Signed in Nov 2, 7:14 PM",
    );
    expect(signedInLine("2026-11-03T00:14:00.000Z", "America/Los_Angeles", NOW)).toBe(
      "Signed in Nov 2, 4:14 PM",
    );
    expect(signedInLine("2025-12-31T23:00:00.000Z", "America/New_York", NOW)).toBe(
      "Signed in Dec 31, 2025, 6:00 PM",
    );
  });

  it("shows each device's name, this device with its icon and word, the sign-in time, and Sign out", () => {
    const html = renderToString(
      <DeviceRows
        devices={DEVICES}
        zone="America/New_York"
        now={NOW}
        busy={false}
        onSignOut={() => {}}
      />,
    );
    const rows = html.split("<li").slice(1);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Firefox on Linux");
    expect(rows[0]).toMatch(/text-good"><span aria-hidden="true">✓ <\/span>this device/);
    expect(rows[0]).toContain("Signed in Nov 6, 9:30 AM");
    expect(rows[0]).toContain('aria-label="Sign out this device"');
    expect(rows[1]).toContain("Safari on iPhone");
    expect(rows[1]).not.toContain("this device");
    expect(rows[1]).toContain("Signed in Nov 2, 7:14 PM");
    expect(rows[1]).toContain('aria-label="Sign out Safari on iPhone"');
    expect(html.match(/>Sign out<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("a1");
  });
});
