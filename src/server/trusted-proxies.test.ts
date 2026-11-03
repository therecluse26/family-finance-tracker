import { lookup as dnsLookup } from "node:dns/promises";
import { describe, expect, it } from "vitest";
import { createLogger } from "../log.ts";
import { type Lookup, parseTrustedProxies } from "./trusted-proxies.ts";

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
  return { logger, logged: () => lines.map((line) => JSON.parse(line)) };
}

// A DNS stand-in whose answers a test can change.
function fakeDns(records: Record<string, string[]>) {
  const lookup: Lookup = async (name) => {
    const found = records[name];
    if (found === undefined)
      throw Object.assign(new Error(`${name} not found`), { code: "ENOTFOUND" });
    return found;
  };
  return { records, lookup };
}

const proxies = (value: string | undefined, lookup?: Lookup) =>
  parseTrustedProxies(value, { lookup, logger: captureLogger().logger });

describe("parseTrustedProxies: the list", () => {
  it.each([undefined, "", " , ,"])("trusts no source when TRUSTED_PROXIES is %j", (value) => {
    const trusted = proxies(value);

    expect(trusted.entries).toEqual([]);
    for (const source of ["127.0.0.1", "::1", "10.0.0.1", "172.17.0.1"]) {
      expect(trusted.trusts(source)).toBe(false);
    }
  });

  it.each([
    "10.0.0.300",
    "10.0.0",
    "10.0.0.0/33",
    "::/129",
    "10.0.0.0/",
    "/8",
    "10.0.0.0/8/8",
    "10.0.0.0/08x",
    "fe80::1%eth0",
    "http://caddy",
    "caddy:80",
    "ca ddy",
    "-caddy",
    "caddy-",
    "**",
  ])("refuses the entry %j at start", (entry) => {
    expect(() => proxies(`172.18.0.2, ${entry}`)).toThrow(
      `TRUSTED_PROXIES holds "${entry}", which is not an IP address, a CIDR range, a service name, or *.`,
    );
  });

  it("trusts by IP address", () => {
    const trusted = proxies("172.18.0.2, fd00::1");

    expect(trusted.trusts("172.18.0.2")).toBe(true);
    expect(trusted.trusts("::ffff:172.18.0.2")).toBe(true);
    expect(trusted.trusts("fd00:0::1")).toBe(true);
    expect(trusted.trusts("172.18.0.3")).toBe(false);
    expect(trusted.trusts("fd00::2")).toBe(false);
  });

  it("trusts by CIDR range", () => {
    const trusted = proxies("172.16.0.0/12,fd00::/8");

    expect(trusted.trusts("172.16.0.0")).toBe(true);
    expect(trusted.trusts("172.31.255.255")).toBe(true);
    expect(trusted.trusts("::ffff:172.20.0.1")).toBe(true);
    expect(trusted.trusts("172.32.0.0")).toBe(false);
    expect(trusted.trusts("172.15.255.255")).toBe(false);
    expect(trusted.trusts("fd12::1")).toBe(true);
    expect(trusted.trusts("fe00::1")).toBe(false);
  });

  it("trusts every source with *", () => {
    const trusted = proxies("*");

    for (const source of ["203.0.113.7", "::ffff:198.51.100.1", "2001:db8::1", "127.0.0.1"]) {
      expect(trusted.trusts(source)).toBe(true);
    }
    expect(trusted.trusts("")).toBe(false);
    expect(trusted.trusts("garbage")).toBe(false);
  });

  it("trusts nothing an IPv4 entry does not name when the source is IPv6", () => {
    const trusted = proxies("0.0.0.0/0");

    expect(trusted.trusts("203.0.113.7")).toBe(true);
    expect(trusted.trusts("2001:db8::1")).toBe(false);
  });

  it("trusts no IPv4 source through an IPv6 range such as ::/0", () => {
    const trusted = proxies("::/0");

    expect(trusted.trusts("2001:db8::1")).toBe(true);
    expect(trusted.trusts("127.0.0.2")).toBe(false);
    expect(trusted.trusts("::ffff:127.0.0.2")).toBe(false);
  });

  it("tells when its ranges together trust every IPv4 or every IPv6 address", () => {
    expect(proxies("0.0.0.0/0").coversEveryAddress).toBe(true);
    expect(proxies("10.0.0.2, ::/0").coversEveryAddress).toBe(true);
    expect(proxies("0.0.0.0/1, 128.0.0.0/1").coversEveryAddress).toBe(true);
    expect(proxies("0.0.0.0/1, ::/1").coversEveryAddress).toBe(false);
    expect(proxies("10.0.0.0/8, caddy").coversEveryAddress).toBe(false);
    expect(proxies("*").coversEveryAddress).toBe(false);
  });

  it("trusts IPv4 sources through an IPv4-mapped range", () => {
    const trusted = proxies("::ffff:172.18.0.0/112, ::ffff:10.0.0.1");

    expect(trusted.trusts("172.18.5.6")).toBe(true);
    expect(trusted.trusts("::ffff:172.18.5.6")).toBe(true);
    expect(trusted.trusts("10.0.0.1")).toBe(true);
    expect(trusted.trusts("172.19.0.1")).toBe(false);
    expect(trusted.trusts("2001:db8::1")).toBe(false);
  });
});

