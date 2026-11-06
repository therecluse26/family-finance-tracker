import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiBoxInsightCardView, AiBoxNoteView } from "../../server/ai-box-views.ts";
import type { ChatThreadView } from "../../server/chat-views.ts";
import {
  askAboutAlertNote,
  askAboutInsightCard,
  askAboutOf,
  askAboutProposal,
  DROPPED_LINE,
  INPUT_PLACEHOLDER,
  PRIVACY_NOTICE,
  problemOf,
  WAITS_FOR_HISTORY,
} from "../chat.ts";
import { Composer, NewThread, ThreadList, ThreadMessages } from "./Chat.tsx";

// The Chat page's parts as the browser first paints them (spec 07, Chat page). The requests go
// through the app in src/server/chat-api.test.ts.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// A part inside a router, as the page holds it.
const render = (element: ReactElement) =>
  renderToString(
    <RouterProvider
      router={createMemoryRouter([{ path: "*", element }], { initialEntries: ["/chat"] })}
    />,
  );

const message = (id: string, author: "Member" | "AI", name: string, words: string) => ({
  id,
  author,
  name,
  text: words,
  createdAt: "2026-10-20T16:00:00.000Z",
});

const thread = (fields: Partial<ChatThreadView> = {}): ChatThreadView => ({
  id: "t1",
  title: "How are we doing?",
  note: null,
  messages: [
    message("q1", "Member", "Alice", "How are we doing?"),
    message("a1", "AI", "AI", "You are **$120** under Budget."),
    message("q2", "Member", "Bob", "And Groceries?"),
  ],
  firstSent: null,
  answering: false,
  proposals: [],
  you: "Alice",
  ...fields,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ask about this", () => {
  const note = { id: "n1", title: "Restaurants is over Budget for Oct 2026" } as AiBoxNoteView;

  it("opens a new thread with the note attached and the drafted question, and sends nothing before Send", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const ask = askAboutOf(askAboutAlertNote(note));

    const html = render(<NewThread status="ready" ask={ask} onStarted={() => {}} />);

    expect(text(html)).toContain("Alert note: Restaurants is over Budget for Oct 2026");
    expect(html).toContain(
      ">Tell me more about this: Restaurants is over Budget for Oct 2026</textarea>",
    );
    expect(html).not.toContain(`disabled=""`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens a new thread with an Insight card attached, as for an Alert note", () => {
    const card = { id: "c1", title: "Delivery fees add up" } as AiBoxInsightCardView;
    const ask = askAboutOf(askAboutInsightCard(card));
    expect(ask).toEqual({ kind: "Insight card", id: "c1", title: "Delivery fees add up" });

    const html = render(<NewThread status="ready" ask={ask} onStarted={() => {}} />);

    expect(text(html)).toContain("Insight card: Delivery fees add up");
    expect(html).toContain(">Tell me more about this: Delivery fees add up</textarea>");
  });

  it("names a Proposal by its changes, and reads only a note it knows from the page's state", () => {
    expect(
      askAboutProposal({
        id: "p1",
        changes: ["Restaurants Budget: $600 → $480"],
      } as Parameters<typeof askAboutProposal>[0]),
    ).toEqual({ kind: "Proposal", id: "p1", title: "Restaurants Budget: $600 → $480" });
    expect(askAboutOf(null)).toBeNull();
    expect(askAboutOf({ answer: true })).toBeNull();
    expect(askAboutOf({ kind: "Transaction", id: "x", title: "y" })).toBeNull();
    expect(askAboutOf({ kind: "Alert note", id: 1, title: "y" })).toBeNull();
  });
});

describe("a thread", () => {
  it("shows who wrote each message, bolds key numbers, and marks the turns no longer sent", () => {
    const html = render(
      <ThreadMessages thread={thread({ firstSent: "a1" })} onChanged={() => {}} onAsk={() => {}} />,
    );

    expect(text(html)).toBe(
      `Alice How are we doing? ${DROPPED_LINE} AI You are $120 under Budget. Bob And Groceries?`,
    );
    expect(html).toContain("<strong>$120</strong>");
    expect(
      text(render(<ThreadMessages thread={thread()} onChanged={() => {}} onAsk={() => {}} />)),
    ).not.toContain(DROPPED_LINE);
  });

  it("shows the answer as it streams", () => {
    const html = render(
      <ThreadMessages
        thread={thread()}
        live={{ answer: "Groceries are at **$310**" }}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(text(html)).toMatch(/Bob And Groceries\? AI Groceries are at \$310$/u);

    // The new question shows under the signed-in Member's name until the thread reloads.
    const asked = render(
      <ThreadMessages
        thread={thread()}
        live={{ question: "And Dining?", answer: "" }}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(text(asked)).toMatch(/Bob And Groceries\? Alice And Dining\? AI …$/u);
  });

  it("breaks a long word in a message inside the page", () => {
    const word = "x".repeat(90);
    const html = render(
      <ThreadMessages
        thread={thread({ messages: [message("q1", "Member", "Alice", word)] })}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    expect(html).toMatch(/<p class="[^"]*\bwrap-anywhere\b[^"]*">x{90}<\/p>/u);
  });

  it("lists the threads, the open one marked", () => {
    const html = render(
      <ThreadList
        threads={[
          { id: "t2", title: "Rent question", lastMessageAt: "2026-10-20T17:00:00.000Z" },
          { id: "t1", title: "How are we doing?", lastMessageAt: "2026-10-20T16:00:00.000Z" },
        ]}
        open="t1"
      />,
    );
    expect(text(html)).toBe("New thread Rent question How are we doing?");
    expect(html).toContain('aria-current="page" class="block truncate');
  });
});

describe("the input", () => {
  it("shows the privacy notice and the placeholder", () => {
    const html = render(
      <Composer status="ready" draft="" onDraft={() => {}} busy={false} onSend={() => {}} />,
    );
    expect(text(html)).toContain(PRIVACY_NOTICE);
    expect(html).toContain(`placeholder="${INPUT_PLACEHOLDER}"`);
    expect(html).not.toContain(`disabled=""`);
  });

  it("waits until history has loaded", () => {
    const html = render(
      <Composer
        status="waits for history"
        draft=""
        onDraft={() => {}}
        busy={false}
        onSend={() => {}}
      />,
    );
    expect(text(html)).toContain(WAITS_FOR_HISTORY);
    expect(html).toContain(`disabled=""`);
  });

  it('reads a refusal, and "Send anyway?" from the route or a failed answer', () => {
    expect(problemOf(JSON.stringify({ error: "Send anyway?", pause: "send anyway?" }))).toEqual({
      error: "Send anyway?",
      sendAnyway: true,
      notStored: true,
    });
    expect(problemOf("Chat reached the AI cost cap. Send anyway?")).toEqual({
      error: "Chat reached the AI cost cap. Send anyway?",
      sendAnyway: true,
      notStored: false,
    });
    expect(problemOf("The AI provider did not answer.")).toEqual({
      error: "The AI provider did not answer.",
      sendAnyway: false,
      notStored: false,
    });
  });
});
