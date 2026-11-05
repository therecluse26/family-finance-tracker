import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelsForm,
  SmtpForm,
  saveChannels,
  saveSmtp,
  sendTestEmail,
  TestEmailButton,
} from "./AlertEmail.tsx";

// Settings, Alerts: channels and the email server, as the browser first paints them.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const checked = (html: string) =>
  [...html.matchAll(/<label[^>]*><input type="radio"[^>]*?( checked="")?\/>([^<]+)/g)]
    .filter((match) => match[1] !== undefined)
    .map((match) => match[2]);

describe("Settings, Alerts: channels", () => {
  it("shows the Member's pick of push, email, both, or none", () => {
    const paint = (push: boolean, email: boolean) =>
      renderToString(
        <ChannelsForm channels={{ push, email, emailSetUp: true }} onSaved={() => {}} />,
      );

    expect(checked(paint(true, true))).toEqual(["Push and email"]);
    expect(checked(paint(true, false))).toEqual(["Push only"]);
    expect(checked(paint(false, true))).toEqual(["Email only"]);
    expect(checked(paint(false, false))).toEqual(["None"]);
    expect(text(paint(true, true))).toContain("Email goes out at once, even in quiet hours.");
    expect(text(paint(true, true))).not.toContain("skips email");
  });

  it("says email is skipped while no SMTP server is saved", () => {
    const html = renderToString(
      <ChannelsForm channels={{ push: true, email: true, emailSetUp: false }} onSaved={() => {}} />,
    );

    expect(text(html)).toContain("No SMTP server is saved, so the app skips email until one is.");
  });
});

describe("Settings, Alerts: the email server", () => {
  it("asks for every field the first time, the password included", () => {
    const html = renderToString(<SmtpForm smtp={null} onSaved={() => {}} />);

    for (const label of ["Host", "Port", "Sign-in name", "Password", "Sender address"]) {
      expect(text(html)).toContain(label);
    }
    expect(html).toContain('value="587"');
    expect(html).toMatch(/type="password"[^>]*placeholder="Not saved"[^>]*required=""/);
    expect(text(html)).toContain("to set or change the password");
  });

  it("shows a saved server, but never its password", () => {
    const html = renderToString(
      <SmtpForm
        smtp={{
          host: "smtp.example.test",
          port: 465,
          username: "household@example.test",
          sender: "alerts@example.test",
        }}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain('value="smtp.example.test"');
    expect(html).toContain('value="465"');
    expect(html).toContain('value="household@example.test"');
    expect(html).toContain('value="alerts@example.test"');
    expect(html).toMatch(
      /type="password"[^>]*placeholder="Saved. Enter a new password to change it."[^>]*value=""/,
    );
  });

  it("offers a test email to the Member's own address", () => {
    const html = renderToString(<TestEmailButton />);

    expect(text(html)).toContain("Send a test email");
    expect(text(html)).toContain("It goes to your own email address.");
  });
});

// Every write under /api/smtp/ and /api/alert-channels answers 415 without a JSON content type, so
// each write the page makes must send one. src/notify/email.test.ts sends these same requests.
describe("Settings, Alerts: the requests the page sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sent(write: () => Promise<unknown>) {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    await write();
    return requests;
  }

  it("sends a JSON body with each write, the test email's empty", async () => {
    expect(await sent(sendTestEmail)).toEqual([
      { method: "POST", path: "/api/smtp/test", type: "application/json", body: "{}" },
    ]);
    expect(await sent(() => saveChannels({ push: true, email: false }))).toEqual([
      {
        method: "PUT",
        path: "/api/alert-channels",
        type: "application/json",
        body: JSON.stringify({ push: true, email: false }),
      },
    ]);
    const server = {
      host: "smtp.example.test",
      port: 587,
      username: "household@example.test",
      sender: "alerts@example.test",
    };
    expect(await sent(() => saveSmtp(server))).toEqual([
      {
        method: "POST",
        path: "/api/smtp/settings",
        type: "application/json",
        body: JSON.stringify(server),
      },
    ]);
  });
});