describe("parseTrustedProxies: service names", () => {
  it("trusts a service name once it resolves, by the addresses it resolves to", async () => {
    const dns = fakeDns({ caddy: ["172.18.0.5", "fd00::5"] });
    const trusted = proxies("caddy", dns.lookup);

    expect(trusted.trusts("172.18.0.5")).toBe(false);
    await trusted.refresh();
    expect(trusted.trusts("172.18.0.5")).toBe(true);
    expect(trusted.trusts("::ffff:172.18.0.5")).toBe(true);
    expect(trusted.trusts("fd00::5")).toBe(true);
    expect(trusted.trusts("172.18.0.6")).toBe(false);
  });

  it("follows the name to a new address and stops trusting the old one", async () => {
    const dns = fakeDns({ caddy: ["172.18.0.5"] });
    const trusted = proxies("caddy", dns.lookup);
    await trusted.refresh();

    dns.records.caddy = ["172.18.0.9"];
    await trusted.refresh();

    expect(trusted.trusts("172.18.0.5")).toBe(false);
    expect(trusted.trusts("172.18.0.9")).toBe(true);
  });

  it("stops trusting a name that no longer resolves, and keeps the other entries", async () => {
    const dns = fakeDns({ caddy: ["172.18.0.5"] });
    const trusted = proxies("caddy, 10.0.0.1", dns.lookup);
    await trusted.refresh();

    delete dns.records.caddy;
    await trusted.refresh();

    expect(trusted.trusts("172.18.0.5")).toBe(false);
    expect(trusted.trusts("10.0.0.1")).toBe(true);
  });

  it("reads names in any case", async () => {
    const dns = fakeDns({ caddy: ["172.18.0.5"] });
    const trusted = proxies("Caddy", dns.lookup);
    await trusted.refresh();

    expect(trusted.trusts("172.18.0.5")).toBe(true);
  });

  it("logs when a name does not resolve and when it resolves, once per change", async () => {
    const dns = fakeDns({});
    const { logger, logged } = captureLogger();
    const trusted = parseTrustedProxies("caddy", { lookup: dns.lookup, logger });

    await trusted.refresh();
    await trusted.refresh();
    dns.records.caddy = ["172.18.0.5"];
    await trusted.refresh();
    await trusted.refresh();

    expect(logged()).toEqual([
      expect.objectContaining({ level: "warn", name: "caddy" }),
      expect.objectContaining({ level: "info", name: "caddy", addresses: ["172.18.0.5"] }),
    ]);
  });

  it("resolves a name through the system's DNS", async () => {
    const trusted = parseTrustedProxies("localhost", { logger: captureLogger().logger });
    const addresses = (await dnsLookup("localhost", { all: true })).map((entry) => entry.address);
    await trusted.refresh();

    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect(trusted.trusts(address)).toBe(true);
    expect(trusted.trusts("203.0.113.7")).toBe(false);
  });
});

