import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertsStepView,
  FinishStepView,
  finishLines,
  finishWizard,
  HOME_SCREEN_NOTE,
  needsHomeScreen,
  PushPart,
  StepButtons,
  StepScreen,
  skipStep,
} from "./SetupSteps.tsx";
import { PLAIN_HTTP_NOTE } from "./settings/AlertPush.tsx";

// The first-run wizard's steps 5 to 9, as the browser first paints them (spec 12, The first-run
// wizard). What makes each step done is checked through the app's HTTP interface, in
// src/server/setup-steps-api.test.ts.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const HTTPS_PUSH = { available: true, publicKey: "BPublicKeyForTheTest" } as const;
const PLAIN_HTTP = { available: false, why: "plain HTTP" } as const;
const TURN_ON = "Turn on Alerts on this device";

describe("step 5, Banks", () => {
  it("offers the Plaid keys and every way to add a bank or an Account, with no sandbox dry run", () => {
    const html = renderToString(<StepScreen step="banks" />);

    expect(text(html)).toContain("Enter the Plaid keys, then connect your banks.");
    expect(text(html)).toContain("Unconnected account");
    expect(text(html)).toContain("Manual loan");
    expect(text(html)).not.toMatch(/sandbox|dry run/i);
  });
});

describe("step 6, AI", () => {
  it("shows the fixed estimate for the first AI run on all history", () => {
    expect(text(renderToString(<StepScreen step="ai" />))).toContain(
      "The first AI run on all history costs about $0.20. It counts against the AI cost cap.",
    );
  });
});

describe("step 7, Alerts", () => {
  it("asks for the SMTP server, then offers Send a test email", () => {
    const html = renderToString(
      <AlertsStepView
        smtp={null}
        push={HTTPS_PUSH}
        homeScreenFirst={false}
        onSmtpSaved={() => {}}
      />,
    );

    for (const label of ["Host", "Port", "Sign-in name", "Password", "Sender address"]) {
      expect(text(html)).toContain(label);
    }
    expect(text(html)).toContain("Send a test email");
    expect(text(html)).toContain("The step is done once a test email goes out.");
    expect(text(html).indexOf("Send a test email")).toBeLessThan(text(html).indexOf(TURN_ON));
  });

  it("hides push in plain-HTTP mode, and says why", () => {
    for (const homeScreenFirst of [false, true]) {
      const html = text(
        renderToString(<PushPart push={PLAIN_HTTP} homeScreenFirst={homeScreenFirst} />),
      );
      expect(html).toContain(PLAIN_HTTP_NOTE);
      expect(html).not.toContain(TURN_ON);
      expect(html).not.toContain("Add to Home Screen");
    }
  });

  it("offers push on this device over HTTPS", () => {
    const html = text(renderToString(<PushPart push={HTTPS_PUSH} homeScreenFirst={false} />));

    expect(html).toContain(TURN_ON);
    expect(html).not.toContain(PLAIN_HTTP_NOTE);
    expect(html).not.toContain("Add to Home Screen");
  });

  it("explains Add to Home Screen first on an iPhone", () => {
    const html = text(renderToString(<PushPart push={HTTPS_PUSH} homeScreenFirst={true} />));

    expect(html).toContain(HOME_SCREEN_NOTE);
    expect(html.indexOf("Add to Home Screen")).toBeLessThan(html.indexOf(TURN_ON));
  });

  it("knows an iPhone outside the installed app", () => {
    expect(needsHomeScreen(IPHONE, false)).toBe(true);
    // The app opened from the Home Screen gets pushes already.
    expect(needsHomeScreen(IPHONE, true)).toBe(false);
    expect(needsHomeScreen(ANDROID, false)).toBe(false);
    expect(needsHomeScreen(IPAD, false)).toBe(false);
  });
});

describe("step 8, Invite Members", () => {
  it("makes invite links", () => {
    expect(text(renderToString(<StepScreen step="invite members" />))).toContain(
      "Make an invite link",
    );
  });
});

describe("Next and Skip", () => {
  it("shows both, with why Next did not go on", () => {
    const html = text(
      renderToString(
        <StepButtons
          busy={false}
          notDone="Make an invite link first, or skip this step."
          error={undefined}
          onNext={() => {}}
          onSkip={() => {}}
        />,
      ),
    );

    expect(html).toBe("Next Skip Make an invite link first, or skip this step.");
  });
});

describe("step 9, Finish", () => {
  it("says that history is loading, and that the dashboard shows it per Connection", () => {
    expect(finishLines(2)).toEqual([
      "Your banks' history is loading. It can take a few hours.",
      "The dashboard shows the progress for each Connection.",
    ]);
  });

  it("says when there is no Connection, and points to the Finish setup list", () => {
    const html = text(
      renderToString(
        <FinishStepView connections={0} busy={false} error={undefined} onOpen={() => {}} />,
      ),
    );

    expect(html).toContain("The Household has no Connection yet, so no bank history is loading.");
    expect(html).toContain("waits in the &quot;Finish setup&quot; list on the dashboard");
    expect(html).toContain("Open the dashboard");
  });
});

// The server answers 415 to a write without a JSON body, so each write the page makes must send
// one. src/server/setup-steps-api.test.ts sends these same requests.
describe("the requests the wizard sends", () => {
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

  it("sends an empty JSON body with Skip and with Open the dashboard", async () => {
    expect(await sent(() => skipStep("invite members"))).toEqual([
      {
        method: "POST",
        path: "/api/setup/steps/invite%20members/skip",
        type: "application/json",
        body: "{}",
      },
    ]);
    expect(await sent(finishWizard)).toEqual([
      { method: "POST", path: "/api/setup/finish", type: "application/json", body: "{}" },
    ]);
  });
});
