import { parse as legacyParse } from "node:url";
import { describe, expect, it } from "vitest";
import { isPushServiceEndpoint } from "./index.ts";

// The push service check (spec 09, Security mode): the app stores and sends to an endpoint only
// when it names a push service, read the same way by the URL parser and by web-push's older
// url.parse, which is what sends. Endpoints are made from pieces a hostile browser could post.

const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SERVICE_DOMAINS = [".push.apple.com", ".notify.windows.com"];

const isPushServiceHost = (host: string | null) =>
  host !== null &&
  (PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_DOMAINS.some((domain) => host.endsWith(domain)));

// A small seeded generator, so a failure names an endpoint that comes back on the next run.
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  return <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
}

const HOST_PIECES = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "wns2-by3p.notify.windows.com",
  ".push.apple.com",
  ".notify.windows.com",
  "169.254.169.254",
  "internal-nas",
  "nas.local",
  "evil.test",
  "x",
  "FCM",
  "127.0.0.1",
  "[::1]",
  ".",
  "..",
  ";",
  "{",
  "}",
  "'",
  '"',
  "`",
  "%2e",
  "%2E",
  "%40",
  "%3b",
  "．",
  "。",
  "\t",
  "\n",
  " ",
  "@",
  ":",
  ":443",
  ":8443",
  "\\",
  "/",
  "#",
  "?",
  "*",
  "|",
  "^",
  "<",
  ">",
  "user@",
  "a:b@",
];
const SERVICE_ENDINGS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
  "x.push.apple.com",
  "x.notify.windows.com",
];
const PATHS = ["/fcm/send/abc", "/wpush/v2/abc", "/3/device/abc", "/", "", "?x=1", "#y", "/a;b"];

describe("the push service check", () => {
  it("accepts a real browser's endpoint at each push service", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bH",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-by3p.notify.windows.com/w/?token=BQYAAAB",
    ]) {
      expect(isPushServiceEndpoint(endpoint)).toBe(true);
    }
  });

  it("accepts an endpoint only when both URL parsers send it to the same push service", () => {
    const pick = generator(63);
    let accepted = 0;
    for (let made = 0; made < 20_000; made += 1) {
      // Up to 3 pieces of anything, then most often a push service's name, as an attacker writes
      // an endpoint the check might take for one.
      const pieces = [
        ...Array.from({ length: made % 4 }, () => pick(HOST_PIECES)),
        pick([...SERVICE_ENDINGS, ...SERVICE_ENDINGS, ...HOST_PIECES]),
      ];
      const endpoint = `${pick(["https://", "https://", "http://", "HTTPS://", " https://", "https:/"])}${pieces.join("")}${pick(PATHS)}`;
      if (!isPushServiceEndpoint(endpoint)) continue;
      accepted += 1;
      const url = new URL(endpoint);
      const sent = legacyParse(endpoint);
      expect({ endpoint, host: sent.hostname, port: sent.port }).toEqual({
        endpoint: url.href,
        host: url.hostname,
        port: null,
      });
      expect(isPushServiceHost(sent.hostname)).toBe(true);
      expect(sent.protocol).toBe("https:");
    }
    // The generator makes enough endpoints the check accepts for the test to mean something.
    expect(accepted).toBeGreaterThan(150);
  });
});
