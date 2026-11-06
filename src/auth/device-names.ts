// Spec 09, Signed-in devices: a short browser and system name, such as "Firefox on Linux", from the
// user agent a browser sent at sign-in. The name is made only of the words below, so no part of
// the user agent itself, such as markup or a control character, ever reaches the page.

export const UNKNOWN_BROWSER = "Unknown browser";

// A user agent longer than this is read only this far. Real ones are under 400 characters.
const READ_LENGTH = 512;

// The first match wins, so a browser built on another comes before it: Edge, Opera, and Samsung
// Internet each name Chrome too, and Chrome names Safari. The iOS forms name their own browser
// apart from Safari.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|OPiOS|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// iPhone and iPad name "Mac OS X", Android and ChromeOS name Linux, so each comes before it.
const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const firstMatch = (text: string, list: [RegExp, string][]) =>
  list.find(([pattern]) => pattern.test(text))?.[1];

// "Firefox on Linux", "Firefox" when the system is unknown, "Unknown browser on Linux" when the
// browser is, and "Unknown browser" when neither is known or there is no user agent.
export function deviceName(userAgent: string | null | undefined): string {
  if (typeof userAgent !== "string") return UNKNOWN_BROWSER;
  const text = userAgent.slice(0, READ_LENGTH);
  const browser = firstMatch(text, BROWSERS);
  const system = firstMatch(text, SYSTEMS);
  if (system === undefined) return browser ?? UNKNOWN_BROWSER;
  return `${browser ?? UNKNOWN_BROWSER} on ${system}`;
}
