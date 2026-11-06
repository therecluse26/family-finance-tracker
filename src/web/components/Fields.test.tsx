import { renderToString } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { NewTotp } from "./Fields.tsx";

// A new TOTP secret shows a QR code to scan, the link a phone opens, and the secret to type in
// (spec 09, Signing in). The QR code is drawn on the page, so the secret goes to no outside service.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// A made-up TOTP secret, new on each run, in an otpauth:// link of the form Better Auth makes.
function madeUpTotp() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (byte) => BASE32[byte % 32]).join("");
  const totpURI = `otpauth://totp/Family%20Finance%20Tracker:member%40example.test?secret=${secret}&issuer=Family+Finance+Tracker&digits=6&period=30`;
  return { secret, totpURI };
}

// The QR code as drawn: the viewBox, the width and height, and the set of "x,y" squares in the path.
function drawnQrCode(html: string) {
  const svg = html.match(
    /<svg role="img" aria-label="QR code for your authenticator app" viewBox="([^"]*)" width="(\d+)" height="(\d+)"[^>]*><path d="([^"]*)"/,
  );
  if (!svg) throw new Error("no QR code");
  const [, viewBox, width, height, d] = svg as unknown as [string, string, string, string, string];
  const squares = [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)];
  // The path holds these squares and nothing else.
  expect(squares.map((square) => square[0]).join("")).toBe(d);
  return {
    viewBox,
    width: Number(width),
    height: Number(height),
    squares: new Set(squares.map(([, x, y]) => `${x},${y}`)),
  };
}

// The dark modules of the real QR encoding, with its 4-module quiet zone, as "x,y".
function darkModules(qr: ReturnType<typeof encode>) {
  return new Set(
    qr.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`${x},${y}`] : []))),
  );
}

describe("a new TOTP secret", () => {
  const { secret, totpURI } = madeUpTotp();
  const html = renderToString(<NewTotp totpURI={totpURI} />);
  const qr = encode(totpURI, { border: 4 });

  it("draws each dark module of the otpauth link's QR code in its own place", () => {
    const drawn = drawnQrCode(html);

    expect(drawn.squares.size).toBeGreaterThan(0);
    expect(drawn.squares).toEqual(darkModules(qr));
  });

  it("keeps a white quiet zone of 4 modules on every side", () => {
    const { size } = qr;
    const drawn = drawnQrCode(html);

    expect(size).toBe(4 * qr.version + 17 + 8);
    expect(drawn.viewBox).toBe(`0 0 ${size} ${size}`);
    const inBorder = [...drawn.squares].filter((square) => {
      const [x, y] = square.split(",").map(Number) as [number, number];
      return x < 4 || y < 4 || x >= size - 4 || y >= size - 4;
    });
    expect(inBorder).toEqual([]);
    expect(html).toContain('class="mt-2 h-auto max-w-full bg-white"');
    expect(html).toContain('fill="#000"');
  });

  it("puts the three finder patterns in the top left, top right and bottom left", () => {
    const drawn = drawnQrCode(html);
    const finderAt = (left: number, top: number) =>
      [0, 6].every(
        (edge) =>
          [0, 1, 2, 3, 4, 5, 6].every(
            (i) =>
              drawn.squares.has(`${left + i},${top + edge}`) &&
              drawn.squares.has(`${left + edge},${top + i}`),
          ) && drawn.squares.has(`${left + 3},${top + 3}`),
      );
    const far = qr.size - 11;

    expect([finderAt(4, 4), finderAt(far, 4), finderAt(4, far), finderAt(far, far)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("draws each module 4 CSS px wide, so a camera reads it from a 1x screen", () => {
    const drawn = drawnQrCode(html);

    expect(drawn.width).toBe(4 * qr.size);
    expect(drawn.height).toBe(4 * qr.size);
  });

  it("draws the QR code on the page, with no picture from another site", () => {
    expect(html).not.toMatch(/<img|https?:\/\//);
  });

  it("still gives the link a phone opens and the secret to type in", () => {
    expect(html).toContain(`href="${totpURI.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(secret);
  });
});
