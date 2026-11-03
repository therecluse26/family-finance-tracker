import { describe, expect, it } from "vitest";
import { coversEveryAddress, formatIp, inIpRange, parseIp, parseIpRange } from "./ip-address.ts";

const spelled = (text: string) => {
  const address = parseIp(text);
  return address === undefined ? undefined : formatIp(address);
};

function inRange(address: string, range: string): boolean {
  const parsedAddress = parseIp(address);
  const parsedRange = parseIpRange(range);
  if (parsedAddress === undefined || parsedRange === undefined) throw new Error("Bad test input");
  return inIpRange(parsedAddress, parsedRange);
}

describe("parseIp and formatIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["0.0.0.0", "0.0.0.0"],
    ["255.255.255.255", "255.255.255.255"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:CB00:7107", "203.0.113.7"],
    ["FD00:0:0::1", "fd00::1"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["::", "::"],
    ["fe80::1", "fe80::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
  ])("writes %s as %s", (text, expected) => {
    expect(spelled(text)).toBe(expected);
  });

  it.each([
    "",
    "garbage",
    "203.0.113.7:443",
    "203.0.113",
    "203.0.113.256",
    "010.0.0.1",
    "0x7f.0.0.1",
    " 1.2.3.4",
    "[::1]",
    "fe80::1%eth0",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "::1]@evil.example/[",
    "fd00::1/64",
  ])("refuses %j", (text) => {
    expect(parseIp(text)).toBeUndefined();
  });
});

describe("parseIpRange", () => {
  it.each([
    ["10.0.0.0/8", { family: 4, prefix: 8 }],
    ["10.0.0.1", { family: 4, prefix: 32 }],
    ["fd00::/8", { family: 6, prefix: 8 }],
    ["::1", { family: 6, prefix: 128 }],
    ["::/0", { family: 6, prefix: 0 }],
    ["::ffff:10.0.0.0/104", { family: 4, prefix: 8 }],
    ["::ffff:0:0/96", { family: 4, prefix: 0 }],
    ["::ffff:0:0/95", { family: 6, prefix: 95 }],
  ])("reads %s", (text, expected) => {
    expect(parseIpRange(text)).toMatchObject(expected);
  });

  it.each([
    "10.0.0.0/33",
    "::/129",
    "10.0.0.0/",
    "/8",
    "10.0.0.0/8/8",
    "10.0.0.0/-1",
    "10.0.0.0/8x",
  ])("refuses %j", (text) => {
    expect(parseIpRange(text)).toBeUndefined();
  });
});

describe("inIpRange", () => {
  it("matches the first and last address of a range, and nothing next to it", () => {
    expect(inRange("172.16.0.0", "172.16.0.0/12")).toBe(true);
    expect(inRange("172.31.255.255", "172.16.0.0/12")).toBe(true);
    expect(inRange("172.15.255.255", "172.16.0.0/12")).toBe(false);
    expect(inRange("172.32.0.0", "172.16.0.0/12")).toBe(false);
    expect(inRange("fdff::1", "fc00::/7")).toBe(true);
    expect(inRange("fe00::1", "fc00::/7")).toBe(false);
  });

  it("matches an IPv4 address only through an IPv4 or IPv4-mapped range", () => {
    expect(inRange("127.0.0.2", "::/0")).toBe(false);
    expect(inRange("::ffff:127.0.0.2", "::/0")).toBe(false);
    expect(inRange("127.0.0.2", "::ffff:0:0/95")).toBe(false);
    expect(inRange("127.0.0.2", "::ffff:0:0/96")).toBe(true);
    expect(inRange("127.0.0.2", "::ffff:127.0.0.0/104")).toBe(true);
    expect(inRange("127.0.0.2", "0.0.0.0/0")).toBe(true);
  });

  it("matches no IPv6 address through an IPv4 range", () => {
    expect(inRange("::1", "0.0.0.0/0")).toBe(false);
    expect(inRange("2001:db8::1", "::ffff:0:0/96")).toBe(false);
  });
});

describe("coversEveryAddress", () => {
  const covers = (list: string[], family: 4 | 6) =>
    coversEveryAddress(
      list.map((text) => {
        const range = parseIpRange(text);
        if (range === undefined) throw new Error("Bad test input");
        return range;
      }),
      family,
    );

  it.each<[string[], 4 | 6]>([
    [["0.0.0.0/0"], 4],
    [["::ffff:0:0/96"], 4],
    [["0.0.0.0/1", "128.0.0.0/1"], 4],
    [["128.0.0.0/1", "10.0.0.0/8", "0.0.0.0/1"], 4],
    [["0.0.0.0/1", "128.0.0.1/1"], 4],
    [["::/0"], 6],
    [["::/1", "8000::/1"], 6],
  ])("finds that %j holds every IPv%i address", (list, family) => {
    expect(covers(list, family)).toBe(true);
  });

  it.each<[string[], 4 | 6]>([
    [[], 4],
    [["0.0.0.0/1"], 4],
    [["0.0.0.0/1", "128.0.0.0/2", "192.0.0.0/3"], 4],
    [["10.0.0.0/8"], 4],
    [["::/0"], 4],
    [["0.0.0.0/0"], 6],
    [["::ffff:0:0/96"], 6],
    [["::/1", "8000::/2"], 6],
  ])("finds that %j leaves out some IPv%i address", (list, family) => {
    expect(covers(list, family)).toBe(false);
  });
});
