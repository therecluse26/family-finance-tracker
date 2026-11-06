import { describe, expect, it } from "vitest";
import { deviceName, UNKNOWN_BROWSER } from "./device-names.ts";

// Spec 09, Signed-in devices: the short name each row shows, from the user agent of the sign-in.

describe("deviceName", () => {
  it.each([
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Firefox on Windows",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "Safari on iPad",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0",
      "Opera on Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      "Samsung Internet on Android",
    ],
    ["Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0", "Firefox on Android"],
    [
      "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0",
      "Edge on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
      "Chrome on iPhone",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
      "Firefox on iPhone",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/131.0.2903.92 Mobile/15E148 Safari/605.1.15",
      "Edge on iPhone",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on Linux",
    ],
  ])("names %s", (userAgent, name) => {
    expect(deviceName(userAgent)).toBe(name);
  });

  it("leaves out the part it cannot tell", () => {
    expect(deviceName("Firefox/133.0")).toBe("Firefox");
    expect(deviceName("curl/8.10.1 (Linux)")).toBe("Unknown browser on Linux");
    expect(deviceName("curl/8.10.1")).toBe(UNKNOWN_BROWSER);
    expect(deviceName("Mozilla/5.0 (compatible; MSIE 10.0; Trident/6.0)")).toBe(UNKNOWN_BROWSER);
  });

  it("says Unknown browser for no user agent", () => {
    expect(deviceName("")).toBe(UNKNOWN_BROWSER);
    expect(deviceName(null)).toBe(UNKNOWN_BROWSER);
    expect(deviceName(undefined)).toBe(UNKNOWN_BROWSER);
    expect(deviceName("   ")).toBe(UNKNOWN_BROWSER);
  });

  it("does not take a word inside another word, or a browser name with no version", () => {
    expect(deviceName("NotFirefox/1.0 Chromebook")).toBe(UNKNOWN_BROWSER);
    expect(deviceName("Safari/604.1")).toBe(UNKNOWN_BROWSER);
    expect(deviceName("Firefox")).toBe(UNKNOWN_BROWSER);
  });

  it("returns only its own words for a hostile user agent", () => {
    const names = [
      deviceName('<script>alert("x")</script> Firefox/1.0 (Windows)'),
      deviceName("Firefox/1.0\u0000\u001b[31m\r\nSet-Cookie: a=b (Linux)"),
      deviceName("‮Firefox/1.0 ​(Linux) <img src=x onerror=alert(1)>"),
      deviceName(`${"(".repeat(10_000)}Firefox/1.0`),
    ];

    expect(names).toEqual([
      "Firefox on Windows",
      "Firefox on Linux",
      "Firefox on Linux",
      UNKNOWN_BROWSER,
    ]);
    const allowed = /^[A-Za-z ]+$/;
    for (const name of names) expect(name).toMatch(allowed);
  });

  it("reads only the start of a very long user agent, quickly", () => {
    const long = `Mozilla/5.0 (X11; Linux x86_64) ${"Version/1.1 ".repeat(100_000)}Safari/1`;
    const started = performance.now();

    const name = deviceName(long);

    expect(performance.now() - started).toBeLessThan(200);
    expect(name).toBe("Unknown browser on Linux");
    expect(deviceName(`${"x".repeat(600)} Firefox/1.0`)).toBe(UNKNOWN_BROWSER);
  });
});
