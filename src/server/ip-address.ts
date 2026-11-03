// The one reader and range matcher for IP addresses. It imports nothing from Node, so
// app-url.ts can use it and the web app's type check can still follow api.ts.

export type IpAddress = { readonly family: 4 | 6; readonly bits: bigint };
export type IpRange = { readonly family: 4 | 6; readonly first: bigint; readonly prefix: number };

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const IPV6_CHARACTERS = /^[0-9a-f:.]+$/i;
const MAPPED_HIGH_BITS = 0xffffn; // ::ffff:0:0/96 holds IPv4 written as IPv6.

function ipv4Bits(text: string): bigint | undefined {
  if (!IPV4.test(text)) return undefined;
  return text.split(".").reduce((bits, octet) => (bits << 8n) | BigInt(octet), 0n);
}

// The URL parser checks the IPv6 syntax and writes it in compressed hex.
function ipv6Bits(text: string): bigint | undefined {
  if (!IPV6_CHARACTERS.test(text) || !URL.canParse(`http://[${text}]`)) return undefined;
  const compressed = new URL(`http://[${text}]`).hostname.slice(1, -1);
  const [head = "", tail] = compressed.split("::");
  const pieces = (part: string) => (part === "" ? [] : part.split(":"));
  const front = pieces(head);
  const back = tail === undefined ? [] : pieces(tail);
  const zeros = Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].reduce(
    (bits, piece) => (bits << 16n) | BigInt(Number.parseInt(piece, 16)),
    0n,
  );
}

const isMapped = (bits: bigint) => bits >> 32n === MAPPED_HIGH_BITS;

// Reads a plain IP address: no brackets, port, or zone. IPv4-mapped IPv6 reads as IPv4.
export function parseIp(text: string): IpAddress | undefined {
  const ipv4 = ipv4Bits(text);
  if (ipv4 !== undefined) return { family: 4, bits: ipv4 };
  const ipv6 = ipv6Bits(text);
  if (ipv6 === undefined) return undefined;
  return isMapped(ipv6) ? { family: 4, bits: ipv6 & 0xffffffffn } : { family: 6, bits: ipv6 };
}

export function formatIp({ family, bits }: IpAddress): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => (bits >> shift) & 255n).join(".");
  const pieces = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) =>
    ((bits >> shift) & 0xffffn).toString(16),
  );
  return new URL(`http://[${pieces.join(":")}]`).hostname.slice(1, -1);
}

// Reads "address" or "address/prefix". An IPv6 range inside ::ffff:0:0/96 reads as the IPv4
// range it holds. No other IPv6 range matches an IPv4 address.
export function parseIpRange(text: string): IpRange | undefined {
  const [addressText = "", prefixText, extra] = text.split("/");
  if (extra !== undefined) return undefined;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return undefined;
  const ipv4 = ipv4Bits(addressText);
  const bits = ipv4 ?? ipv6Bits(addressText);
  if (bits === undefined) return undefined;
  const width = ipv4 === undefined ? 128 : 32;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (prefix > width) return undefined;
  if (ipv4 !== undefined) return { family: 4, first: bits, prefix };
  if (prefix >= 96 && isMapped(bits)) {
    return { family: 4, first: bits & 0xffffffffn, prefix: prefix - 96 };
  }
  return { family: 6, first: bits, prefix };
}

export function inIpRange(address: IpAddress, range: IpRange): boolean {
  if (address.family !== range.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - range.prefix);
  return address.bits >> shift === range.first >> shift;
}

// True when the ranges together hold every address of the family, as 0.0.0.0/0 or
// 0.0.0.0/1 with 128.0.0.0/1 do.
export function coversEveryAddress(ranges: readonly IpRange[], family: 4 | 6): boolean {
  const width = family === 4 ? 32 : 128;
  const spans = ranges
    .filter((range) => range.family === family)
    .map((range) => {
      const shift = BigInt(width - range.prefix);
      const first = (range.first >> shift) << shift;
      return { first, end: first + (1n << shift) };
    })
    .sort((a, b) => Number(a.first - b.first));
  let covered = 0n;
  for (const { first, end } of spans) {
    if (first > covered) return false;
    if (end > covered) covered = end;
  }
  return covered === 1n << BigInt(width);
}
