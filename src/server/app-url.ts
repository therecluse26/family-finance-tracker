// This file imports nothing from Node, so the web app's type check can follow it through api.ts.
import { type IpRange, inIpRange, parseIp, parseIpRange } from "./ip-address.ts";

export type SecurityMode = "https" | "http";

// The one reader of APP_URL. The server reads the mode here, the web app gets it from
// GET /api/security-mode, and every absolute address the app makes comes from address().
export type AppUrl = {
  readonly mode: SecurityMode;
  // Scheme, host, and port with no trailing slash, such as "http://192.168.1.20:3000".
  readonly origin: string;
  // Host and port as a browser sends them in Host, such as "192.168.1.20:3000".
  readonly host: string;
  // The absolute address of a path in the app, such as address("/setup").
  address(path: string): string;
};

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DNS_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u;

// The local hosts in docs/spec/09-members-login-security.md, "Security mode".
const LOCAL_RANGES = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map((cidr): IpRange => {
  const range = parseIpRange(cidr);
  if (range === undefined) throw new Error(`${cidr} is not a range.`);
  return range;
});
const LOCAL_NAME_ENDINGS = [".local", ".lan", ".home.arpa", ".internal"];

// Takes a hostname as the URL parser writes it: lowercase, IPv4 dotted, IPv6 in brackets.
// The parser first turns IPv4 forms such as 0x7f.1 into dotted form.
function isLocalHost(hostname: string): boolean {
  const bracketed = hostname.startsWith("[");
  const address = parseIp(bracketed ? hostname.slice(1, -1) : hostname);
  if (address === undefined) {
    return hostname === "localhost" || LOCAL_NAME_ENDINGS.some((end) => hostname.endsWith(end));
  }
  // IPv4-mapped IPv6 reads as IPv4, but the spec lists no mapped range.
  if (bracketed && address.family === 4) return false;
  return LOCAL_RANGES.some((range) => inIpRange(address, range));
}

function isValidHost(hostname: string): boolean {
  return hostname.startsWith("[") || parseIp(hostname) !== undefined || DNS_NAME.test(hostname);
}

// Throws with the reason when APP_URL cannot set a security mode. No message repeats the
// whole value, which could hold a password.
export function parseAppUrl(value: string | undefined): AppUrl {
  const text = value?.trim() ?? "";
  if (text === "") {
    throw new Error(
      "APP_URL is missing. Set it in .env to the address Members open, such as https://money.example.com or http://192.168.1.20:3000.",
    );
  }
  const scheme = /^(https?):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    throw new Error("APP_URL must start with https:// or http://.");
  }
  if (SPACE_OR_CONTROL.test(text) || text.includes("\\") || !URL.canParse(text)) {
    throw new Error("APP_URL is not a valid address.");
  }
  const url = new URL(text);
  if (url.username !== "" || url.password !== "") {
    throw new Error("APP_URL must not hold a name or password before its host.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      "APP_URL must hold only a scheme, a host, and an optional port, such as https://money.example.com.",
    );
  }
  if (!isValidHost(url.hostname)) {
    throw new Error("APP_URL's host is not a valid name or IP address.");
  }
  if (scheme === "http" && !isLocalHost(url.hostname)) {
    throw new Error(
      `APP_URL is http://, so its host must be a local address, localhost, or a name that ends in .local, .lan, .home.arpa, or .internal, not "${url.hostname}". Use https:// for any other address.`,
    );
  }

  const origin = url.origin;
  return {
    mode: scheme === "https" ? "https" : "http",
    origin,
    host: url.host,
    address(path) {
      // The message leaves out the path, which can hold a setup code or a token.
      const refused = new Error("An app address needs a path that starts with a single /.");
      if (!/^\/(?![/\\])/.test(path) || path.includes("\\") || SPACE_OR_CONTROL.test(path)) {
        throw refused;
      }
      const address = new URL(path, origin);
      if (address.origin !== origin) throw refused;
      return address.href;
    },
  };
}
