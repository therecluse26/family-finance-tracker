import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InviteView, MemberView } from "../../../server/members-views.ts";
import {
  cancelInviteLink,
  MembersLists,
  makeInviteLink,
  removeMember,
  resetMemberLogin,
} from "./Members.tsx";

// Settings, Members as the browser first paints it, and the exact request each button sends.
// src/server/members-api.test.ts sends these same requests.

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

const ALICE: MemberView = {
  id: "member-1",
  name: "Alice",
  email: "alice@example.com",
  joinedAt: "2026-11-01T12:00:00.000Z",
  you: true,
};
const BOB: MemberView = {
  ...ALICE,
  id: "member-2",
  name: "Bob",
  email: "bob@example.com",
  you: false,
};
const INVITE: InviteView = {
  id: "invite-1",
  madeBy: "Alice",
  createdAt: "2026-11-05T12:00:00.000Z",
  expiresAt: "2026-11-12T12:00:00.000Z",
};

const lists = (members: MemberView[], invites: InviteView[]) =>
  text(
    renderToString(
      <MembersLists members={members} invites={invites} onChange={() => {}} onRemoved={() => {}} />,
    ),
  );

describe("Settings, Members", () => {
  it("lists every Member with Remove, and the open invite links with Cancel", () => {
    const html = lists([ALICE, BOB], [INVITE]);

    expect(html).toContain("Alice (you)");
    expect(html).toContain("bob@example.com");
    expect(html.match(/Remove/g)).toHaveLength(2);
    // On every other Member, not on the Member signed in.
    expect(html.match(/Reset login/g)).toHaveLength(1);
    expect(html.indexOf("Reset login")).toBeGreaterThan(html.indexOf("bob@example.com"));
    expect(html).toContain("Make an invite link");
    expect(html).not.toContain("code from your authenticator app");
    expect(html).toContain("It sends no email.");
    expect(html).toMatch(/Made Nov \d{1,2} by Alice\. Works until Nov \d{1,2}\./);
    expect(html).toContain("Cancel");
    expect(html).not.toContain("cannot remove the last Member");
  });

  it("says when no link is open, and that the last Member stays", () => {
    const html = lists([ALICE], []);

    expect(html).toContain("No open invite links.");
    expect(html).toContain("The app cannot remove the last Member.");
    expect(html).not.toContain("Cancel");
  });

  it("turns Remove off on the last Member, with the reason as text it points to", () => {
    const render = (members: MemberView[]) =>
      renderToString(
        <MembersLists members={members} invites={[]} onChange={() => {}} onRemoved={() => {}} />,
      );
    const removeButtons = (html: string) =>
      [...html.matchAll(/<button([^>]*)>Remove<\/button>/g)].map((match) => match[1] ?? "");

    const alone = removeButtons(render([ALICE]));
    expect(alone).toHaveLength(1);
    expect(alone[0]).toContain('disabled=""');
    expect(alone[0]).toContain('aria-describedby="last-member-note"');
    expect(render([ALICE])).toMatch(
      /<p id="last-member-note"[^>]*>The app cannot remove the last Member\.<\/p>/,
    );

    for (const attributes of removeButtons(render([ALICE, BOB]))) {
      expect(attributes).not.toContain('disabled=""');
      expect(attributes).not.toContain("aria-describedby");
    }
  });
});

// The routes answer 415 without a JSON content type, so each button sends a JSON body.
describe("Settings, Members: the request each button sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sent(request: () => Promise<unknown>) {
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
    await request();
    return requests;
  }

  it("Make an invite link sends an empty JSON body", async () => {
    expect(await sent(() => makeInviteLink())).toEqual([
      {
        method: "POST",
        path: "/api/invites",
        type: "application/json",
        body: "{}",
      },
    ]);
  });

  it("Cancel sends an empty JSON body for its link", async () => {
    expect(await sent(() => cancelInviteLink("invite-1"))).toEqual([
      {
        method: "POST",
        path: "/api/invites/invite-1/cancel",
        type: "application/json",
        body: "{}",
      },
    ]);
  });

  it("Remove sends an empty JSON body for its Member", async () => {
    expect(await sent(() => removeMember("member-2"))).toEqual([
      {
        method: "POST",
        path: "/api/members/member-2/remove",
        type: "application/json",
        body: "{}",
      },
    ]);
  });

  it("Reset login sends an empty JSON body for its Member", async () => {
    expect(await sent(() => resetMemberLogin("member-2"))).toEqual([
      {
        method: "POST",
        path: "/api/members/member-2/reset-login",
        type: "application/json",
        body: "{}",
      },
    ]);
  });
});
