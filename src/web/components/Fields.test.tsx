import { renderToString } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { NewTotp } from "./Fields.tsx";

// A new TOTP secret shows a QR code to scan, the link a phone opens, and the secret to type in
// (spec 09, Signing in). The QR code is drawn on the page, so the secret goes to no outside service.

const TOTP_URI =
  "otpauth://totp/Family%20Finance%20Tracker:member%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Family%20Finance%20Tracker";

describe("a new TOTP secret", () => {
  const html = renderToString(<NewTotp totpURI={TOTP_URI} />);

  it("shows a QR code of the otpauth link, one square for each dark module", () => {
    const squares = encode(TOTP_URI, { border: 4 }).data.flat().filter(Boolean).length;

    expect(html).toContain('aria-label="QR code for your authenticator app"');
    expect(html.match(/h1v1h-1z/g)?.length).toBe(squares);
  });

  it("draws the QR code on the page, with no picture from another site", () => {
    expect(html).not.toMatch(/<img|https?:\/\//);
  });

  it("still gives the link a phone opens and the secret to type in", () => {
    expect(html).toContain(`href="${TOTP_URI.replaceAll("&", "&amp;")}"`);
    expect(html).toContain("JBSWY3DPEHPK3PXP");
  });
});
