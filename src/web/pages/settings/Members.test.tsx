import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InviteView, MemberView } from "../../../server/members-views.ts";
import {
  cancelInviteLink,
  MembersLists,
  makeInviteLink,
  removeMemberWithCode,
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
    expect(html).toContain("Make an invite link");
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
    expect(await sent(makeInviteLink)).toEqual([
      { method: "POST", path: "/api/invites", type: "application/json", body: "{}" },
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

  it("Remove sends the code as JSON for its Member", async () => {
    expect(await sent(() => removeMemberWithCode("member-2", "123456"))).toEqual([
      {
        method: "POST",
        path: "/api/members/member-2/remove",
        type: "application/json",
        body: '{"code":"123456"}',
      },
    ]);
  });
});
