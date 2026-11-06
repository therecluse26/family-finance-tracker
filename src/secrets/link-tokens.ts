import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The tokens in one-use links, such as invite links (spec 09, Invites). A token is 32 random
// bytes from the operating system's secure source, written in base64url, so it fits after "#" in
// a link as it is. The app stores only its SHA-256 hash.

export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: linkTokenHash(token) };
}

export function linkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Whether two stored hashes are the same, compared in constant time.
export function sameLinkTokenHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
