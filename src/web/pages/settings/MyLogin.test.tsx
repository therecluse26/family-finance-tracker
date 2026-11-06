import { renderToString } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { ConfirmNewTotp } from "./MyLogin.tsx";

// Settings, My login after "Set up a new TOTP": the new TOTP as a QR code drawn on the page, and the
// field for its first code (spec 09, Members). src/web/components/Fields.test.tsx checks the drawing.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// A made-up TOTP secret, new on each run, in an otpauth:// link of the form Better Auth makes.
function madeUpTotp() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (byte) => BASE32[byte % 32]).join("");
  const totpURI = `otpauth://totp/Family%20Finance%20Tracker:member%40example.test?secret=${secret}&issuer=Family+Finance+Tracker&digits=6&period=30`;
  return { secret, totpURI };
}

describe("Settings, My login, the new TOTP step", () => {
  it("shows the QR code of the new otpauth link, the secret, and the field for its first code", () => {
    const { secret, totpURI } = madeUpTotp();
    const html = renderToString(
      <ConfirmNewTotp
        totpURI={totpURI}
        code=""
        onCodeChange={() => {}}
        busy={false}
        onSubmit={() => {}}
      />,
    );
    const { size, data } = encode(totpURI, { border: 4 });

    expect(html).toContain('role="img" aria-label="QR code for your authenticator app"');
    expect(html).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(html.match(/h1v1h-1z/g)?.length).toBe(data.flat().filter(Boolean).length);
    expect(html).toContain(secret);
    expect(html).toContain("The 6-digit code the new TOTP shows");
    expect(html).toContain("Use the new TOTP");
    expect(html).not.toMatch(/<img|https?:\/\//);
  });
});
