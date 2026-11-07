import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDevice, askDeviceOwner, removeDevice } from "../../push-device.ts";
import { ChannelsForm } from "./AlertEmail.tsx";
import {
  AlertPush,
  ANOTHER_MEMBERS_PUSH,
  DevicePush,
  HOME_SCREEN_NOTE,
  keyBytes,
  needsHomeScreen,
  PLAIN_HTTP_NOTE,
  PushPart,
} from "./AlertPush.tsx";

// Settings, Alerts: push on this device, as the browser first paints it, in HTTPS mode and in
// plain-HTTP mode.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const labels = (html: string) =>
  [...html.matchAll(/<label[^>]*><input type="radio"[^>]*?\/>([^<]+)/g)].map((match) => match[1]);
const PUBLIC_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");

describe("Settings, Alerts: push on this device", () => {
  it('offers "Turn on Alerts on this device" over HTTPS', () => {
    const html = renderToString(<AlertPush push={{ available: true, publicKey: PUBLIC_KEY }} />);

    expect(text(html)).toContain("Turn on Alerts on this device");
    expect(text(html)).toContain("They wait from 9 PM to 8 AM, Household time.");
    expect(text(html)).not.toContain(PLAIN_HTTP_NOTE);
  });

  it("offers to turn Alerts off on a device where they are on", () => {
    const html = renderToString(<DevicePush publicKey={PUBLIC_KEY} initial="on" />);

    expect(text(html)).toContain("Alerts are on for this device.");
    expect(text(html)).toContain("Turn off Alerts on this device");
    expect(text(html)).not.toContain("Turn on Alerts on this device");
  });

  it("says push on a shared browser is another Member's, and offers nothing that could end it", () => {
    const html = renderToString(<DevicePush publicKey={PUBLIC_KEY} initial="another Member" />);

    expect(text(html)).toContain("Push on this device is on for another Member.");
    expect(text(html)).toContain(ANOTHER_MEMBERS_PUSH);
    expect(html).not.toContain("<button");
    expect(text(html)).not.toContain("Alerts are on for this device.");
  });

  it("hides push in plain-HTTP mode, with a note that says why", () => {
    const html = renderToString(<AlertPush push={{ available: false, why: "plain HTTP" }} />);

    expect(text(html)).not.toContain("Turn on Alerts on this device");
    expect(text(html)).toContain(PLAIN_HTTP_NOTE);
    expect(PLAIN_HTTP_NOTE).toContain("Push and installing the app need HTTPS.");
    expect(PLAIN_HTTP_NOTE).toContain("come by email only");
  });

  it("shows nothing before the first-run wizard's step 3 is done", () => {
    expect(renderToString(<AlertPush push={{ available: false, why: "setup not done" }} />)).toBe(
      "",
    );
  });

  it("offers email as the only channel in plain-HTTP mode", () => {
    const paint = (pushOffered: boolean) =>
      renderToString(
        <ChannelsForm
          channels={{ push: true, email: true, emailSetUp: true }}
          pushOffered={pushOffered}
          onSaved={() => {}}
        />,
      );

    expect(labels(paint(false))).toEqual(["Email", "None"]);
    expect(paint(false)).toMatch(/checked=""[^>]*\/>Email</);
    expect(text(paint(false))).not.toContain("Push");
    expect(labels(paint(true))).toEqual(["Push and email", "Push only", "Email only", "None"]);
    expect(text(paint(true))).toContain("Push waits from 9 PM to 8 AM, Household time.");
  });

  it("reads the VAPID public key from base64url", () => {
    expect([...keyBytes(PUBLIC_KEY)]).toEqual(new Array(65).fill(4));
    expect([...keyBytes("_-8")]).toEqual([0xff, 0xef]);
  });
});

describe("Settings, Alerts: push requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each write as JSON", async () => {
    const sent: { method: string; contentType: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), "https://money.example.com"), init);
      sent.push({
        method: request.method,
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      });
      return new Response("{}");
    });
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: PUBLIC_KEY, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
    };

    await addDevice(subscription);
    await removeDevice(subscription.endpoint);
    await askDeviceOwner(subscription.endpoint);

    expect(sent).toEqual([
      { method: "POST", contentType: "application/json", body: JSON.stringify(subscription) },
      {
        method: "DELETE",
        contentType: "application/json",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      },
      {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      },
    ]);
  });
});

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const TURN_ON = "Turn on Alerts on this device";

describe("Settings, Alerts: Add to Home Screen", () => {
  const HTTPS_PUSH = { available: true, publicKey: PUBLIC_KEY } as const;
  const PLAIN_HTTP = { available: false, why: "plain HTTP" } as const;

  it("explains Add to Home Screen first on an iPhone", () => {
    const html = text(renderToString(<PushPart push={HTTPS_PUSH} homeScreenFirst={true} />));

    expect(html).toContain(HOME_SCREEN_NOTE);
    expect(html.indexOf("Add to Home Screen")).toBeLessThan(html.indexOf(TURN_ON));
  });

  it("gives no such note elsewhere, nor in plain-HTTP mode", () => {
    const https = text(renderToString(<PushPart push={HTTPS_PUSH} homeScreenFirst={false} />));
    expect(https).toContain(TURN_ON);
    expect(https).not.toContain("Add to Home Screen");

    for (const homeScreenFirst of [false, true]) {
      const html = text(
        renderToString(<PushPart push={PLAIN_HTTP} homeScreenFirst={homeScreenFirst} />),
      );
      expect(html).toContain(PLAIN_HTTP_NOTE);
      expect(html).not.toContain(TURN_ON);
      expect(html).not.toContain("Add to Home Screen");
    }
  });

  it("knows an iPhone outside the installed app", () => {
    expect(needsHomeScreen(IPHONE, false)).toBe(true);
    // The app opened from the Home Screen gets pushes already.
    expect(needsHomeScreen(IPHONE, true)).toBe(false);
    expect(needsHomeScreen(ANDROID, false)).toBe(false);
    expect(needsHomeScreen(IPAD, false)).toBe(false);
  });
});
