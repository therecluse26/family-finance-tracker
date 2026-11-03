import { lookup as dnsLookup } from "node:dns/promises";
import { type Logger, log } from "../log.ts";
import {
  coversEveryAddress,
  formatIp,
  type IpAddress,
  type IpRange,
  inIpRange,
  parseIp,
  parseIpRange,
} from "./ip-address.ts";

// Resolves a service name to its IP addresses.
export type Lookup = (name: string) => Promise<string[]>;

export type TrustedProxies = {
  // The TRUSTED_PROXIES entries as written. Empty means no source is trusted.
  readonly entries: readonly string[];
  // True when the listed ranges together hold every IPv4 or every IPv6 address, so they trust
  // every source of that family, as * does.
  readonly coversEveryAddress: boolean;
  trusts(address: string): boolean;
  // The client's address: the source, or the hop a trusted proxy names in forwardedFor.
  // Undefined when the source, or a hop a trusted proxy names, is not an IP address.
  clientAddress(source: string, forwardedFor: string | undefined): string | undefined;
  // Resolves every service name again. Until a name resolves, it trusts no source.
  refresh(): Promise<void>;
};

const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/;
const ALL_DIGITS_AND_DOTS = /^[\d.]+$/;

const systemLookup: Lookup = async (name) =>
  (await dnsLookup(name, { all: true, verbatim: true })).map((entry) => entry.address);

const onlyAddress = ({ family, bits }: IpAddress): IpRange => ({
  family,
  first: bits,
  prefix: family === 4 ? 32 : 128,
});

function isServiceName(entry: string): boolean {
  return SERVICE_NAME.test(entry) && !ALL_DIGITS_AND_DOTS.test(entry);
}

// Reads TRUSTED_PROXIES: IP addresses, CIDR ranges, service names, and "*", separated by
// commas. Throws on an entry that is none of these.
export function parseTrustedProxies(
  value: string | undefined,
  options: { lookup?: Lookup; logger?: Logger } = {},
): TrustedProxies {
  const lookup = options.lookup ?? systemLookup;
  const logger = options.logger ?? log;
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const everySource = entries.includes("*");
  const listed: IpRange[] = [];
  const names: string[] = [];
  for (const entry of entries) {
    if (entry === "*") continue;
    const range = parseIpRange(entry);
    if (range !== undefined) listed.push(range);
    else if (isServiceName(entry.toLowerCase())) names.push(entry.toLowerCase());
    else {
      throw new Error(
        `TRUSTED_PROXIES holds "${entry}", which is not an IP address, a CIDR range, a service name, or *.`,
      );
    }
  }

  let ranges = listed;
  let refreshing: Promise<void> | undefined;
  const lastResolved = new Map<string, string>();

  const resolve = async (name: string): Promise<IpAddress[]> => {
    try {
      return (await lookup(name)).map(parseIp).filter((address) => address !== undefined);
    } catch {
      return [];
    }
  };

  const resolveAll = async () => {
    const results = await Promise.all(
      names.map(async (name) => ({ name, found: await resolve(name) })),
    );
    for (const { name, found } of results) {
      const addresses = found.map(formatIp).sort();
      if (lastResolved.get(name) === addresses.join(",")) continue;
      lastResolved.set(name, addresses.join(","));
      if (addresses.length === 0) {
        logger.warn("A TRUSTED_PROXIES name does not resolve, so the app does not trust it", {
          name,
        });
      } else {
        logger.info("A TRUSTED_PROXIES name resolves", { name, addresses });
      }
    }
    ranges = [...listed, ...results.flatMap(({ found }) => found.map(onlyAddress))];
  };

  const trusted = (address: IpAddress) =>
    everySource || ranges.some((range) => inIpRange(address, range));
  const coversEvery = coversEveryAddress(listed, 4) || coversEveryAddress(listed, 6);
  // With "*", or ranges that hold every address, only the last hop was written by a proxy the
  // app knows. A client can write any hop to its left.
  const lastHopOnly = everySource || coversEvery;

  return {
    entries,
    coversEveryAddress: coversEvery,
    trusts(text) {
      const address = parseIp(text);
      return address !== undefined && trusted(address);
    },
    clientAddress(source, forwardedFor) {
      const sourceAddress = parseIp(source);
      if (sourceAddress === undefined) return undefined;
      if (forwardedFor === undefined || !trusted(sourceAddress)) return formatIp(sourceAddress);
      const hops = forwardedFor.split(",").map((hop) => hop.trim());
      let lastHop: IpAddress | undefined;
      for (const hop of (lastHopOnly ? hops.slice(-1) : hops).reverse()) {
        const address = parseIp(hop);
        if (address === undefined) return undefined;
        if (!trusted(address)) return formatIp(address);
        lastHop ??= address;
      }
      // Every hop is trusted, so a client could have written any hop left of the last one.
      return formatIp(lastHop ?? sourceAddress);
    },
    refresh() {
      if (names.length === 0) return Promise.resolve();
      refreshing ??= resolveAll().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
}