describe("TrustedProxies.clientAddress", () => {
  it("ignores X-Forwarded-For from an untrusted source", () => {
    const trusted = proxies("10.0.0.0/8");

    expect(trusted.clientAddress("203.0.113.9", "198.51.100.1")).toBe("203.0.113.9");
    expect(trusted.clientAddress("203.0.113.9", "garbage")).toBe("203.0.113.9");
  });

  it("uses the source when a trusted proxy sends no X-Forwarded-For", () => {
    expect(proxies("10.0.0.0/8").clientAddress("10.0.0.2", undefined)).toBe("10.0.0.2");
  });

  it("takes the last hop that is not a trusted proxy", () => {
    const trusted = proxies("10.0.0.0/8");

    expect(trusted.clientAddress("10.0.0.2", "203.0.113.7")).toBe("203.0.113.7");
    expect(trusted.clientAddress("10.0.0.2", "198.51.100.1, 203.0.113.7, 10.0.0.9")).toBe(
      "203.0.113.7",
    );
    expect(trusted.clientAddress("::ffff:10.0.0.2", "::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("takes the last hop when every hop is trusted, since a client can write the hops to its left", () => {
    const trusted = proxies("10.0.0.0/8");

    expect(trusted.clientAddress("10.0.0.2", "10.0.0.5, 10.0.0.6")).toBe("10.0.0.6");
    expect(trusted.clientAddress("10.0.0.2", "10.9.9.9, 10.0.0.5, 10.0.0.6")).toBe("10.0.0.6");
  });

  it("with *, takes only the last hop, since a client can write the others", () => {
    expect(proxies("*").clientAddress("10.0.0.2", "198.51.100.1, 203.0.113.7")).toBe("203.0.113.7");
  });

  it.each([
    ["0.0.0.0/0", "10.0.0.2", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["0.0.0.0/0", "10.0.0.2", "2001:db8::6, 203.0.113.7", "203.0.113.7"],
    ["0.0.0.0/0", "10.0.0.2", "spoofed, 203.0.113.7", "203.0.113.7"],
    ["::ffff:0:0/96", "10.0.0.2", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["0.0.0.0/1, 128.0.0.0/1", "10.0.0.2", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["::/0", "2001:db8::2", "2001:db8::6, 2001:db8::7", "2001:db8::7"],
    ["::/0, 10.0.0.2", "10.0.0.2", "6.6.6.6, 10.0.0.2", "10.0.0.2"],
    ["::/1, 8000::/1", "2001:db8::2", "2001:db8::6, 2001:db8::7", "2001:db8::7"],
  ])(
    "with %s, which covers every address, takes only the last hop, as * does",
    (ranges, source, forwardedFor, client) => {
      expect(proxies(ranges).clientAddress(source, forwardedFor)).toBe(client);
    },
  );

  it.each(["garbage", "", "203.0.113.7:51234", "[2001:db8::1]", "203.0.113.7, ", "unknown"])(
    "gives no address when a trusted proxy sends the hop %j",
    (forwardedFor) => {
      expect(proxies("10.0.0.0/8").clientAddress("10.0.0.2", forwardedFor)).toBeUndefined();
    },
  );

  it("gives no address for a source that is not an IP address", () => {
    expect(proxies("*").clientAddress("garbage", undefined)).toBeUndefined();
  });

  it("writes an IPv4-mapped source as IPv4", () => {
    expect(proxies("").clientAddress("::ffff:192.168.1.30", undefined)).toBe("192.168.1.30");
  });
});
