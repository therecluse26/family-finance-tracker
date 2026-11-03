import { describe, expect, it } from "vitest";
import { parseAppUrl } from "./app-url.ts";

// The first and last address of each local range, and the addresses just outside it.
const LOCAL_RANGES: [range: string, inside: string[], outside: string[]][] = [
  ["127.0.0.0/8", ["127.0.0.0", "127.0.0.1", "127.255.255.255"], ["126.255.255.255", "128.0.0.0"]],
  ["10.0.0.0/8", ["10.0.0.0", "10.255.255.255"], ["9.255.255.255", "11.0.0.0"]],
  [
    "172.16.0.0/12",
    ["172.16.0.0", "172.31.255.255"],
    ["172.15.255.255", "172.32.0.0", "172.32.0.1"],
  ],
  ["192.168.0.0/16", ["192.168.0.0", "192.168.255.255"], ["192.167.255.255", "192.169.0.0"]],
  [
    "100.64.0.0/10",
    ["100.64.0.0", "100.127.255.255"],
    ["100.63.255.255", "100.128.0.0", "100.128.0.1"],
  ],
  ["::1", ["[::1]", "[0:0:0:0:0:0:0:1]"], ["[::]", "[::2]"]],
  [
    "fc00::/7",
    ["[fc00::]", "[fd12:3456::1]", "[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]"],
    ["[fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "[fe00::]"],
  ],
  [
    "fe80::/10",
    ["[fe80::]", "[fe80::1]", "[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]"],
    ["[fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "[fec0::]"],
  ],
];

const LOCAL_NAMES = [
  "localhost",
  "LOCALHOST",
  "nas.local",
  "NAS.Local",
  "router.lan",
  "printer.home.arpa",
  "box.internal",
  "a.b.c.local",
];

const PUBLIC_HOSTS = [
  "0.0.0.0",
  "8.8.8.8",
  "169.254.1.1",
  "203.0.113.5",
  "[2001:db8::1]",
  // IPv4-mapped IPv6 is not in the list, even for a local IPv4 address.
  "[::ffff:192.168.1.1]",
  "[::ffff:127.0.0.1]",
  "example.com",
  "money.example.com",
  "localhost.example.com",
  "app.localhost",
  "local",
  "lan",
  "home.arpa",
  "internal",
  "nas.local.example.com",
  "nas-local",
  "nas.locals",
  "nas.lan.com",
];

const appUrl = (value: string) => parseAppUrl(value);

describe("parseAppUrl: local hosts in plain-HTTP mode", () => {
  for (const [range, inside, outside] of LOCAL_RANGES) {
    it.each(inside)(`accepts %s, inside ${range}`, (host) => {
      expect(appUrl(`http://${host}:3000`).mode).toBe("http");
    });

    it.each(outside)(`refuses %s, outside ${range}`, (host) => {
      expect(() => appUrl(`http://${host}:3000`)).toThrow(/APP_URL is http:\/\/, so its host must/);
    });
  }

  it.each(LOCAL_NAMES)("accepts the name %s", (host) => {
    expect(appUrl(`http://${host}`).mode).toBe("http");
  });

  it.each(PUBLIC_HOSTS)("refuses %s", (host) => {
    expect(() => appUrl(`http://${host}`)).toThrow(/APP_URL is http:\/\/, so its host must/);
  });

  it.each([
    ["0x7f.1", "127.0.0.1"],
    ["3232235777", "192.168.1.1"],
    ["0300.0250.0.1", "192.168.0.1"],
  ])("reads %s as the address %s", (host, address) => {
    expect(appUrl(`http://${host}:3000`).host).toBe(`${address}:3000`);
  });

  it("refuses 172.32.0.1 written in another form", () => {
    expect(() => appUrl("http://0xac200001")).toThrow(/must be a local address/);
  });

  it("names the refused host and the way out", () => {
    expect(() => appUrl("http://money.example.com")).toThrow(
      'not "money.example.com". Use https:// for any other address.',
    );
  });
});

describe("parseAppUrl: start failures", () => {
  it.each([undefined, "", "   "])("refuses a missing APP_URL (%j)", (value) => {
    expect(() => parseAppUrl(value)).toThrow(/^APP_URL is missing\. Set it in \.env/);
  });

  it.each([
    "ftp://nas.local",
    "ws://localhost:3000",
    "file:///data/app.db",
    "javascript:alert(1)",
    "localhost:3000",
    "192.168.1.20:3000",
    "//nas.local",
    "http:/nas.local",
    "http:nas.local",
    "http:\\\\nas.local",
    "nas.local",
  ])("refuses %s, which is not https:// or http://", (value) => {
    expect(() => parseAppUrl(value)).toThrow("APP_URL must start with https:// or http://.");
  });

  it.each([
    "http://",
    "https://",
    "http://loc\talhost",
    "http://local host",
    "http://nas.local\\@example.com",
    "http://[fe80::1%25eth0]:3000",
    "http://nas.local:99999",
  ])("refuses %j as not a valid address", (value) => {
    expect(() => parseAppUrl(value)).toThrow("APP_URL is not a valid address.");
  });

  it.each(['http://a"b.local', "http://a_b.local", "http://nas.local.", "http://-nas.local"])(
    "refuses the host in %s",
    (value) => {
      expect(() => parseAppUrl(value)).toThrow("APP_URL's host is not a valid name or IP address.");
    },
  );

  it.each([
    "https://money.example.com/app",
    "https://money.example.com/?next=/",
    "https://money.example.com/#top",
    "http://nas.local:3000/setup",
  ])("refuses %s, which has more than a scheme, host, and port", (value) => {
    expect(() => parseAppUrl(value)).toThrow(/APP_URL must hold only a scheme, a host/);
  });

  it("refuses a name or password before the host and does not repeat it", () => {
    let message = "";
    try {
      parseAppUrl("https://member:hunter2-secret@money.example.com");
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("APP_URL must not hold a name or password before its host.");
    expect(message).not.toContain("hunter2");
  });
});

describe("parseAppUrl: the result", () => {
  it("sets HTTPS mode for any https:// host", () => {
    for (const value of [
      "https://money.example.com",
      "https://203.0.113.5",
      "https://localhost",
      "https://box.tail1234.ts.net",
    ]) {
      expect(parseAppUrl(value).mode).toBe("https");
    }
  });

  it("keeps the scheme, host, and port in one spelling", () => {
    const url = parseAppUrl("  HTTPS://Money.Example.com:8443/  ");

    expect(url).toMatchObject({
      mode: "https",
      origin: "https://money.example.com:8443",
      host: "money.example.com:8443",
    });
  });

  it("drops a default port", () => {
    expect(parseAppUrl("http://nas.local:80/")).toMatchObject({
      origin: "http://nas.local",
      host: "nas.local",
    });
    expect(parseAppUrl("https://money.example.com:443").host).toBe("money.example.com");
  });

  it("writes IPv6 hosts in brackets", () => {
    expect(parseAppUrl("http://[FD00:0:0::1]:3000")).toMatchObject({
      origin: "http://[fd00::1]:3000",
      host: "[fd00::1]:3000",
    });
  });
});

describe("AppUrl.address", () => {
  const https = parseAppUrl("https://money.example.com");
  const http = parseAppUrl("http://192.168.1.20:3000/");

  it("starts every address with APP_URL", () => {
    expect(https.address("/")).toBe("https://money.example.com/");
    expect(https.address("/setup#code=7KQ2-M9XD-4TRF")).toBe(
      "https://money.example.com/setup#code=7KQ2-M9XD-4TRF",
    );
    expect(http.address("/join#token=abc")).toBe("http://192.168.1.20:3000/join#token=abc");
    expect(http.address("/settings/backups?tab=1")).toBe(
      "http://192.168.1.20:3000/settings/backups?tab=1",
    );
  });

  it.each([
    "",
    "setup",
    "//evil.example/setup",
    "/\\evil.example/setup",
    "\\\\evil.example",
    "/\t/evil.example",
    "https://evil.example/setup",
    "javascript:alert(1)",
    " /setup",
  ])("refuses %j, which does not start with a single /", (path) => {
    expect(() => https.address(path)).toThrow(
      "An app address needs a path that starts with a single /.",
    );
  });

  it("never repeats the path, which can hold a token", () => {
    expect(() => https.address("join#token=SECRET-TOKEN")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("SECRET-TOKEN") }),
    );
  });
});
