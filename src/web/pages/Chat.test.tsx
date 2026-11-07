import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiBoxNoteView } from "../../server/ai-box-views.ts";
import type { ChatThreadView } from "../../server/chat-views.ts";
import {
  askAboutAlertNote,
  askAboutOf,
  askAboutProposal,
  DROPPED_LINE,
  INPUT_PLACEHOLDER,
  PRIVACY_NOTICE,
  problemOf,
  WAITS_FOR_HISTORY,
} from "../chat.ts";
import { AttachedNote, Chat, Composer, NewThread, ThreadList, ThreadMessages } from "./Chat.tsx";

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

describe("the page", () => {
  it("fills the screen above the phone's tab bar with no fixed overlay, under one hidden <h1>", () => {
    const html = render(<Chat />);
    const main = /<main class="([^"]*)"[^>]*data-slot="chat-page"/.exec(html)?.[1]?.split(" ");

    // One heading, drawn before anything loads, for screen readers and the focus a menu choice
    // moves; as on the board, the open thread's title heads the pane.
    expect([...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((match) => match[0])).toEqual([
      '<h1 class="sr-only">Chat</h1>',
    ]);
    // The page takes back the shell's padding and is the screen's height, less the 59 px tab bar
    // below 900 px; nothing in it is fixed.
    expect(main).toEqual(
      expect.arrayContaining([
        "h-dvh",
        "-mb-24",
        "pb-[calc(59px+env(safe-area-inset-bottom))]",
        "min-[900px]:-mb-12",
        "min-[900px]:pb-0",
      ]),
    );
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/);
  });

  it("keeps the input in view on a short phone screen: the thread list gives up its room", () => {
    const classesOf = (html: string, pattern: RegExp) => (pattern.exec(html)?.[1] ?? "").split(" ");
    const list = classesOf(
      render(<ThreadList threads={[]} open={undefined} today="2026-11-06" zone="UTC" />),
      /<nav aria-label="Chat threads" class="([^"]*)"/,
    );
    const pane = render(<NewThread status="ready" ask={null} onStarted={() => {}} />);

    // The list is at most 160 px tall, and shrinks below that, scrolling inside itself.
    expect(list).toEqual(
      expect.arrayContaining(["max-h-40", "min-h-0", "shrink", "overflow-y-auto"]),
    );
    expect(list).not.toContain("shrink-0");
    // The pane is never shorter than its header and input below 768 px; the messages scroll and
    // do not count toward that.
    expect(classesOf(pane, /<section aria-label="New thread" class="([^"]*)"/)).toEqual(
      expect.arrayContaining(["min-h-min", "md:min-h-0", "flex-1"]),
    );
    expect(classesOf(pane, /class="([^"]*)" data-slot="chat-scroll"/)).toEqual(
      expect.arrayContaining(["overflow-y-auto", "[contain:size]"]),
    );
  });
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

  it("shows each line of the attached note, two that match too, each under its own key", () => {
    const line = "Card interest: $12.50 on Northwind card on Oct 18.";
    const note = { kind: "Alert", title: "2 Card interest or fee charges", lines: [line, line] };

    expect(text(render(<AttachedNote note={note} />))).toBe(
      `Alert: 2 Card interest or fee charges ${line} ${line}`,
    );
    // The server render checks no key, so the keys are read from the elements.
    const [, lines] = (AttachedNote({ note }) as ReactElement<{ children: ReactElement[][] }>).props
      .children;
    const keys = (lines ?? []).map((each) => each.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("lists the threads, the open one marked", () => {
    const html = render(
      <ThreadList
        threads={[
          { id: "t2", title: "Rent question", lastMessageAt: "2026-10-20T17:00:00.000Z" },
          { id: "t1", title: "How are we doing?", lastMessageAt: "2026-10-20T16:00:00.000Z" },
        ]}
        open="t1"
        today="2026-11-03"
        zone="America/New_York"
      />,
    );
    // Each thread shows the day of its last message, in the browser's time zone.
    expect(text(html)).toBe("New thread Rent question Oct 20 How are we doing? Oct 20");
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
